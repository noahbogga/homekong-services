// enrich.js — attaches form/injury/notes EVIDENCE onto cached events so the AI
// odds model (.209) has something to judge. Without evidence, aiAdjust makes no
// GPU call (see aiAdjust.hasEvidence). Two sources:
//
//   1. Soccer form  -> the football data API free tier (last-5 W/D/L per team).
//      Token-gated: no token => no-op. Covered free comps: PL, PD, BL1, SA,
//      FL1, ELC, BSA. Other soccer leagues (MLS, K-League, CSL) get skipped.
//   2. Manual file  -> data/evidence.json, keyed by team/fighter name. Covers
//      everything football-data can't (MMA, boxing, NHL, WNBA, non-free soccer).
//
// Engine-side only. Does NOT touch .209 or aiAdjust logic.
const fs = require('fs')
const path = require('path')
const { proxyFetch } = require('./proxy')
const { loadKeys } = require('./keys')
const { bestMatch, tokens, similarity } = require('./names')
const zqSource = require('./zqSource')
const nameMap = require('./nameMap')

const EVIDENCE_FILE = path.join(__dirname, '../data/evidence.json')
const FD_BASE = 'https://YOUR_FOOTBALL_DATA_HOST/v4'
const FORM_LOOKBACK_DAYS = 150       // enough to catch last 5 even in sparse comps
const FORM_TTL_MS = 6 * 60 * 60 * 1000 // refetch a competition's results every 6h

// sportKey (our cache) -> the football data API competition code (free tier only)
const FD_COMP = {
  soccer_epl: 'PL',
  soccer_spain_la_liga: 'PD',
  soccer_germany_bundesliga: 'BL1',
  soccer_italy_serie_a: 'SA',
  soccer_france_ligue_one: 'FL1',
  soccer_efl_champ: 'ELC',
  soccer_brazil_campeonato: 'BSA',
}

// ── football-data token rotation (mirrors keys.js pattern) ────
let fdIdx = 0
function getNextFdToken() {
  const pool = (loadKeys().footballData || []).filter(Boolean)
  if (!pool.length) return null
  const t = pool[fdIdx % pool.length]
  fdIdx++
  return t
}

// ── per-competition results cache so we stay under 10 req/min ─
const compCache = new Map() // comp -> { time, matches }

async function fetchFinished(comp) {
  const hit = compCache.get(comp)
  if (hit && Date.now() - hit.time < FORM_TTL_MS) return hit.matches

  const token = getNextFdToken()
  if (!token) return null

  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - FORM_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10)
  const url = `${FD_BASE}/competitions/${comp}/matches?status=FINISHED&dateFrom=${from}&dateTo=${to}`
  try {
    const resp = await proxyFetch(url, { headers: { 'X-Auth-Token': token } })
    if (!resp.ok) { console.error(`[enrich] football-data ${comp} HTTP ${resp.status}`); return null }
    const j = await resp.json()
    const matches = j.matches || []
    compCache.set(comp, { time: Date.now(), matches })
    return matches
  } catch (e) {
    console.error(`[enrich] football-data ${comp} error: ${e.message}`)
    return null
  }
}

// ── build last-N form string ("WWDLW", newest last) per team from finished matches
function buildFormTable(matches, lastN = 5) {
  // collect chronological results per team name
  const perTeam = new Map() // name -> [{date, res}]
  const push = (name, date, res) => {
    if (!perTeam.has(name)) perTeam.set(name, [])
    perTeam.get(name).push({ date, res })
  }
  for (const m of matches) {
    const ft = m.score && m.score.fullTime
    if (!ft || ft.home == null || ft.away == null) continue
    const home = m.homeTeam && m.homeTeam.name
    const away = m.awayTeam && m.awayTeam.name
    if (!home || !away) continue
    const d = m.utcDate || ''
    let hRes, aRes
    if (ft.home > ft.away) { hRes = 'W'; aRes = 'L' }
    else if (ft.home < ft.away) { hRes = 'L'; aRes = 'W' }
    else { hRes = 'D'; aRes = 'D' }
    push(home, d, hRes); push(away, d, aRes)
  }
  const table = new Map() // name -> "WWDLW"
  for (const [name, arr] of perTeam) {
    arr.sort((a, b) => a.date.localeCompare(b.date))
    table.set(name, arr.slice(-lastN).map(x => x.res).join(''))
  }
  return table
}

// resolve one odds-cache team name to a football-data name via fuzzy match
function resolveForm(oddsName, formTable) {
  if (formTable.has(oddsName)) return formTable.get(oddsName)   // exact
  const m = bestMatch(oddsName, [...formTable.keys()], 0.5)
  return m ? formTable.get(m.value) : null
}

// ── SOURCE 1: soccer form from the football data API ─────────────
async function enrichSoccerForm(sportKey, events) {
  const comp = FD_COMP[sportKey]
  if (!comp) return 0
  const matches = await fetchFinished(comp)
  if (!matches || !matches.length) return 0
  const formTable = buildFormTable(matches)
  if (!formTable.size) return 0

  let attached = 0
  for (const ev of events) {
    const home = resolveForm(ev.homeTeam, formTable)
    const away = resolveForm(ev.awayTeam, formTable)
    if (!home && !away) continue
    ev.form = ev.form || {}
    if (home) ev.form.home = home
    if (away) ev.form.away = away
    attached++
  }
  return attached
}

// ── SOURCE 2: manual evidence file (any sport) ───────────────
// data/evidence.json shape (all keys optional):
//   { "Team or Fighter Name": { "form": "WWLDW", "injuries": ["x out"], "notes": "..." }, ... }
// Matched to home OR away by fuzzy name. injuries/notes attach per-side.
let evidenceCache = null, evidenceMtime = 0
function loadEvidence() {
  try {
    const st = fs.statSync(EVIDENCE_FILE)
    if (!evidenceCache || st.mtimeMs !== evidenceMtime) {
      evidenceCache = JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf-8'))
      evidenceMtime = st.mtimeMs
    }
  } catch { evidenceCache = null }
  return evidenceCache
}

function enrichManual(events) {
  const table = loadEvidence()
  if (!table) return 0
  const keys = Object.keys(table).filter(k => !k.startsWith('_') && tokens(k).length)
  if (!keys.length) return 0

  let attached = 0
  for (const ev of events) {
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? ev.homeTeam : ev.awayTeam
      let entry = table[team]
      if (!entry) {
        const m = bestMatch(team, keys, 0.6)
        if (m) entry = table[m.value]
      }
      if (!entry) continue
      if (entry.form) { ev.form = ev.form || {}; ev.form[side] = entry.form }
      if (entry.injuries && entry.injuries.length) {
        ev.injuries = ev.injuries || {}
        ev.injuries[side] = [].concat(ev.injuries[side] || [], entry.injuries)
      }
      if (entry.notes) ev.notes = ev.notes ? `${ev.notes} ${entry.notes}` : entry.notes
      attached++
    }
  }
  return attached
}

// ── SOURCE 3: ZQ Chinese football feed (form + injuries + strength) ──
// ZQ is a GLOBAL pool of matches (Chinese names), not per-sportKey. We fetch it
// once, translate CN->EN names via the .209 raw model, build an English-keyed
// pool, then fuzzy-match each pool entry to soccer events across all sports.
// injuries are capped (ZQ occasionally packs a full squad list into the field).
const ZQ_INJ_CAP = 6

async function buildZqPool() {
  // 1) pull all ZQ matches (evidence-shaped, Chinese names)
  let matches
  try { matches = await zqSource.fetchAll({ pageSize: 100 }) }
  catch (e) { console.error(`[zq] fetch failed: ${e.message}`); return [] }
  if (!matches.length) return []

  // 2) resolve all CN names -> EN in one batched pass (cached on disk)
  const cnNames = []
  for (const m of matches) { cnNames.push(m.cnHome, m.cnAway) }
  try { await nameMap.resolveNames(cnNames) }
  catch (e) { console.error(`[zq] namemap failed: ${e.message}`) }

  // 3) attach English names; drop entries we couldn't translate on BOTH sides
  const pool = []
  for (const m of matches) {
    const enHome = nameMap.toEnglish(m.cnHome)
    const enAway = nameMap.toEnglish(m.cnAway)
    if (!enHome && !enAway) continue
    pool.push({ ...m, enHome, enAway })
  }
  return pool
}

// Match one odds-cache event to a ZQ pool entry by English team names (both
// sides must align, direction-aware). Returns the pool entry or null.
function matchZq(ev, pool) {
  let best = null, bestScore = 0
  for (const z of pool) {
    if (!z.enHome || !z.enAway) continue
    const sHome = similarity(ev.homeTeam, z.enHome)
    const sAway = similarity(ev.awayTeam, z.enAway)
    // both sides must be a reasonable match, same orientation
    if (sHome >= 0.5 && sAway >= 0.5) {
      const score = sHome + sAway
      if (score > bestScore) { bestScore = score; best = z }
    }
  }
  return best
}

// Attach ZQ evidence to soccer events in one sport's list. Returns count attached.
function enrichFromZq(events, pool) {
  if (!pool.length) return 0
  let n = 0
  for (const ev of events) {
    const z = matchZq(ev, pool)
    if (!z) continue
    let touched = false
    if (z.form && (z.form.home || z.form.away)) {
      ev.form = ev.form || {}
      if (z.form.home && !ev.form.home) { ev.form.home = z.form.home; touched = true }
      if (z.form.away && !ev.form.away) { ev.form.away = z.form.away; touched = true }
    }
    const ih = (z.injuries && z.injuries.home || []).slice(0, ZQ_INJ_CAP)
    const ia = (z.injuries && z.injuries.away || []).slice(0, ZQ_INJ_CAP)
    if (ih.length || ia.length) {
      ev.injuries = ev.injuries || {}
      if (ih.length) { ev.injuries.home = [].concat(ev.injuries.home || [], ih); touched = true }
      if (ia.length) { ev.injuries.away = [].concat(ev.injuries.away || [], ia); touched = true }
    }
    if (touched) { ev._zq = true; n++ }
  }
  return n
}

// ── ORCHESTRATE: enrich every cached sport in place ──────────
// getCacheRaw(sportKey)->events[]; setCache(sportKey, events) persists.
async function runEnrichment({ sports, getCacheRaw, setCache }) {
  const haveFd = (loadKeys().footballData || []).filter(Boolean).length > 0
  if (!haveFd) console.log('[enrich] no football-data token, soccer form skipped')

  // Build the ZQ pool once for this run (fetch + translate). Empty on failure.
  const zqPool = await buildZqPool()
  if (zqPool.length) console.log(`[zq] pool: ${zqPool.length} translated matches`)

  let soccer = 0, manual = 0, zq = 0, touched = 0
  for (const sportKey of sports) {
    const events = getCacheRaw(sportKey)
    if (!Array.isArray(events) || !events.length) continue
    let n = 0
    if (haveFd) n += await enrichSoccerForm(sportKey, events)
    // ZQ only makes sense for soccer sports
    if (zqPool.length && sportKey.startsWith('soccer_')) {
      const zn = enrichFromZq(events, zqPool)
      zq += zn; n += zn
    }
    n += enrichManual(events)
    if (n > 0) { setCache(sportKey, events); touched++ }
    if (FD_COMP[sportKey]) soccer += n
    // small spacing between football-data comps to respect 10 req/min
    if (FD_COMP[sportKey] && haveFd) await new Promise(r => setTimeout(r, 1500))
  }
  console.log(`[enrich] soccer_form=${soccer} zq=${zq} manual=${manual} sports_touched=${touched}`)
  return { soccer, zq, manual, touched }
}

module.exports = {
  runEnrichment, enrichSoccerForm, enrichManual, enrichFromZq, buildZqPool, matchZq,
  buildFormTable, resolveForm, loadEvidence, FD_COMP,
}

