// zqBettable.js — turns ZQ (Chinese football) matches into BETTABLE events in the
// same shape as SharpAPI events, and writes them into oddsCache under ZQ league keys
// so they show as their own chips under Football and are fully bettable.
//
// Markets produced:
//   h2h : 1X2 Win/Draw/Lose  (from ZQ spf)
//   ah  : Handicap 1X2       (from ZQ rqspf — the extra market ZQ adds)
//
// Pricing: raw ZQ odds -> AI probability shift (.209 model, same as enrichment) ->
// re-apply a HOUSE overround (margin) instead of ZQ's thin book margin.
//
// Names are Chinese; translated to EN via nameMap (skip-list a match if either side
// can't translate — never show raw Chinese in a bet slip).
const zqSource = require('./zqSource')
const nameMap = require('./nameMap')
const zqLeagues = require('./zqLeagues')
const aiAdjust = require('./aiAdjust')
const { similarity } = require('./names')
const ahModel = require('./ahModel')
const { stampSeed } = require('./oddsSanity')

// fair (vig-stripped) probabilities from three decimal 1X2 odds, or null if incomplete
function fairProbs(w, d, l) {
  const o = [parseFloat(w), parseFloat(d), parseFloat(l)]
  if (o.some(x => !x || x < 1.01)) return null
  const inv = o.map(x => 1 / x)
  const sum = inv.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  return { h: inv[0] / sum, d: inv[1] / sum, a: inv[2] / sum }
}

// House target overround for ZQ markets (sum of implied probs). ~1.08 = ~7.4% margin.
const HOUSE_OVERROUND = 1.08
const AH_HOUSE_OVERROUND = 1.07
const DERIVED_OVERROUND = 1.07   // O/U, BTTS, DC, DNB — same margin family as AH

// ── build a market array from three decimal odds, restoring a house overround ──
// Takes fair-ish book odds (w/d/l), strips their vig, re-applies HOUSE margin.
function buildMarket(names, prices, targetOverround) {
  const outcomes = []
  for (let i = 0; i < names.length; i++) {
    const p = parseFloat(prices[i])
    if (!p || p < 1.01) return null   // incomplete market -> skip
    outcomes.push({ name: names[i], price: p })
  }
  // strip the book's vig -> fair probs
  const inv = outcomes.map(o => 1 / o.price)
  const sum = inv.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  const fair = inv.map(v => v / sum)
  // re-apply house overround -> our decimal odds
  for (let i = 0; i < outcomes.length; i++) {
    const implied = fair[i] * targetOverround
    outcomes[i].price = Math.max(1.01, +(1 / implied).toFixed(3))
  }
  return outcomes
}

// ── shape one reduced ZQ match into a bettable event ──
// enHome/enAway are already-translated English names. Returns null if unusable.
function shapeEvent(m, enHome, enAway) {
  const spf = m.spf || {}
  const h2h = buildMarket([enHome, 'Draw', enAway], [spf.w, spf.d, spf.l], HOUSE_OVERROUND)
  if (!h2h) return null   // no valid 1X2 -> not bettable

  const league = zqLeagues.resolveLeague(m.league, null)
  const markets = { h2h }

  // Derived markets: fit a Poisson goals model to our fair 1X2 probs ONCE, then read
  // every market off the same scoreline grid. Works on EVERY match (no extra feed).
  //   ah   : true 2-way Asian Handicap (half-ball, push-refund)
  //   totals : Over/Under total goals (main line; re-priced with AI totals_shift later)
  //   btts : Both Teams To Score (Yes/No)
  //   dc   : Double Chance (1X/12/X2)
  //   dnb  : Draw No Bet
  // ZQ's rqspf line, when present, is a calibration reference (not the price source).
  const fp = fairProbs(spf.w, spf.d, spf.l)
  const names = { home: enHome, away: enAway }
  let lH = null, lA = null
  if (fp) {
    const fit = ahModel.fitPoisson(fp.h, fp.d, fp.a)
    if (fit.lH > 0 && fit.lA > 0) {
      lH = fit.lH; lA = fit.lA
      const ah = ahModel.buildAsianHandicap(fp.h, fp.d, fp.a, AH_HOUSE_OVERROUND, names, 0.5)
      if (ah) markets.ah = ah
      const totLine = ahModel.mainTotalLine(lH, lA)
      const tot = ahModel.buildOverUnder(lH, lA, DERIVED_OVERROUND, totLine, 0)
      if (tot) markets.totals = tot
      const btts = ahModel.buildBTTS(lH, lA, DERIVED_OVERROUND)
      if (btts) markets.btts = btts
      const dc = ahModel.buildDoubleChance(fp.h, fp.d, fp.a, DERIVED_OVERROUND, names)
      if (dc) markets.dc = dc
      const dnb = ahModel.buildDrawNoBet(fp.h, fp.d, fp.a, DERIVED_OVERROUND, names)
      if (dnb) markets.dnb = dnb
      // Goals ladder (O/U 0.5–4.5) and correct scoreline grid — pure Poisson,
      // same source as the SharpAPI path; no extra feed required.
      const cs = ahModel.buildCorrectScore(lH, lA, 1.20, 4)
      if (cs && cs.length) markets.correct_score = cs
      const goals = ahModel.buildGoalsLadder(lH, lA, DERIVED_OVERROUND)
      if (goals && goals.length) markets.goals = goals
    }
  }

  // startTime: ZQ kickoff is BEIJING local time (UTC+8) — confirmed against the
  // live feed (e.g. "2026-08-20 03:00:00" listed under match_date 2026-08-19 =
  // 19:00 UTC prev day = a normal evening kickoff in the Americas). The old code
  // tagged it "Z" without converting, shifting every match +8h into the future so
  // finished games still read as "upcoming". Subtract 8h to land on true UTC ISO.
  // China has no DST, so the offset is a stable year-round constant.
  const ZQ_TZ_OFFSET_MS = 8 * 60 * 60 * 1000
  let startTime = ''
  if (m.kickoff) {
    const mm = String(m.kickoff).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/)
    if (mm) {
      const [, y, mo, d, h, mi, s] = mm
      if (h != null) {
        // Full datetime: interpret the fields as Beijing wall-clock, convert to UTC.
        const beijingAsUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))
        startTime = new Date(beijingAsUtc - ZQ_TZ_OFFSET_MS).toISOString().slice(0, 19) + 'Z'
      } else {
        // Date-only (no kickoff time in the feed): keep as a date marker. Convert the
        // Beijing calendar day's noon to UTC so it still sorts/ages sanely rather than
        // sitting at a hard midnight boundary. Downstream treats it as day-level.
        const beijingNoonAsUtc = Date.UTC(+y, +mo - 1, +d, 12, 0, 0)
        startTime = new Date(beijingNoonAsUtc - ZQ_TZ_OFFSET_MS).toISOString().slice(0, 19) + 'Z'
      }
    }
  }

  return {
    id: 'zq_' + (m.matchId || `${enHome}_${enAway}`),
    sportKey: league.key,
    homeTeam: enHome,
    awayTeam: enAway,
    startTime,
    markets,
    _source: 'zq',
    cnHome: m.cnHome,
    cnAway: m.cnAway,
    zqLeague: m.league,
    zqLeagueLabel: league.label,
    zqMatchId: m.matchId,
    // fitted Poisson means — kept so aiPriceEvent can re-price totals with totals_shift
    _lH: lH, _lA: lA,
    // evidence carried for the AI adjust step
    form: m.form,
    injuries: m.injuries,
    strength: m.strength,
    attackDefense: m.attackDefense,
    h2hStats: m.h2hStats,
  }
}

// ── AI-adjust a ZQ event in place (h2h only; ah handicap kept as-is priced) ──
// Reuses the same .209 judgment + repriceMarket used for SharpAPI matches.
async function aiPriceEvent(ev) {
  if (ev._oddsLocked) return   // admin-overridden → AI stands down until re-seed
  if (!aiAdjust.hasEvidence(ev)) return
  let j
  try { j = await aiAdjust.fetchJudgment(ev) } catch { return }
  if (!j || j.confidence < 0.4) return
  const shiftFor = (o) => {
    if (o.name === ev.homeTeam) return j.home_shift
    if (o.name === ev.awayTeam) return j.away_shift
    if (o.name === 'Draw') return j.draw_shift
    return 0
  }
  if (ev.markets.h2h && ev.markets.h2h.length >= 2) {
    // gate direction on form + reprice from the pristine seed (idempotent)
    const gated = aiAdjust.applyFormGate ? aiAdjust.applyFormGate(ev, j) : j
    const sf = (o) => {
      if (o.name === ev.homeTeam) return gated.home_shift
      if (o.name === ev.awayTeam) return gated.away_shift
      if (o.name === 'Draw') return gated.draw_shift
      return 0
    }
    aiAdjust.repriceMarket(ev.markets.h2h, sf, ev._seedH2H)
  }
  // Over/Under: re-price with the AI totals_shift (previously discarded). Rebuild from the
  // stored Poisson means at the same line so the shift nudges Over/Under honestly.
  if (ev.markets.totals && ev.markets.totals.length === 2 && ev._lH > 0 && ev._lA > 0) {
    const line = ev.markets.totals[0].point
    const tot = ahModel.buildOverUnder(ev._lH, ev._lA, DERIVED_OVERROUND, line, j.totals_shift || 0)
    if (tot) ev.markets.totals = tot
  }
  ev._aiAdjusted = true
  ev._aiConfidence = j.confidence
  ev._aiTags = j.adjustments
  ev._aiAt = new Date().toISOString()
}

// ── normalized key for SharpAPI-vs-ZQ dedup (team tokens + date) ──
function dedupKey(homeEN, awayEN, startTime) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const day = String(startTime || '').slice(0, 10)
  // order-independent so "A v B" and "B v A" collide
  const teams = [norm(homeEN), norm(awayEN)].sort().join('_')
  return `${teams}|${day}`
}

// Build a set of dedup keys already present in oddsCache (SharpAPI + prior ZQ),
// so we don't list the same match twice. getCacheRaw(sportKey)->events[].
function existingKeys(getCacheRaw, sportKeys) {
  const set = new Set()
  for (const sk of sportKeys) {
    for (const ev of (getCacheRaw(sk) || [])) {
      if (ev._source === 'zq') continue  // ignore our own prior ZQ entries when checking Sharp overlap
      set.add(dedupKey(ev.homeTeam, ev.awayTeam, ev.startTime))
    }
  }
  return set
}

// ── MAIN: fetch ZQ -> translate -> shape -> AI-price -> dedupe -> write oddsCache ──
// getCacheRaw/setCache: the oddsCache accessors. sharpSportKeys: existing SharpAPI
// league keys to dedupe against (prefer SharpAPI when a match exists in both).
// Returns { fetched, listed, leagues:[keys] }.
async function ingestZqBettable({ getCacheRaw, setCache, sharpSportKeys = [] }) {
  let matches
  try { matches = await zqSource.fetchAll({ pageSize: 200 }) }
  catch (e) { console.error('[zqbet] fetch failed:', e.message); return { fetched: 0, listed: 0, leagues: [] } }
  if (!matches.length) return { fetched: 0, listed: 0, leagues: [] }

  // translate all CN names EN in one batched pass (cached on disk)
  const cn = []
  for (const m of matches) { cn.push(m.cnHome, m.cnAway) }
  try { await nameMap.resolveNames(cn) } catch (e) { console.error('[zqbet] namemap:', e.message) }

  // dedup vs SharpAPI matches already cached
  const sharpKeys = existingKeys(getCacheRaw, sharpSportKeys)

  // group new ZQ events by their league sportKey
  const byLeague = {}
  const seen = new Set()
  let listed = 0
  for (const m of matches) {
    const enHome = nameMap.toEnglish(m.cnHome)
    const enAway = nameMap.toEnglish(m.cnAway)
    if (!enHome || !enAway) continue          // skip untranslatable (no raw CN in a slip)
    const ev = shapeEvent(m, enHome, enAway)
    if (!ev) continue
    stampSeed(ev, true)   // pristine baseline BEFORE AI prices it (idempotent reprice source)
    const dk = dedupKey(enHome, enAway, ev.startTime)
    if (sharpKeys.has(dk) || seen.has(dk)) continue   // SharpAPI wins / no dupes
    seen.add(dk)
    ;(byLeague[ev.sportKey] = byLeague[ev.sportKey] || []).push(ev)
    listed++
  }

  // AI-price each event (sequential, one .209 call each — small volume)
  for (const key of Object.keys(byLeague)) {
    for (const ev of byLeague[key]) {
      try { await aiPriceEvent(ev) } catch (e) { /* keep raw-margin price */ }
      await new Promise(r => setTimeout(r, 150))
    }
    setCache(key, byLeague[key])   // write this league's events into oddsCache
  }

  const leagues = Object.keys(byLeague)
  console.log(`[zqbet] fetched=${matches.length} listed=${listed} leagues=${leagues.length}`)
  return { fetched: matches.length, listed, leagues }
}

module.exports = { ingestZqBettable, shapeEvent, buildMarket, aiPriceEvent, dedupKey }
