// ingest.js — POST /odds/ingest
// Accepts odds pushes from stake-odds (and any future external source).
// Three modes:
//   replace — Stake is the primary source for this sportKey (basketball).
//              Writes directly into cache + seeds drift base. Used for regular/hot cycles.
//   merge   — Stake supplies extended markets (corners, cards, btts) for soccer fixtures
//              already in cache from ZQ/SharpAPI. Appends markets, does NOT replace h2h.
//   live    — In-play odds update. Updates matching events' h2h/spreads/totals directly.
//              Bypasses AI adjustment and drift — Stake live prices are authoritative.
const express = require('express')
const { setCache, getCacheRaw } = require('../oddsCache')
const { storeBaseOdds, clearAiAnchor, filterUpcoming } = require('../crons/odds')
const { similarity } = require('../names')

const router = express.Router()

// ── fuzzy event match ────────────────────────────────────────────────────────
// Match a Stake event to a cached event by team name similarity + startTime proximity.
// Returns the cached event index, or -1 if no good match.
const TIME_WINDOW_MS = 3 * 60 * 60 * 1000   // 3h tolerance (handles TZ/DST drift)
const NAME_THRESHOLD = 0.55                  // sim() score needed per team

function findMatch(cached, stakeEv) {
  const st = new Date(stakeEv.startTime).getTime()
  let bestIdx = -1, bestScore = 0

  for (let i = 0; i < cached.length; i++) {
    const ev = cached[i]
    const ct = new Date(ev.startTime).getTime()
    if (isNaN(ct) || isNaN(st)) continue
    if (Math.abs(ct - st) > TIME_WINDOW_MS) continue

    const homeScore = similarity(stakeEv.homeTeam, ev.homeTeam)
    const awayScore = similarity(stakeEv.awayTeam, ev.awayTeam)
    // Also try reversed (Stake home = engine away — rare but possible)
    const revScore = (similarity(stakeEv.homeTeam, ev.awayTeam) + similarity(stakeEv.awayTeam, ev.homeTeam)) / 2
    const fwd = (homeScore + awayScore) / 2

    const score = Math.max(fwd, revScore)
    if (homeScore >= NAME_THRESHOLD && awayScore >= NAME_THRESHOLD && score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return bestIdx
}

// ── mode: replace ────────────────────────────────────────────────────────────
function doReplace(sportKey, events) {
  const upcoming = filterUpcoming(events)
  if (!upcoming.length) return { ingested: 0, mode: 'replace' }
  setCache(sportKey, upcoming)
  storeBaseOdds(sportKey, upcoming)
  clearAiAnchor(sportKey)
  return { ingested: upcoming.length, mode: 'replace' }
}

// ── mode: merge ───────────────────────────────────────────────────────────────
// Appends Stake-only markets (corners, cards, btts, player props) to existing
// cached events. Never overwrites h2h/spreads/totals (those belong to ZQ/Sharp).
const PROTECTED_MARKETS = new Set(['h2h', 'spreads', 'totals', 'ah', 'btts', 'dc', 'dnb'])

function doMerge(sportKey, stakeEvents) {
  const cached = getCacheRaw(sportKey)
  if (!cached || !cached.length) return { ingested: 0, mode: 'merge', note: 'cache empty' }

  let merged = 0
  for (const stakeEv of stakeEvents) {
    const idx = findMatch(cached, stakeEv)
    if (idx === -1) continue
    const ev = cached[idx]
    for (const [mkt, outcomes] of Object.entries(stakeEv.markets || {})) {
      if (PROTECTED_MARKETS.has(mkt)) continue   // do not overwrite ZQ/Sharp markets
      if (Array.isArray(outcomes) && outcomes.length > 0) {
        ev.markets[mkt] = outcomes
      }
    }
    merged++
  }
  if (merged > 0) setCache(sportKey, cached)
  return { ingested: merged, total: stakeEvents.length, mode: 'merge' }
}

// ── mode: live ───────────────────────────────────────────────────────────────
// Updates h2h/spreads/totals for in-play matches. Does NOT trigger AI or drift.
// The stake-odds container only pushes live events for matches in the live window.
const LIVE_MARKETS = ['h2h', 'spreads', 'totals']

function doLive(sportKey, stakeEvents) {
  const cached = getCacheRaw(sportKey)
  if (!cached || !cached.length) return { ingested: 0, mode: 'live', note: 'cache empty' }

  let updated = 0
  for (const stakeEv of stakeEvents) {
    const idx = findMatch(cached, stakeEv)
    if (idx === -1) continue
    const ev = cached[idx]
    // Mark live so the NUI knows the score/odds are in-play
    ev._live = true
    ev._liveTs = Date.now()
    for (const mkt of LIVE_MARKETS) {
      const incoming = stakeEv.markets && stakeEv.markets[mkt]
      if (Array.isArray(incoming) && incoming.length > 0) {
        ev.markets[mkt] = incoming
      }
    }
    updated++
  }
  if (updated > 0) setCache(sportKey, cached)
  return { ingested: updated, total: stakeEvents.length, mode: 'live' }
}

// ── route ─────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { sportKey, events, mode = 'replace', source = 'unknown' } = req.body

  if (!sportKey || typeof sportKey !== 'string') {
    return res.status(400).json({ error: 'sportKey required' })
  }
  if (!Array.isArray(events)) {
    return res.status(400).json({ error: 'events must be array' })
  }
  if (!events.length) {
    return res.json({ ok: true, ingested: 0, note: 'empty events array' })
  }

  let result
  try {
    if (mode === 'live')        result = doLive(sportKey, events)
    else if (mode === 'merge')  result = doMerge(sportKey, events)
    else                        result = doReplace(sportKey, events)
  } catch (err) {
    console.error(`[ingest] ${sportKey} ${mode} error:`, err.message)
    return res.status(500).json({ error: 'ingest failed', detail: err.message })
  }

  console.log(`[ingest] ${source} → ${sportKey} (${mode}): ${result.ingested} events`)
  res.json({ ok: true, ...result })
})

module.exports = router
