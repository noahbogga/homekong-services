const cron = require('node-cron')
const { proxyFetch } = require('../proxy')
const { getNextKey, loadKeys } = require('../keys')
const { setCache, getCache, getCacheRaw, getCachedSports } = require('../oddsCache')
const { runAiAdjust } = require('../aiAdjust')
const { runEnrichment } = require('../enrich')
const { ingestZqBettable } = require('../zqBettable')
const { nearestSide, isDraw } = require('../names')
const { deriveFromH2H } = require('../deriveMarkets')
const { sanitizeH2H, stampSeed } = require('../oddsSanity')

// Derived markets (AH/BTTS/DC/DNB) only make sense for soccer (need a 3-way h2h).
// SharpAPI soccer keys are all prefixed "soccer_".
function isSoccer(sportKey) {
  return typeof sportKey === 'string' && sportKey.startsWith('soccer_')
}

// Markets computed purely from the h2h via the Poisson model (no independent feed).
// They must be RE-DERIVED after drift, never drifted on their own, or they'd de-cohere
// from the win market. (totals/spreads have real feed bases and drift normally.)
const SYNTHETIC_MARKETS = new Set(['ah', 'btts', 'dc', 'dnb', 'correct_score', 'goals'])

// median of a numeric array (used to aggregate one outcome's price across the
// many sportsbook lines SharpAPI returns for the same market/selection)
function median(nums) {
  const a = nums.filter(n => n != null && n > 0).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

function parseMarkets(bookmakers) {
  if (!bookmakers || !bookmakers.length) return {}
  const markets = {}
  const book = bookmakers[0]
  for (const market of (book.markets || [])) {
    markets[market.key] = (market.outcomes || []).map(o => ({
      name: o.name,
      price: o.price,
      point: o.point,
    }))
  }
  return markets
}

// ─── SharpAPI config ───────────────────────────────────────────
const SHARP_BASE = 'https://YOUR_SHARPAPI_HOST/api/v1/odds'
const SHARP_LEAGUE_MAP = {
  soccer_epl: 'epl',
  soccer_spain_la_liga: 'la_liga',
  soccer_germany_bundesliga: 'bundesliga',
  soccer_italy_serie_a: 'serie_a',
  soccer_france_ligue_one: 'ligue_1',
  soccer_usa_mls: 'mls',
  soccer_efl_champ: 'championship',
  basketball_nba: 'nba',
  basketball_wnba: 'wnba',
  icehockey_nhl: 'nhl',
  mma_mixed_martial_arts: 'ufc',
  boxing_boxing: 'boxing',
}

let sharpKeyIdx = 0
function getNextSharpKey() {
  const keys = loadKeys()
  const pool = keys.sharpApi || []
  if (!pool.length) return null
  const k = pool[sharpKeyIdx % pool.length]
  sharpKeyIdx++
  return k
}

// ─── Fetch from SharpAPI ───────────────────────────────────────
async function fetchFromSharp(sportKey) {
  const league = SHARP_LEAGUE_MAP[sportKey]
  if (!league) return null

  const key = getNextSharpKey()
  if (!key) return null

  const url = SHARP_BASE + '?league=' + league + '&limit=200'
  const resp = await proxyFetch(url, { headers: { 'X-API-Key': key } })
  if (resp.status === 429 || !resp.ok) return null

  const raw = await resp.json()
  const lines = raw.data || []
  if (!lines.length) return null

  const eventMap = new Map()
  for (const line of lines) {
    if (!line.away_team || line.away_team === '') continue
    if (!line.event_id) continue
    if (!eventMap.has(line.event_id)) {
      eventMap.set(line.event_id, {
        id: line.event_id, sportKey,
        homeTeam: line.home_team, awayTeam: line.away_team,
        startTime: line.event_start_time, marketsRaw: [],
      })
    }
    eventMap.get(line.event_id).marketsRaw.push(line)
  }

  const events = []
  for (const [, ev] of eventMap) {
    // SharpAPI returns one line PER SPORTSBOOK, so each real outcome appears many
    // times (with slightly different names, e.g. "Bayern Munich"/"Bayern Munchen").
    // Bucket lines onto canonical outcomes, then take the MEDIAN price per bucket
    // so each market has exactly one entry per outcome and a sane single overround.
    const buckets = { h2h: new Map(), spreads: new Map(), totals: new Map() }

    const addPrice = (map, key, name, price, point) => {
      if (price == null) return
      if (!map.has(key)) map.set(key, { name, point, prices: [] })
      map.get(key).prices.push(price)
    }

    for (const line of ev.marketsRaw) {
      const mt = (line.market_type || '').toLowerCase()
      const price = line.odds_decimal
      if (mt === 'moneyline' || mt === 'h2h' || mt === 'winner') {
        // canonical bucket: home / draw / away (by fuzzy match to the event's teams)
        let side
        if (isDraw(line.selection)) side = 'Draw'
        else {
          const s = nearestSide(line.selection, ev.homeTeam, ev.awayTeam)
          side = s === 'home' ? ev.homeTeam : s === 'away' ? ev.awayTeam : null
        }
        if (side) addPrice(buckets.h2h, side, side, price)
      } else if (mt === 'spread' || mt === 'handicap') {
        const s = nearestSide(line.selection, ev.homeTeam, ev.awayTeam)
        const side = s === 'home' ? ev.homeTeam : s === 'away' ? ev.awayTeam : null
        if (side) addPrice(buckets.spreads, side + '|' + line.line, side, price, line.line)
      } else if (mt === 'total' || mt === 'over_under' || mt === 'totals') {
        const isOver = /over/i.test(line.selection)
        const isUnder = /under/i.test(line.selection)
        const label = isOver ? 'Over' : isUnder ? 'Under' : null
        if (label) addPrice(buckets.totals, label + '|' + line.line, label, price, line.line)
      }
    }

    const collapse = (map) =>
      [...map.values()]
        .map(b => ({ name: b.name, price: median(b.prices), ...(b.point != null ? { point: b.point } : {}) }))
        .filter(o => o.price != null)

    const markets = {}
    const h2h = collapse(buckets.h2h)
    const spreads = collapse(buckets.spreads)
    const totals = collapse(buckets.totals)
    // For totals/spreads keep only the most-quoted line (main line) to avoid a
    // market with mixed points; pick the point with the most contributing books.
    if (h2h.length > 0) markets.h2h = h2h
    if (spreads.length > 0) markets.spreads = mainLineOnly(buckets.spreads, spreads)
    if (totals.length > 0) markets.totals = mainLineOnly(buckets.totals, totals)

    // Derive the extra soccer markets (Asian Handicap, BTTS, Double Chance, Draw No
    // Bet, and O/U when the feed lacks it) from the same Poisson model the ZQ feed
    // uses — so main-league (SharpAPI) matches offer the full set, not just h2h.
    // Only for soccer (needs a 3-way h2h with a Draw); other sports keep their raw feed.
    let derivedMeans = null
    if (isSoccer(sportKey) && markets.h2h && markets.h2h.length >= 3) {
      const { markets: derived, lH, lA } =
        deriveFromH2H(markets.h2h, ev.homeTeam, ev.awayTeam, { hasTotals: totals.length > 0 })
      Object.assign(markets, derived)
      if (lH > 0 && lA > 0) derivedMeans = { _lH: lH, _lA: lA }   // for later AI totals re-price
    }

    if (Object.keys(markets).length > 0) {
      const event = { id: ev.id, sportKey, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, startTime: ev.startTime, markets }
      if (derivedMeans) Object.assign(event, derivedMeans)   // _lH/_lA on the EVENT, not markets
      stampSeed(event, true)   // pristine raw-feed h2h baseline (fresh fetch → force)
      events.push(event)
    }
  }
  return events.length > 0 ? events : null
}

// From a keyed bucket map ("side|point"), keep only outcomes on the single most
// widely quoted point (the main line), so totals/spreads form a clean 2-way market.
function mainLineOnly(bucketMap, collapsed) {
  // tally contributing lines per point
  const byPoint = new Map()
  for (const b of bucketMap.values()) {
    const p = b.point
    byPoint.set(p, (byPoint.get(p) || 0) + b.prices.length)
  }
  if (byPoint.size <= 1) return collapsed
  let bestPoint = null, bestCount = -1
  for (const [p, c] of byPoint) if (c > bestCount) { bestCount = c; bestPoint = p }
  return collapsed.filter(o => o.point === bestPoint)
}

// ─── Fetch from the-odds-api (daily seed) ─────────────────────
async function fetchFromOddsApi(sportKey) {
  const apiKey = getNextKey('oddsApi')
  if (!apiKey) return null

  const url = 'https://YOUR_ODDS_API_HOST/v4/sports/' + sportKey + '/odds/?apiKey=' + apiKey + '&regions=us,uk&markets=h2h,spreads,totals&oddsFormat=decimal'
  const resp = await proxyFetch(url)
  if (!resp.ok) return null

  const remaining = resp.headers.get('x-requests-remaining')
  const data = await resp.json()
  const events = (data || []).map(ev => {
    const markets = parseMarkets(ev.bookmakers)
    const event = {
      id: ev.id, sportKey,
      homeTeam: ev.home_team, awayTeam: ev.away_team,
      startTime: ev.commence_time,
      markets,
    }
    // Same Poisson derivation as the SharpAPI path so odds-api-sourced soccer
    // (e.g. K-League) also offers AH/BTTS/DC/DNB, not just h2h.
    if (isSoccer(sportKey) && markets.h2h && markets.h2h.length >= 3) {
      const { markets: derived, lH, lA } =
        deriveFromH2H(markets.h2h, ev.home_team, ev.away_team, { hasTotals: !!(markets.totals && markets.totals.length) })
      Object.assign(markets, derived)
      if (lH > 0 && lA > 0) { event._lH = lH; event._lA = lA }
    }
    stampSeed(event, true)   // pristine raw-feed h2h baseline (fresh fetch → force)
    return event
  })
  console.log('[seed] ' + sportKey + ': ' + events.length + ' events (key remaining=' + remaining + ')')
  return events.length > 0 ? events : null
}

// ─── Combined fetch (SharpAPI first, odds-api fallback) ───────
async function fetchOddsForSport(sportKey) {
  try {
    const events = await fetchFromSharp(sportKey)
    if (events) return events
  } catch (e) {}
  try {
    return await fetchFromOddsApi(sportKey)
  } catch (e) { return null }
}

// ─── DRIFT ENGINE ─────────────────────────────────────────────
// Nudge cached odds every 5 min to simulate live market movement
// Uses seeded PRNG for consistency, mean-reverts toward original

const baseOdds = {} // stores original seeded odds per sport

function storeBaseOdds(sportKey, events) {
  baseOdds[sportKey] = {}
  for (const ev of events) {
    baseOdds[sportKey][ev.id] = {}
    for (const [mkt, outcomes] of Object.entries(ev.markets)) {
      baseOdds[sportKey][ev.id][mkt] = outcomes.map(o => ({ ...o }))
    }
  }
}

// ─── AI ANCHOR ────────────────────────────────────────────────
// After AI adjusts a match, snapshot its odds here. Drift then mean-reverts
// toward this anchor instead of the raw seed, so AI adjustments persist through
// the 5-min drift cycle. A re-seed (daily/validate) clears the sport's anchor
// so fresh market data wins again.
const aiAnchor = {} // aiAnchor[sportKey][eventId][market] = [{name,price},...]

function storeAiAnchor(sportKey, events) {
  aiAnchor[sportKey] = aiAnchor[sportKey] || {}
  for (const ev of events) {
    if (!ev._aiAdjusted) continue
    aiAnchor[sportKey][ev.id] = {}
    for (const [mkt, outcomes] of Object.entries(ev.markets)) {
      aiAnchor[sportKey][ev.id][mkt] = outcomes.map(o => ({ ...o }))
    }
  }
}

function clearAiAnchor(sportKey) { delete aiAnchor[sportKey] }

// Point ONE event's drift seed + AI anchor at its current markets. Used by the admin
// odds override so drift (which mean-reverts toward these) holds the manual line instead
// of pulling it back to the old raw-feed seed. Snapshots every market on the event.
function anchorEventToCurrent(sportKey, ev) {
  baseOdds[sportKey] = baseOdds[sportKey] || {}
  aiAnchor[sportKey] = aiAnchor[sportKey] || {}
  const snap = {}
  for (const [mkt, outcomes] of Object.entries(ev.markets || {})) {
    snap[mkt] = outcomes.map(o => ({ ...o }))
  }
  baseOdds[sportKey][ev.id] = snap
  // deep-copy again so the two stores don't alias
  aiAnchor[sportKey][ev.id] = Object.fromEntries(
    Object.entries(snap).map(([m, arr]) => [m, arr.map(o => ({ ...o }))])
  )
}

// Pick the drift target for one event's market: AI anchor if present, else seed.
function driftBaseFor(sportKey, evId, mkt) {
  const a = aiAnchor[sportKey] && aiAnchor[sportKey][evId] && aiAnchor[sportKey][evId][mkt]
  if (a) return a
  return baseOdds[sportKey] && baseOdds[sportKey][evId] && baseOdds[sportKey][evId][mkt]
}

function driftPrice(current, base) {
  // Drift ±0.5-2% with 60% mean reversion toward base
  const maxDrift = 0.02
  const reversion = 0.6
  const noise = (Math.random() - 0.5) * 2 * maxDrift * base
  const pull = (base - current) * reversion * 0.1
  let newPrice = current + noise + pull
  // Clamp: never below 1.01, never more than 30% from base
  newPrice = Math.max(1.01, newPrice)
  newPrice = Math.min(base * 1.3, Math.max(base * 0.7, newPrice))
  return Math.round(newPrice * 1000) / 1000
}

// keep matches until ~3h after kickoff (covers the in-play window), then drop as stale.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000

function applyDrift(sportKey) {
  let cached = getCacheRaw(sportKey)
  if (!cached) return

  const now = Date.now()

  // Prune truly-finished matches (>3h past kickoff) so stale games don't linger in
  // the cache for days during off-season. Keeps just-started (live-window) matches.
  // This runs even if there's no baseOdds (drift seed) for the sport.
  const before = cached.length
  cached = cached.filter(ev => {
    const start = new Date(ev.startTime).getTime()
    return isNaN(start) || start > (now - STALE_AFTER_MS)
  })
  const pruned = before - cached.length
  if (pruned > 0) { setCache(sportKey, cached); console.log(`[drift] pruned ${pruned} stale from ${sportKey}`) }

  // Backfill derived markets for any soccer event that has valid h2h but is missing
  // the full set (e.g. cache entries seeded before the derivation code shipped). This
  // runs even without a drift seed, so stale keys self-heal without a refetch. Only
  // fills ABSENT markets — never overwrites live drifted values (that's the loop below).
  if (isSoccer(sportKey)) {
    let backfilled = 0
    for (const ev of cached) {
      const h2h = ev.markets && ev.markets.h2h
      if (!Array.isArray(h2h) || h2h.length < 3) continue
      const hasTotals = !!(ev.markets.totals && ev.markets.totals.length)
      const needs = [...SYNTHETIC_MARKETS, ...(hasTotals ? [] : ['totals'])]
        .some(k => !ev.markets[k] || ev.markets[k].length === 0)
      if (!needs) continue
      const { markets: derived, lH, lA } =
        deriveFromH2H(h2h, ev.homeTeam, ev.awayTeam, { hasTotals })
      for (const [k, v] of Object.entries(derived)) {
        if (!ev.markets[k] || ev.markets[k].length === 0) ev.markets[k] = v
      }
      if (lH > 0 && lA > 0) { ev._lH = lH; ev._lA = lA }
      backfilled++
    }
    if (backfilled > 0) { setCache(sportKey, cached); console.log(`[drift] backfilled derived markets on ${backfilled} ${sportKey} events`) }
  }

  if (!baseOdds[sportKey]) {
    // No drift seed → no price drift, but STILL run the sanity heal so no-seed sports
    // (and already-started frozen matches) get the absolute floor enforced.
    sanityHeal(sportKey, cached)
    return
  }

  for (const ev of cached) {
    // Skip drift for matches that already started (odds frozen at kickoff)
    if (new Date(ev.startTime).getTime() < now) continue

    if (!baseOdds[sportKey][ev.id]) continue

    for (const [mkt, outcomes] of Object.entries(ev.markets)) {
      if (SYNTHETIC_MARKETS.has(mkt)) continue   // re-derived below from drifted h2h
      const mktBases = driftBaseFor(sportKey, ev.id, mkt)  // AI anchor if set, else seed
      if (!mktBases) continue
      for (let i = 0; i < outcomes.length; i++) {
        if (mktBases[i]) {
          outcomes[i].price = driftPrice(outcomes[i].price, mktBases[i].price)
        }
      }
    }

    // Re-derive the pure-synthetic soccer markets (AH/BTTS/DC/DNB) from the freshly
    // drifted h2h so they never de-cohere from the win market (no internal arb).
    // totals/spreads have their own feed base and drift normally above.
    if (isSoccer(sportKey) && ev.markets.h2h && ev.markets.h2h.length >= 3) {
      const { markets: rederived, lH, lA } =
        deriveFromH2H(ev.markets.h2h, ev.homeTeam, ev.awayTeam, { hasTotals: true })
      for (const k of SYNTHETIC_MARKETS) {
        if (rederived[k]) ev.markets[k] = rederived[k]
      }
      if (lH > 0 && lA > 0) { ev._lH = lH; ev._lA = lA }
    }
  }

  // Sanity heal runs LAST — after drift — so the clamp is the final word on every price
  // and drift can never re-inflate a line past the floor this cycle.
  sanityHeal(sportKey, cached)

  // Save drifted values (don't overwrite baseOdds)
  setCache(sportKey, cached)
}

// Clamp every soccer h2h in `cached` back into a sane band around its seed (and an
// absolute implied-prob floor), re-derive the synthetic markets from the healed win
// market, and — crucially — REFRESH the drift seed to the healed line so a poisoned
// seed (e.g. one loaded from a disk cache written before this fix) stops pulling the
// price back to insane odds on the next tick. Mutates `cached` in place; caller saves.
function sanityHeal(sportKey, cached) {
  if (!isSoccer(sportKey)) return
  let healed = 0
  for (const ev of cached) {
    const h2h = ev.markets && ev.markets.h2h
    if (!Array.isArray(h2h) || h2h.length < 2) continue
    // Prefer the pristine raw-feed seed (_seedH2H) as the clamp anchor; fall back to the
    // drift seed only if no pristine baseline exists (legacy cache entries).
    const seed = ev._seedH2H
      || (baseOdds[sportKey] && baseOdds[sportKey][ev.id] && baseOdds[sportKey][ev.id].h2h)
    if (!sanitizeH2H(h2h, seed)) continue
    healed++
    if (h2h.length >= 3) {
      const { markets: rederived, lH, lA } =
        deriveFromH2H(h2h, ev.homeTeam, ev.awayTeam, { hasTotals: !!(ev.markets.totals && ev.markets.totals.length) })
      for (const k of SYNTHETIC_MARKETS) if (rederived[k]) ev.markets[k] = rederived[k]
      if (lH > 0 && lA > 0) { ev._lH = lH; ev._lA = lA }
    }
    // Re-anchor the h2h drift seed to the healed line so drift mean-reverts to a SANE
    // base, not the poisoned one. Only touches h2h; other markets keep their seed.
    if (baseOdds[sportKey] && baseOdds[sportKey][ev.id]) {
      baseOdds[sportKey][ev.id].h2h = h2h.map(o => ({ ...o }))
    }
  }
  if (healed > 0) console.log(`[drift] sanity-healed ${healed} ${sportKey} h2h line(s)`)
}

// ─── Filter: upcoming matches within the schedule window, plus just-started ───
// 7 days was too short — season openers (e.g. EPL late Aug, NHL Oct) fell outside
// it and showed as empty. Widened to 45 days. Also keep matches up to 3h after
// kickoff so the live-window still displays them (aligns with the drift prune).
function filterUpcoming(events) {
  const now = Date.now()
  const cutoff = now + 45 * 24 * 60 * 60 * 1000
  const liveGrace = 3 * 60 * 60 * 1000
  return events.filter(ev => {
    const start = new Date(ev.startTime).getTime()
    if (isNaN(start)) return false
    return start > (now - liveGrace) && start < cutoff
  })
}

// ─── CRON SETUP ───────────────────────────────────────────────
function startOddsCron() {
  const sports = Object.keys(SHARP_LEAGUE_MAP)

  // Daily seed: fetch all sports once
  async function dailySeed() {
    console.log('[seed] Daily seed starting (' + sports.length + ' sports)...')
    let updated = 0
    for (const sport of sports) {
      try {
        const events = await fetchOddsForSport(sport)
        if (events && events.length > 0) {
          const upcoming = filterUpcoming(events)
          if (upcoming.length > 0) {
            setCache(sport, upcoming)
            storeBaseOdds(sport, upcoming)
            clearAiAnchor(sport)   // fresh market data resets AI adjustments
            updated++
          }
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 6000))
    }
    console.log('[seed] Done (' + updated + '/' + sports.length + ' seeded)')
  }

  // Drift: nudge all cached odds
  function driftAll() {
    // Run over the union of SHARP_LEAGUE_MAP sports AND anything cached (incl. legacy
    // brazil/korea/china) so stale-pruning covers every cached sport, not just drifted ones.
    const all = [...new Set([...sports, ...getCachedSports()])]
    let drifted = 0
    for (const sport of all) {
      applyDrift(sport)   // prunes stale always; drifts prices only if baseOdds exists
      if (baseOdds[sport]) drifted++
    }
    if (drifted > 0) console.log('[drift] Nudged ' + drifted + ' sports')
  }

  // Validation: check 2 sports against SharpAPI to detect stale data
  let validationIdx = 0
  async function validate() {
    const sport = sports[validationIdx % sports.length]
    validationIdx++
    try {
      const fresh = await fetchFromSharp(sport)
      if (fresh && fresh.length > 0) {
        // If we got fresh data and it has more events, re-seed that sport
        const cached = getCacheRaw(sport)
        if (!cached || fresh.length > (cached.length || 0)) {
          const upcoming = filterUpcoming(fresh)
          if (upcoming.length > 0) {
            setCache(sport, upcoming)
            storeBaseOdds(sport, upcoming)
            clearAiAnchor(sport)   // fresh market data resets AI adjustments
            console.log('[validate] ' + sport + ' re-seeded (' + upcoming.length + ' events)')
          }
        }
      }
    } catch (e) {}
  }

  // On startup: init baseOdds from disk cache, seed only if mostly empty
  setTimeout(async () => {
    let loaded = 0
    for (const sport of sports) {
      const cached = getCacheRaw(sport)
      if (cached && cached.length > 0) {
        storeBaseOdds(sport, cached)
        loaded++
      }
    }
    if (loaded >= 3) {
      console.log('[seed] Cache warm (' + loaded + ' sports from disk), skipping seed')
    } else {
      await dailySeed()
    }
  }, 3000)

  // AI adjust: send evidence-bearing matches to the local model (.209) and
  // apply probability-shift judgments. Re-anchors drift so changes persist.
  // No-op for events without form/injury data (no GPU call made).
  let aiRunning = false
  async function aiAdjustAll() {
    if (aiRunning) { console.log('[ai] previous run still active, skip'); return }
    aiRunning = true
    try {
      // Cover the union of fetch-source sports AND anything actually in cache
      // (legacy seeds like brazil/korea/china aren't in SHARP_LEAGUE_MAP but
      // still hold live events that can carry evidence).
      const activeSports = [...new Set([...sports, ...getCachedSports()])]
      // Attach fresh form/injury evidence BEFORE the model reads the cache, so a
      // no-evidence event becomes a real GPU call this cycle.
      try {
        await runEnrichment({ sports: activeSports, getCacheRaw, setCache })
      } catch (e) {
        console.error('[enrich] run failed:', e.message)
      }
      await runAiAdjust({
        sports: activeSports,
        getCacheRaw,
        setCache,
        onAdjusted: (sportKey, events) => storeAiAnchor(sportKey, events),
      })
    } catch (e) {
      console.error('[ai] run failed:', e.message)
    } finally {
      aiRunning = false
    }
  }

  // ZQ bettable ingestion: pull ZQ football matches, translate, AI-price, dedupe vs
  // SharpAPI, write into oddsCache under ZQ league keys (their own Football chips).
  let zqRunning = false
  async function zqIngestAll() {
    if (zqRunning) { console.log('[zqbet] previous run active, skip'); return }
    zqRunning = true
    try {
      await ingestZqBettable({ getCacheRaw, setCache, sharpSportKeys: sports })
    } catch (e) {
      console.error('[zqbet] run failed:', e.message)
    } finally {
      zqRunning = false
    }
  }

  // Daily seed at 06:00 server time
  cron.schedule('0 6 * * *', dailySeed)

  // Drift every 5 minutes
  cron.schedule('*/5 * * * *', driftAll)

  // Validate 1 sport every 30 min via SharpAPI
  cron.schedule('*/30 * * * *', validate)

  // ZQ bettable ingest every 15 min (at :05 and :35 — before the :15/:45 AI adjust
  // so freshly-listed ZQ matches also get enrichment/re-adjust that cycle)
  cron.schedule('5,35 * * * *', zqIngestAll)
  // and once shortly after startup
  setTimeout(zqIngestAll, 20000)

  // AI adjust every 30 min, offset from validate (runs at :15 and :45)
  cron.schedule('15,45 * * * *', aiAdjustAll)

  console.log('[cron] Schedule: seed@06:00, drift@*/5min, validate@*/30min, zq-ingest@:05/:35, ai-adjust@:15/:45')
}

module.exports = { startOddsCron, fetchOddsForSport, filterUpcoming, storeBaseOdds, clearAiAnchor, anchorEventToCurrent }
