// nameMap.js — resolves Chinese football club/nation names (from ZQ) to their
// common English names, so ZQ evidence can be matched to the English-named
// events in the odds cache (via names.js fuzzy matching downstream).
//
// Uses the RAW llama-server on .209:8081 (free-form chat). Does NOT touch the
// grammar-locked odds control API on :8091. Results are cached to disk so each
// name is translated once; unknown names are simply skipped (never mis-mapped).
const fs = require('fs')
const path = require('path')

const LLM_URL = process.env.ZQ_NAMEMAP_URL || 'http://192.168.50.209:8081/v1/chat/completions'
const MAP_FILE = path.join(__dirname, '../data/zq-namemap.json')
const REQ_TIMEOUT_MS = 30000
const BATCH = 20            // names per LLM call
const MAX_BATCHES = 10      // safety cap per run

let cache = null
function loadMap() {
  if (cache) return cache
  try { cache = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8')) }
  catch { cache = {} }
  return cache
}
function saveMap() {
  try { fs.writeFileSync(MAP_FILE, JSON.stringify(cache, null, 2)) } catch {}
}

function looksChinese(s) {
  return /[一-鿿]/.test(s || '')
}

// ── ask the raw model to translate a batch of CN names → EN ──
// Returns a partial {cn: en} map; names it can't do are omitted by the model.
async function translateBatch(names) {
  const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n')
  const sys = 'You translate Chinese football (soccer) club and national team names into their common English names as used by international betting/odds sites. Reply ONLY with a compact JSON object mapping each Chinese name to its English name. No commentary. If unsure of a name, omit it.'
  const user = `Translate these Chinese football team names to English. Return JSON {chinese: english}.\n${list}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0,
        max_tokens: 1200,
      }),
      signal: ctrl.signal,
    })
  } finally { clearTimeout(timer) }
  if (!resp.ok) throw new Error('namemap LLM HTTP ' + resp.status)

  const data = await resp.json()
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content
  if (!content) throw new Error('namemap empty response')

  // model may wrap JSON in prose/fences — extract the first {...} block
  const m = content.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('namemap no JSON in response')
  let obj
  try { obj = JSON.parse(m[0]) } catch { throw new Error('namemap bad JSON') }
  return obj && typeof obj === 'object' ? obj : {}
}

// ── resolve a set of CN names to EN, using cache + LLM for the rest ──
// Returns the full in-memory map (cn -> en) after filling gaps. Persists.
async function resolveNames(cnNames) {
  const map = loadMap()
  const unknown = [...new Set(cnNames.filter(n => looksChinese(n) && !(n in map)))]
  if (!unknown.length) return map

  let batches = 0
  for (let i = 0; i < unknown.length && batches < MAX_BATCHES; i += BATCH, batches++) {
    const slice = unknown.slice(i, i + BATCH)
    try {
      const part = await translateBatch(slice)
      for (const [cn, en] of Object.entries(part)) {
        if (en && typeof en === 'string' && en.trim()) map[cn] = en.trim()
      }
    } catch (e) {
      console.error(`[namemap] batch failed: ${e.message}`)
    }
  }
  saveMap()
  return map
}

// synchronous lookup against the cached map (no network)
function toEnglish(cnName) {
  const map = loadMap()
  return map[cnName] || null
}

module.exports = { resolveNames, toEnglish, loadMap, looksChinese }
