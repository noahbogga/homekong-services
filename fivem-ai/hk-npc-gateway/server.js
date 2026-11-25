'use strict';

// hk-npc-gateway — .247 gateway for FiveM NPC dialog AI.
// FiveM (fxmain) -> this gateway -> .209:8092 (llama.cpp NPC model).
// Responsibilities: stable contract, GBNF grammar on EVERY call, semantic
// cache (embedder on .209:3007), bounded inflight queue, canned fallback.
// The Lua side codes against POST /npc only; personas/enums/fallback live
// in config.json. Gateway code stays stable.

const http = require('http');
const fs = require('fs');
const path = require('path');

const CFG_PATH = process.env.NPC_CONFIG || path.join(__dirname, 'config.json');
let CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

// ---- GBNF grammar: forces exactly the NPC JSON schema, 100% valid ----
// Built from config enums so the Lua writer changes enums in config, not here.
// forceAction (optional): pin the "action" field to a single value so the
// model can only write the SPOKEN LINE — the outcome (accept/reject/counter)
// is decided by Lua, never inferred by the model. This is the brain/body split.
function buildGrammar(cfg, forceAction) {
  const actionRule = (forceAction && cfg.enums.action.indexOf(forceAction) !== -1)
    ? '"\\"' + forceAction + '\\""'
    : cfg.enums.action.map(a => '"\\"' + a + '\\""').join(' | ');
  const moods = cfg.enums.mood.map(m => '"\\"' + m + '\\""').join(' | ');
  // Each rule MUST be on a single line — llama.cpp GBNF treats a newline as
  // end-of-rule, so a wrapped root rule fails to parse ("failed to parse grammar").
  return [
    'root ::= "{" ws "\\"dialog\\"" ws ":" ws string ws "," ws "\\"action\\"" ws ":" ws action ws "," ws "\\"price_mult\\"" ws ":" ws number ws "," ws "\\"mood\\"" ws ":" ws mood ws "}"',
    'action ::= ' + actionRule,
    'mood   ::= ' + moods,
    'string ::= "\\"" ( [^"\\\\] | "\\\\" ["\\\\/bfnrt] )* "\\""',
    'number ::= "0" | "1" | "0." [0-9]+ | "1." [0-9]+ | [1-9] "." [0-9]+',
    // NOTE: no newline in ws — otherwise the model emits \n\n between fields
    // and any \n-based stop token truncates the JSON mid-object.
    'ws     ::= [ \\t]*'
  ].join('\n');
}
let GRAMMAR = buildGrammar(CFG);

// ---- Simplified -> Traditional (Cantonese/HK) conversion ----
// Qwen is a mainland model and leaks simplified chars into Cantonese output.
// opencc-js does full S2T ('cn' -> 'twp'/'hk'); loaded lazily so the gateway
// still boots if the dep is missing (falls back to identity + a warning).
let s2t = function (x) { return x; };
try {
  const OpenCC = require('opencc-js');
  // Simplified (mainland) -> Traditional Hong Kong.
  s2t = OpenCC.Converter({ from: 'cn', to: 'hk' });
  console.log('[hk-npc-gateway] opencc-js loaded (cn->hk)');
} catch (e) {
  console.warn('[hk-npc-gateway] opencc-js NOT loaded — output will not be S2T-converted: ' + e.message);
}

// ---- tiny helpers ----
function readBody(req) {
  return new Promise(function(resolve, reject) {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(s);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- upstream: embedder (.209:3007) ----
function embed(text) {
  return new Promise(function(resolve, reject) {
    const e = CFG.embedder;
    const data = JSON.stringify({ texts: [text] });
    const req = http.request({
      hostname: e.host, port: e.port, path: e.path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: e.timeout_ms
    }, function(res) {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.embeddings && j.embeddings[0]) resolve(j.embeddings[0]);
          else reject(new Error('bad embed response'));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('embed timeout')); });
    req.write(data); req.end();
  });
}

// ---- upstream: NPC model (.209:8092 /completion) with GBNF grammar ----
// Turn labels. A persona may override to bake the ROLE into every turn label
// (e.g. userLabel "<|dealer|>", npcLabel "<|customer|>") so a small model can't
// forget who is who between turns — the label re-states it on every line.
function labels(persona) {
  return {
    user: (persona && persona.userLabel) || '<|player|>',
    npc:  (persona && persona.npcLabel)  || '<|npc|>'
  };
}

function buildPrompt(persona, ctx, directive) {
  const L = labels(persona);
  let p = '<|system|>\n' + persona.system + '\n';
  if (persona.fewshot) {
    for (const ex of persona.fewshot) {
      p += L.user + ' ' + ex.player + '\n' + L.npc + ' ' + JSON.stringify(ex.npc) + '\n';
    }
  }
  // Background context (scene), read weakly by the model — keep it short.
  if (ctx && ctx.length) p += '(背景: ' + String(ctx).substring(0, 300) + ')\n';
  // Director instruction: placed RIGHT BEFORE the NPC turn so it dominates.
  // This is where the Lua-decided outcome is stated as an order, not a hint.
  if (directive && directive.length) p += '<|導演|> ' + String(directive).substring(0, 300) + '\n';
  return p;
}

// Map a Lua-forced action to a forceful Cantonese director line so the SPOKEN
// line matches the mechanical outcome. Lua owns the outcome; this just tells
// the model what feeling to voice. Falls back to a generic order.
const ACTION_DIRECTIVE = {
  greet:     '拆家啱啱行埋嚟，你係買家，開口應佢，好奇但小心，問下有咩貨。',
  smalltalk: '你係買家，同拆家閒聊兩句，唔使急。',
  deal:      '單嘢傾掂，你收咗貨、俾咗錢，開心咁應一句，準備走。',
  haggle:    '你嫌貴，想拆家減價，開口叫佢平啲。絕對唔可以講任何銀碼／數字／價錢（例如唔好講「五萬」「幾多蚊」），淨係叫佢平啲、抵啲，例如「平啲啦，咁貴邊個買呀」。',
  refuse:    '拆家開價太貴，你唔肯俾錢、唔買喇。嬲爆咁彈開佢，例如「咁貴？黐線！唔要！」。記住你係唔買嗰個，唔好講交貨收錢。',
  threaten:  '你懷疑拆家係放蛇差人，惡死能登咁恐嚇佢。',
  flee:      '差人殺到，你即刻驚青咁講句就開溜。',
  steal:     '你喺車入面，一手搶咗拆家啲貨唔俾錢，準備即刻踩油逃走。串爆咁笑佢戇鳩、抵佢蠢，例如「多謝晒喇笨柒，慢慢企喺度啦！」。你係打劫緊嗰個，唔好講俾錢。'
};

function infer(persona, playerLine, ctx, forceAction) {
  return new Promise(function(resolve, reject) {
    const inf = CFG.inference;
    const L = labels(persona);
    const directive = forceAction ? (ACTION_DIRECTIVE[forceAction] || '') : '';
    const grammar = forceAction ? buildGrammar(CFG, forceAction) : GRAMMAR;
    const prompt = buildPrompt(persona, ctx, directive) + L.user + ' ' + String(playerLine).substring(0, 500) + '\n' + L.npc + ' ';
    const payload = JSON.stringify({
      prompt: prompt,
      grammar: grammar,
      n_predict: inf.n_predict,
      temperature: inf.temperature,
      top_p: inf.top_p,
      cache_prompt: true,
      // grammar terminates at the closing "}"; stop tokens only guard against
      // the model continuing past it. No \n stop — it would cut valid JSON.
      // Stop on the user label (persona-specific) and the system tag.
      stop: [L.user, '<|system|>', '<|導演|>']
    });
    const req = http.request({
      hostname: inf.host, port: inf.port, path: inf.path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: inf.timeout_ms
    }, function(res) {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const content = (j.content || '').trim();
          const parsed = JSON.parse(content); // grammar guarantees valid JSON
          // Convert any leaked simplified chars to Traditional HK.
          if (parsed && typeof parsed.dialog === 'string') {
            try { parsed.dialog = s2t(parsed.dialog); } catch (e) { /* keep raw */ }
          }
          resolve(parsed);
        } catch (err) {
          console.error('[infer-fail] status=' + res.statusCode + ' bodylen=' + body.length + ' body=' + body.slice(0, 300));
          reject(new Error('infer parse: ' + err.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('infer timeout')); });
    req.write(payload); req.end();
  });
}

// ---- semantic cache (per persona) ----
// entry: { vec, resp, t }
const cacheStore = new Map(); // personaKey -> [entries]
const stats = { req: 0, cache_hit: 0, live: 0, fallback: 0, queue_reject: 0 };

function cacheGet(personaKey, vec) {
  if (!CFG.cache.enabled || !vec) return null;
  const list = cacheStore.get(personaKey);
  if (!list) return null;
  const now = Date.now();
  let best = null, bestSim = 0;
  for (const e of list) {
    if (now - e.t > CFG.cache.ttl_ms) continue;
    const sim = cosine(vec, e.vec);
    if (sim > bestSim) { bestSim = sim; best = e; }
  }
  if (best && bestSim >= CFG.cache.similarity_threshold) return best.resp;
  return null;
}

function cachePut(personaKey, vec, resp) {
  if (!CFG.cache.enabled || !vec) return;
  let list = cacheStore.get(personaKey);
  if (!list) { list = []; cacheStore.set(personaKey, list); }
  list.push({ vec, resp, t: Date.now() });
  if (list.length > CFG.cache.max_entries) list.shift();
}

// ---- bounded inflight queue (protects the throughput-saturated V100) ----
let inflight = 0;
const waiters = [];
function acquire() {
  return new Promise(function(resolve, reject) {
    if (inflight < CFG.queue.max_inflight) { inflight++; return resolve(); }
    if (waiters.length >= CFG.queue.max_depth) return reject(new Error('queue full'));
    waiters.push(resolve);
  });
}
function release() {
  inflight--;
  if (waiters.length && inflight < CFG.queue.max_inflight) {
    inflight++;
    const next = waiters.shift();
    next();
  }
}

function pickFallback(persona) {
  const fb = (persona.fallback && persona.fallback.length)
    ? persona.fallback
    : CFG.personas.default.fallback;
  return fb[Math.floor(Math.random() * fb.length)];
}

// ---- core handler for POST /npc ----
async function handleNpc(body) {
  stats.req++;
  const personaKey = body.persona || 'default';
  const persona = CFG.personas[personaKey] || CFG.personas.default;
  const playerLine = body.message || body.player || '';
  const ctx = body.context || '';
  // Lua-forced outcome: pins the action in the grammar + injects a director
  // line. When present the model can ONLY write the spoken line for that beat.
  const forceAction = (body.action && CFG.enums.action.indexOf(body.action) !== -1)
    ? body.action : null;

  if (!playerLine) return { code: 400, obj: { error: 'message required' } };

  // 1) semantic cache (skip if per-request context OR a forced action present —
  // both make reuse unsafe: same message, different beat = different line).
  let vec = null;
  const cacheable = CFG.cache.enabled && CFG.embedder.enabled && !ctx && !forceAction;
  if (cacheable) {
    try { vec = await embed(personaKey + '|' + playerLine); } catch (e) { vec = null; }
    const hit = cacheGet(personaKey, vec);
    if (hit) { stats.cache_hit++; return { code: 200, obj: Object.assign({}, hit, { source: 'cache' }) }; }
  }

  // 2) live inference behind bounded queue
  try {
    await acquire();
  } catch (e) {
    stats.fallback++; stats.queue_reject++;
    return { code: 200, obj: Object.assign({}, pickFallback(persona), { source: 'fallback', reason: 'queue' }) };
  }
  try {
    const resp = await infer(persona, playerLine, ctx, forceAction);
    // Guarantee the returned action matches what Lua asked for (grammar already
    // pins it, but belt-and-suspenders in case forceAction was rejected).
    if (forceAction) resp.action = forceAction;
    stats.live++;
    if (cacheable && vec) cachePut(personaKey, vec, resp);
    return { code: 200, obj: Object.assign({}, resp, { source: 'live' }) };
  } catch (e) {
    stats.fallback++;
    return { code: 200, obj: Object.assign({}, pickFallback(persona), { source: 'fallback', reason: 'infer', detail: e.message }) };
  } finally {
    release();
  }
}

// ---- HTTP server ----
const server = http.createServer(async function(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { status: 'ok', inflight, queued: waiters.length, personas: Object.keys(CFG.personas) });
  }
  if (req.method === 'GET' && req.url === '/stats') {
    return send(res, 200, stats);
  }

  // auth
  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + CFG.api_key) return send(res, 401, { error: 'Unauthorized' });

  if (req.method === 'POST' && req.url === '/reload') {
    try {
      CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      GRAMMAR = buildGrammar(CFG);
      return send(res, 200, { status: 'reloaded', personas: Object.keys(CFG.personas) });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST' && (req.url === '/npc' || req.url === '/dialog')) {
    try {
      const body = await readBody(req);
      const out = await handleNpc(body);
      return send(res, out.code, out.obj);
    } catch (e) { return send(res, 500, { error: e.message }); }
  }

  send(res, 404, { error: 'Not found. Endpoints: POST /npc, GET /health, GET /stats, POST /reload' });
});

server.listen(CFG.port, '0.0.0.0', function() {
  console.log('[hk-npc-gateway] listening on ' + CFG.port);
  console.log('[hk-npc-gateway] model=' + CFG.inference.host + ':' + CFG.inference.port + CFG.inference.path);
  console.log('[hk-npc-gateway] embedder=' + (CFG.embedder.enabled ? CFG.embedder.host + ':' + CFG.embedder.port : 'off'));
  console.log('[hk-npc-gateway] personas=' + Object.keys(CFG.personas).join(','));
});

