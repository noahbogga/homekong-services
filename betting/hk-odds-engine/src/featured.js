// featured.js — daily-curated "hot" matches (Stake-style) across BOTH the SharpAPI and
// ZQ pools. Blends competition prestige, competitiveness, club stature, big-vs-big clash,
// stage/knockout and goal-expectation into a 0–100 hype score, keeps yesterday's still-
// upcoming picks sticky, floats live matches to the top, honours editorial pins, and asks
// the .209 model for a one-line "why watch" blurb per chosen match.
//
// Output: data/featured.json = [{eventId, sportKey, home, away, startTime, live, score,
// badges[], blurb}]. Served to the NUI via GET /featured.
const fs = require('fs')
const path = require('path')
const { getCacheRaw, getCachedSports } = require('./oddsCache')

const FEATURED_FILE = path.join(__dirname, '../data/featured.json')
const HISTORY_FILE = path.join(__dirname, '../data/featured-history.json')

const SET_SIZE = 3           // target picks/day
const MIN_SIZE = 2           // floor on a thin day
const UPCOMING_MS = 48 * 60 * 60 * 1000
const LIVE_WINDOW_MS = 2.5 * 60 * 60 * 1000   // treat as live for 2.5h after kickoff
const STICKY_BONUS = 15

// Editorial pins (force a match in at the top) — event IDs. Populated via config later.
let PINS = []
function setPins(ids) { PINS = Array.isArray(ids) ? ids : [] }

// ── competition prestige: works for BOTH pools off the sportKey ──
// 30 = elite continental / top-5 European; 18 = strong domestic; 10 = mid; 4 = friendly/low.
const TIER = {
  // elite continental
  zq_champions_league: 30, zq_europa_league: 27, zq_conference_league: 22,
  zq_copa_libertadores: 26, zq_copa_sudamericana: 22,
  // top-5 European (SharpAPI keys)
  soccer_epl: 30, soccer_spain_la_liga: 30, soccer_germany_bundesliga: 28,
  soccer_italy_serie_a: 28, soccer_france_ligue_one: 26,
  soccer_uefa_champs_league: 30, soccer_uefa_europa_league: 27,
  // strong domestic / notable
  soccer_efl_champ: 16, soccer_brazil_campeonato: 18, zq_brazil_serie_a: 18,
  soccer_china_superleague: 12, soccer_korea_kleague1: 12, zq_korea_kleague: 12,
  zq_japan_jleague: 14, soccer_usa_mls: 14, zq_usa_mls: 14,
  zq_sweden_allsvenskan: 12, zq_norway_eliteserien: 12,
  // other sports (SharpAPI)
  basketball_wnba: 14, icehockey_nhl: 18, mma_mixed_martial_arts: 16, boxing_boxing: 16,
}
function tierScore(sportKey) {
  if (TIER[sportKey] != null) return TIER[sportKey]
  // cups/knockouts unknown to the map still get a lift; lower divisions / friendlies low
  if (/cup|copa|pokal|coupe/i.test(sportKey)) return 14
  if (/friendly|reserve|u\d\d|women|_j2|superettan|ykkonen/i.test(sportKey)) return 4
  return 8
}

// fair 1X2 probs from an event's h2h market (vig-stripped). Returns {h,d,a} or null.
function fairFromH2h(ev) {
  const h2h = ev.markets && ev.markets.h2h
  if (!Array.isArray(h2h) || h2h.length < 2) return null
  const price = (nm) => { const o = h2h.find(x => x.name === nm); return o ? o.price : null }
  const ph = price(ev.homeTeam), pa = price(ev.awayTeam)
  const pd = price('Draw')
  const inv = [ph, pd, pa].map(p => (p && p > 1.01) ? 1 / p : 0)
  const sum = inv.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  return { h: inv[0] / sum, d: inv[1] / sum, a: inv[2] / sum }
}

// ── score one event 0–100. `nowMs` for live detection. Universal signals always apply;
// ZQ-only signals (strength/value/poisson) are BONUS — absent -> 0, never a penalty. ──
function scoreEvent(ev, nowMs) {
  const badges = []
  let score = 0

  // prestige (30) — the biggest lever, both pools
  const tier = tierScore(ev.sportKey)
  score += tier
  if (tier >= 26) badges.push('PRESTIGE')

  // competitiveness (20) — tighter 1X2 = more watchable
  const fair = fairFromH2h(ev)
  if (fair) {
    const spread = Math.abs(fair.h - fair.a)
    score += 20 * (1 - spread)
    if (spread < 0.12) badges.push('TIGHT')
  }

  // club stature (20) — ZQ bonus: strength composite + squad value
  const st = ev.strength
  if (st && (st.home != null || st.away != null)) {
    const avg = ((st.home || 0) + (st.away || 0)) / 2
    score += (avg / 100) * 12
    // big-vs-big clash (12) — both sides strong
    if ((st.home || 0) >= 60 && (st.away || 0) >= 60) {
      score += 12
      badges.push('BIG CLASH')
    }
  }

  // stage / knockout (10) — keyword in the key or label
  const label = (ev.zqLeagueLabel || ev.sportKey || '')
  if (/final|knockout|semi|quarter/i.test(label)) { score += 10; badges.push('KNOCKOUT') }
  else if (/cup|copa|champions|europa|libertadores/i.test(label)) { score += 6 }

  // goal expectation (8) — ZQ poisson total, tie-breaker
  if (ev._lH != null && ev._lA != null) {
    const tot = ev._lH + ev._lA
    score += Math.max(0, Math.min(8, (tot - 2) * 4))
    if (tot >= 3.2) badges.push('GOALS')
  }

  // live detection
  const start = Date.parse(ev.startTime || '')
  const live = Number.isFinite(start) && nowMs >= start && nowMs < start + LIVE_WINDOW_MS
  if (live) badges.push('LIVE')

  return { score: +score.toFixed(2), badges, live, start }
}

// Map a sportKey to its NUI top-level category id (mirrors config.lua SportCategories).
// Soccer covers BOTH the SharpAPI soccer_* keys and the ZQ zq_* keys.
function categoryOf(sportKey) {
  const k = String(sportKey || '')
  if (k.startsWith('soccer_') || k.startsWith('zq_')) return 'soccer'
  if (k.startsWith('basketball_')) return 'basketball'
  if (k.startsWith('icehockey_')) return 'ice_hockey'
  if (k.startsWith('mma_')) return 'mma'
  if (k.startsWith('boxing_')) return 'boxing'
  if (k.startsWith('politics_')) return 'politics'
  return 'other'
}

// gather every event in the featured window across both pools
function gatherCandidates(nowMs) {
  const out = []
  for (const key of getCachedSports()) {
    const arr = getCacheRaw(key)
    if (!Array.isArray(arr)) continue
    for (const ev of arr) {
      if (!ev || !ev.homeTeam || !ev.awayTeam) continue
      const start = Date.parse(ev.startTime || '')
      if (!Number.isFinite(start)) continue
      // window: from 2.5h ago (still-live) to +48h
      if (start < nowMs - LIVE_WINDOW_MS || start > nowMs + UPCOMING_MS) continue
      out.push(ev)
    }
  }
  return out
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return fallback }
}

// Rank a scored list: pins first, then live, then total score. Mutates + returns.
function rankScored(scored) {
  scored.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.live !== b.live) return a.live ? -1 : 1
    return b.total - a.total
  })
  return scored
}

// Score every candidate once (sticky bonus + pins applied), tagged with its category.
function scoreAll(nowMs) {
  const cands = gatherCandidates(nowMs)
  const history = readJson(HISTORY_FILE, { ids: [] })
  const stickySet = new Set(history.ids || [])
  return cands.map(ev => {
    const s = scoreEvent(ev, nowMs)
    let total = s.score
    if (stickySet.has(ev.id)) total += STICKY_BONUS   // HOT stays HOT
    const pinned = PINS.includes(ev.id)
    return { ev, ...s, category: categoryOf(ev.sportKey), total: pinned ? Infinity : total, pinned }
  })
}

// ── select the featured set for ONE category (or all pooled if category omitted) ──
function selectFeatured(nowMs = Date.now(), category = null) {
  let scored = scoreAll(nowMs)
  if (category) scored = scored.filter(x => x.category === category)
  rankScored(scored)
  const take = Math.min(SET_SIZE, Math.max(MIN_SIZE, scored.length))
  return scored.slice(0, take)
}

// ── select featured for EVERY category present, keyed by category id ──
function selectFeaturedByCategory(nowMs = Date.now()) {
  const scored = scoreAll(nowMs)
  const byCat = {}
  for (const x of scored) (byCat[x.category] ||= []).push(x)
  const out = {}
  for (const [cat, list] of Object.entries(byCat)) {
    rankScored(list)
    // Minor sports (few events) still surface at least 1 pick; soccer keeps 3.
    const floor = list.length >= MIN_SIZE ? MIN_SIZE : 1
    const take = Math.min(SET_SIZE, Math.max(floor, list.length))
    out[cat] = list.slice(0, take)
  }
  return out
}

// ── AI "why watch" blurb via the RAW .209:8081 model (free text, NOT the :8091 grammar
// API). Uses the same enriched evidence text as the odds adjuster. Falls back to a
// templated line on any error so featured never breaks on the AI. ──
const { formatMatchText } = require('./aiAdjust')
const BLURB_URL = process.env.ZQ_NAMEMAP_URL || 'http://192.168.50.209:8081/v1/chat/completions'

function fallbackBlurb(ev, badges) {
  if (badges.includes('BIG CLASH')) return `Heavyweight clash: ${ev.homeTeam} take on ${ev.awayTeam}.`
  if (badges.includes('LIVE')) return `Live now — ${ev.homeTeam} vs ${ev.awayTeam}.`
  if (badges.includes('PRESTIGE')) return `${ev.homeTeam} vs ${ev.awayTeam} — one of today's marquee ties.`
  return `${ev.homeTeam} vs ${ev.awayTeam} — one to watch.`
}

async function makeBlurb(ev, badges) {
  try {
    const evidence = formatMatchText(ev)
    const sys = 'You are a sports betting editor. Write ONE short, punchy sentence (max 18 words) telling a bettor why this football match is worth watching. No stats dump, no markdown, no quotes. Just the sentence.'
    const user = `Match evidence:\n${evidence}\nWrite the one-line hook.`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    let resp
    try {
      resp = await fetch(BLURB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.7, max_tokens: 60,
        }),
        signal: ctrl.signal,
      })
    } finally { clearTimeout(timer) }
    if (!resp.ok) throw new Error('blurb HTTP ' + resp.status)
    const data = await resp.json()
    let txt = data?.choices?.[0]?.message?.content || ''
    txt = txt.trim().replace(/^["'`]+|["'`]+$/g, '').split('\n')[0].trim()
    if (!txt || txt.length < 8) throw new Error('blurb too short')
    return txt.slice(0, 160)
  } catch {
    return fallbackBlurb(ev, badges)
  }
}

// Shape one scored pick into the NUI payload row (blurb resolved by caller).
function serializePick(p, blurb) {
  const ev = p.ev
  return {
    eventId: ev.id, sportKey: ev.sportKey, category: p.category,
    home: ev.homeTeam, away: ev.awayTeam, startTime: ev.startTime,
    live: p.live, score: p.total === Infinity ? 999 : p.total,
    pinned: p.pinned, badges: p.badges, blurb,
    league: ev.zqLeagueLabel || ev.sportKey,
  }
}

// ── main: refresh the featured set and persist. Called by cron + on startup. ──
// Builds a per-category set so each sport gets its own hot matches (soccer no longer
// crowds out basketball/hockey/etc). Persists a keyed object; a flat `all` list is kept
// for backward-compat and stickiness. Blurbs are cached by eventId across refreshes.
async function refreshFeatured(nowMs = Date.now()) {
  const byCat = selectFeaturedByCategory(nowMs)

  // Cache prior blurbs by eventId from whichever shape the file is in.
  const prevRaw = readJson(FEATURED_FILE, null)
  const prevBlurb = {}
  const collectBlurbs = (list) => { for (const p of (list || [])) if (p.eventId && p.blurb) prevBlurb[p.eventId] = p.blurb }
  if (Array.isArray(prevRaw)) collectBlurbs(prevRaw)
  else if (prevRaw && prevRaw.byCategory) for (const l of Object.values(prevRaw.byCategory)) collectBlurbs(l)

  // Blurbs are soccer-only (the evidence/AI pipeline is football). Other sports get a
  // clean templated line so cards still read well without a stats dump.
  const outByCat = {}
  const all = []
  for (const [cat, picks] of Object.entries(byCat)) {
    const rows = []
    for (const p of picks) {
      let blurb = prevBlurb[p.ev.id]
      if (!blurb) blurb = (cat === 'soccer') ? await makeBlurb(p.ev, p.badges) : fallbackBlurb(p.ev, p.badges)
      const row = serializePick(p, blurb)
      rows.push(row); all.push(row)
    }
    outByCat[cat] = rows
  }

  const payload = { byCategory: outByCat, all, at: new Date().toISOString() }
  try { fs.writeFileSync(FEATURED_FILE, JSON.stringify(payload, null, 1)) } catch {}
  // record upcoming ids for tomorrow's stickiness (not already-live/ended)
  const ids = all.filter(x => Date.parse(x.startTime) > nowMs).map(x => x.eventId)
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify({ ids, at: new Date().toISOString() })) } catch {}
  const cats = Object.entries(outByCat).map(([c, r]) => `${c}:${r.length}`).join(' ')
  console.log(`[featured] ${cats} live=${all.filter(x => x.live).length} pool=${gatherCandidates(nowMs).length}`)
  return payload
}

// getFeatured(category): returns that category's list; no category -> the flat `all`.
// Tolerates the legacy flat-array file shape.
function getFeatured(category = null) {
  const raw = readJson(FEATURED_FILE, null)
  if (!raw) return []
  if (Array.isArray(raw)) return category ? raw.filter(x => (x.category || 'soccer') === category) : raw
  if (category) return raw.byCategory?.[category] || []
  return raw.all || []
}

module.exports = { refreshFeatured, getFeatured, selectFeatured, selectFeaturedByCategory, scoreEvent, setPins }

