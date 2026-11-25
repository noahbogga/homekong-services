'use strict';

const http = require('http');
const PORT = 3088;
const OLLAMA_HOST = '192.168.50.208';
const OLLAMA_PORT = 11434;
const GATE_MODEL = 'phi4-mini:latest';
const CHAT_MODEL = 'phi4-mini:latest';
const API_KEY = 'CHANGE_ME';

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function ollamaRequest(payload) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(payload);
    var req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000
    }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Bad Ollama response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(data);
    req.end();
  });
}

function ollamaChatRequest(payload) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(payload);
    var req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 60000
    }, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Bad Ollama chat response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Ollama chat timeout')); });
    req.write(data);
    req.end();
  });
}

function buildClassifyPrompt(message) {
  return 'Classify this user message. Reply with ONLY: intent:WORD complexity:NUMBER\n'
    + 'Valid intents: web, knowledge, code, file, image, chat\n'
    + 'Complexity: 1=trivial 2=simple 3=medium 4=complex 5=very complex\n'
    + 'No explanation, no extra text. Just the classification line.\n'
    + 'Message: "' + message.substring(0, 300) + '"\n'
    + 'Classification:';
}

function parseClassification(text) {
  var t = (text || '').trim().toLowerCase();
  var im = t.match(/intent:(\w+)/);
  var cm = t.match(/complexity:(\d)/);
  return {
    intent: im ? im[1] : 'chat',
    complexity: cm ? parseInt(cm[1]) : 3
  };
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

var server = http.createServer(async function(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { status: 'ok', model: GATE_MODEL });
  }

  // Auth check
  var auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + API_KEY) {
    return send(res, 401, { error: 'Unauthorized' });
  }

  if (req.method === 'POST' && req.url === '/classify') {
    try {
      var body = await readBody(req);
      if (!body.message) return send(res, 400, { error: 'message required' });

      var prompt = buildClassifyPrompt(body.message);
      var result = await ollamaRequest({
        model: GATE_MODEL,
        prompt: prompt,
        stream: false,
        options: { num_predict: 20, temperature: 0.1 }
      });

      var parsed = parseClassification(result.response);
      return send(res, 200, {
        intent: parsed.intent,
        complexity: parsed.complexity,
        raw: result.response.trim(),
        model: GATE_MODEL,
        duration_ms: Math.round((result.total_duration || 0) / 1e6)
      });
    } catch(e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/chat') {
    try {
      var body = await readBody(req);
      if (!body.message) return send(res, 400, { error: 'message required' });

      var system = body.system || 'You are a helpful in-game AI assistant for a FiveM roleplay server called HOMEKONG. Be concise, in-character, and helpful. Keep responses under 200 words unless asked for more.';
      var model = body.model || CHAT_MODEL;

      var result = await ollamaChatRequest({
        model: model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: body.message.substring(0, 1000) }
        ],
        stream: false,
        options: { num_predict: body.max_tokens || 300, temperature: body.temperature || 0.7 }
      });

      return send(res, 200, {
        response: (result.message && result.message.content) || '',
        model: model,
        duration_ms: Math.round((result.total_duration || 0) / 1e6)
      });
    } catch(e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/generate') {
    try {
      var body = await readBody(req);
      if (!body.prompt) return send(res, 400, { error: 'prompt required' });

      var model = body.model || CHAT_MODEL;
      var result = await ollamaRequest({
        model: model,
        prompt: body.prompt.substring(0, 2000),
        stream: false,
        options: { num_predict: body.max_tokens || 500, temperature: body.temperature || 0.7 }
      });

      return send(res, 200, {
        response: result.response || '',
        model: model,
        duration_ms: Math.round((result.total_duration || 0) / 1e6)
      });
    } catch(e) {
      return send(res, 500, { error: e.message });
    }
  }

  send(res, 404, { error: 'Not found. Endpoints: /classify, /chat, /generate, /health' });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[fivem-ai-api] Listening on port ' + PORT);
  console.log('[fivem-ai-api] Gate model: ' + GATE_MODEL);
  console.log('[fivem-ai-api] Ollama: ' + OLLAMA_HOST + ':' + OLLAMA_PORT);
});
