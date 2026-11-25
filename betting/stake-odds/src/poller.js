// poller.js — three polling loops for stake-odds
//
// REGULAR (15 min): scrape all-sport list pages → moneyline for all upcoming fixtures
//   → pushIngest(mode=replace for basketball, mode=merge for soccer)
//
// HOT (3 min): for featured matches from engine → scrape detail pages → extended markets
//   → pushIngest(mode=merge always — adding depth on top of whatever's cached)
//
// LIVE (30–45 s): matches that have started and are within the live window → scrape detail
//   → pushIngest(mode=live — direct odds update, no AI/drift)
//
// Live matches bypass the AI pipeline intentionally — Stake live prices ARE the truth.

const { scrapeListPage } = require('./extractors/listPage')
const { scrapeDetailPage } = require('./extractors/detailPage')
const { pushIngest, fetchHotMatches } = require('./push')
const { SPORTS } = require('./sports')

const LIVE_WINDOW_MS  = 2.5 * 60 * 60 * 1000   // treat as live for 2.5h after kickoff
const REGULAR_MS      = 15 * 60 * 1000
const HOT_MS          =  3 * 60 * 1000
const LIVE_MS         = 35 * 1000               // 35s cadence (jitter keeps it ~30–45s)

// All upcoming fixtures collected from the most recent list-page scrape.
// Keyed by href. Includes _source=stake, startTime, homeTeam, awayTeam, sportKey.
const fixtureCache = new Map()

function isLive(ev) {
  const start = new Date(ev.startTime).getTime()
  const now = Date.now()
  return start <= now && (now - start) < LIVE_WINDOW_MS
}

// ── REGULAR LOOP ─────────────────────────────────────────────────────────────
let regularRunning = false

async function regularCycle() {
  if (regularRunning) { console.log('[regular] previous run active — skip'); return }
  regularRunning = true

  const sports = Object.keys(SPORTS)
  for (const sportSlug of sports) {
    const cfg = SPORTS[sportSlug]
    try {
      console.log(`[regular] scraping ${sportSlug} list page...`)
      const events = await scrapeListPage(sportSlug)

      if (!events.length) { console.log(`[regular] ${sportSlug}: 0 events — skip`); continue }

      // Cache fixture metadata for detail-page lookups
      for (const ev of events) fixtureCache.set(ev._href, ev)

      // Group events by sportKey for ingest
      const byKey = new Map()
      for (const ev of events) {
        if (!byKey.has(ev.sportKey)) byKey.set(ev.sportKey, [])
        byKey.get(ev.sportKey).push(ev)
      }

      for (const [sportKey, keyEvents] of byKey) {
        const mode = cfg.ingestMode || 'replace'
        try {
          const result = await pushIngest({ sportKey, events: keyEvents, mode })
          console.log(`[regular] ${sportKey} (${mode}): ${result.ingested} ingested`)
        } catch (e) {
          console.error(`[regular] push ${sportKey} failed: ${e.message}`)
        }
      }

      // If detailAll: also scrape detail pages for NON-live events to get full markets
      if (cfg.detailAll) {
        const upcoming = events.filter(ev => !isLive(ev))
        console.log(`[regular] ${sportSlug}: scraping ${upcoming.length} detail pages...`)
        for (const ev of upcoming) {
          try {
            const detail = await scrapeDetailPage(ev._href, sportSlug, {
              homeTeam: ev.homeTeam, awayTeam: ev.awayTeam
            })
            if (!detail || !Object.keys(detail.markets).length) continue
            // Merge detail markets into the base event and re-push
            // Always use 'merge' here — replace would wipe sibling fixtures
            const enriched = { ...ev, markets: { ...ev.markets, ...detail.markets } }
            await pushIngest({ sportKey: ev.sportKey, events: [enriched], mode: 'merge' })
          } catch (e) {
            console.warn(`[regular] detail ${ev._href}: ${e.message.slice(0, 80)}`)
          }
          // Small delay between detail page scrapes to spread proxy usage
          await new Promise(r => setTimeout(r, 4000))
        }
      }
    } catch (e) {
      console.error(`[regular] ${sportSlug} failed: ${e.message}`)
    }
  }

  regularRunning = false
}

// ── HOT LOOP ─────────────────────────────────────────────────────────────────
let hotRunning = false

async function hotCycle() {
  if (hotRunning) { console.log('[hot] previous run active — skip'); return }
  hotRunning = true

  try {
    const hotMatches = await fetchHotMatches()
    if (!hotMatches.length) { hotRunning = false; return }

    const toScrape = hotMatches.filter(m => {
      // Only scrape if we have its href in fixtureCache (means we've list-scraped it)
      const cached = [...fixtureCache.values()].find(ev =>
        ev.homeTeam === m.home && ev.awayTeam === m.away && ev.sportKey === m.sportKey
      )
      return cached && !isLive(cached)   // hot but not yet live
    })

    if (!toScrape.length) { hotRunning = false; return }
    console.log(`[hot] enriching ${toScrape.length} hot matches...`)

    for (const m of toScrape) {
      const base = [...fixtureCache.values()].find(ev =>
        ev.homeTeam === m.home && ev.awayTeam === m.away
      )
      if (!base) continue

      try {
        const sportSlug = m.sportKey.startsWith('basketball') ? 'basketball' : 'soccer'
        const detail = await scrapeDetailPage(base._href, sportSlug, {
          homeTeam: base.homeTeam, awayTeam: base.awayTeam
        })
        if (!detail || !Object.keys(detail.markets).length) continue

        const enriched = { ...base, markets: { ...base.markets, ...detail.markets } }
        await pushIngest({ sportKey: base.sportKey, events: [enriched], mode: 'merge' })
        console.log(`[hot] ${base.homeTeam} v ${base.awayTeam}: pushed ${Object.keys(detail.markets).join(', ')}`)
      } catch (e) {
        console.warn(`[hot] ${m.home}: ${e.message.slice(0, 80)}`)
      }
      await new Promise(r => setTimeout(r, 3000))
    }
  } catch (e) {
    console.error(`[hot] cycle failed: ${e.message}`)
  }

  hotRunning = false
}

// ── LIVE LOOP ─────────────────────────────────────────────────────────────────
let liveRunning = false

async function liveCycle() {
  if (liveRunning) return
  liveRunning = true

  try {
    const liveFixtures = [...fixtureCache.values()].filter(isLive)
    if (!liveFixtures.length) { liveRunning = false; return }

    console.log(`[live] updating ${liveFixtures.length} in-play fixtures`)

    for (const base of liveFixtures) {
      const sportSlug = base.sportKey.startsWith('basketball') ? 'basketball' : 'soccer'
      try {
        const detail = await scrapeDetailPage(base._href, sportSlug, {
          homeTeam: base.homeTeam, awayTeam: base.awayTeam
        })
        if (!detail) continue
        // Only push standard markets for live — engine handles them in mode=live (no AI, no drift)
        const liveMarkets = {}
        for (const k of ['h2h', 'spreads', 'totals']) {
          if (detail.markets[k]) liveMarkets[k] = detail.markets[k]
        }
        if (!Object.keys(liveMarkets).length) continue

        const ev = { ...base, markets: liveMarkets }
        await pushIngest({ sportKey: base.sportKey, events: [ev], mode: 'live' })
      } catch (e) {
        console.warn(`[live] ${base.homeTeam}: ${e.message.slice(0, 80)}`)
      }
      await new Promise(r => setTimeout(r, 2000))
    }
  } catch (e) {
    console.error(`[live] cycle failed: ${e.message}`)
  }

  liveRunning = false
}

// ── START POLLERS ─────────────────────────────────────────────────────────────
function startPollers() {
  console.log('[poller] starting — regular:15min | hot:3min | live:35s')

  // Kick off immediately then schedule
  regularCycle().catch(e => console.error('[poller] initial regular:', e.message))

  setInterval(() => regularCycle().catch(e => console.error('[regular]', e.message)), REGULAR_MS)
  setInterval(() => hotCycle().catch(e => console.error('[hot]', e.message)), HOT_MS)
  setInterval(() => liveCycle().catch(e => console.error('[live]', e.message)), LIVE_MS)
}

// Manual trigger: scrape one sport right now (used by /trigger/:sport endpoint)
async function triggerSport(sportSlug) {
  const cfg = SPORTS[sportSlug]
  if (!cfg) throw new Error('Unknown sport: ' + sportSlug)
  const events = await scrapeListPage(sportSlug)
  for (const ev of events) fixtureCache.set(ev._href, ev)
  return events
}

module.exports = { startPollers, triggerSport, fixtureCache }
