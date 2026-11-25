// mobileSports.js — sportsbook read + bet placement for the web/PWA mirror.
// Mounted under /mobile (see mobile.js) with the SAME requireSession auth. This
// mirrors what the .235 resource does in Lua (api.lua getSportEvents +
// bets.lua placeBet/validateOdds) but pays against the ESCROW WALLET, never game
// cash. Settlement for these bets credits the wallet (channel='mobile'); the
// relay's payout pull skips them.
const express = require('express')
const crypto = require('crypto')
const { getPool } = require('../db')
const { getCacheRaw, setCache } = require('../oddsCache')
const { fetchOddsForSport, filterUpcoming } = require('../crons/odds')
const { SportCategories, MaxBet, VIP, getVipLevel } = require('../steakConfig')

const MIN_BET = 20
const ODDS_TOLERANCE = 0.03
const PAYOUT_CAP = 50000000

// category id -> [league keys]
const categoryLeagues = {}
for (const cat of SportCategories) categoryLeagues[cat.id] = cat.sports.map(s => s.key)

// ── live-state weighting (mirror api.lua liveState/sortWeight) ─────
function liveState(startTime, now) {
  const t = typeof startTime === 'number' ? startTime : Date.parse(startTime) / 1000
  if (!t || Number.isNaN(t)) return ['upcoming', 999999]
  const diff = t - now
  if (diff < -3.5 * 3600) return ['ended', diff]
  if (diff <= 0) return ['live', diff]
  return ['upcoming', diff]
}
function sortWeight(state, diff) {
  if (state === 'live') return -1e9 + diff       // live first
  if (state === 'upcoming') return diff           // soonest next
  return 1e9 + diff
}

function register(router, requireSession) {
  // ── GET /mobile/sports/categories ──
  router.get('/sports/categories', requireSession, (req, res) => {
    res.json({ categories: SportCategories, minBet: MIN_BET })
  })

  // ── GET /mobile/sports/events?category=&league=&limit= ──
  router.get('/sports/events', requireSession, async (req, res) => {
    try {
      const categoryId = String(req.query.category || '')
      if (!categoryLeagues[categoryId]) return res.status(400).json({ error: 'bad_category' })
      const leagueFilter = (req.query.league && req.query.league !== 'all') ? String(req.query.league) : null
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 60)
      const now = Math.floor(Date.now() / 1000)

      // cold-cache fill: fetch any missing league on-demand (parallel, bounded)
      const missing = categoryLeagues[categoryId].filter(k =>
        (!leagueFilter || k === leagueFilter) && !getCacheRaw(k))
      if (missing.length) {
        await Promise.all(missing.map(async k => {
          try {
            const ev = await fetchOddsForSport(k)
            if (ev && ev.length) setCache(k, filterUpcoming(ev))
          } catch (_) {}
        }))
      }

      const seen = new Set()
      const out = []
      for (const key of categoryLeagues[categoryId]) {
        if (leagueFilter && key !== leagueFilter) continue
        for (const ev of (getCacheRaw(key) || [])) {
          const dedup = `${ev.homeTeam || ''}|${ev.awayTeam || ''}|${ev.startTime || ''}`
          if (seen.has(dedup)) continue
          seen.add(dedup)
          const [state, diff] = liveState(ev.startTime, now)
          if (state === 'ended') continue
          out.push({
            id: ev.id, sportKey: ev.sportKey, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
            startTime: ev.startTime, markets: ev.markets, leagueKey: key, liveState: state,
            form: ev.form, xgHome: ev._lH, xgAway: ev._lA, aiTags: ev._aiTags,
            _w: sortWeight(state, diff),
          })
        }
      }
      out.sort((a, b) => a._w - b._w)
      const events = out.slice(0, limit).map(e => { const { _w, ...rest } = e; return rest })

      // per-league counts (for hiding empty leagues in the drawer)
      const leagueCounts = {}
      for (const key of categoryLeagues[categoryId]) {
        let c = 0
        for (const ev of (getCacheRaw(key) || [])) {
          if (liveState(ev.startTime, now)[0] !== 'ended') c++
        }
        leagueCounts[key] = c
      }
      res.json({ events, leagueCounts })
    } catch (e) {
      console.error('[mobile/sports/events]', e.message)
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── GET /mobile/sports/odds?sportKey= ── full odds for one league ──
  // Backs the NUI getSportOdds path: a featured/off-list match is opened and needs
  // its markets pulled. Returns every non-ended cached event for that league.
  router.get('/sports/odds', requireSession, async (req, res) => {
    try {
      const sportKey = String(req.query.sportKey || '')
      if (!sportKey) return res.status(400).json({ error: 'bad_sport' })
      if (!getCacheRaw(sportKey)) {
        try {
          const ev = await fetchOddsForSport(sportKey)
          if (ev && ev.length) setCache(sportKey, filterUpcoming(ev))
        } catch (_) {}
      }
      const now = Math.floor(Date.now() / 1000)
      const events = (getCacheRaw(sportKey) || [])
        .filter(ev => liveState(ev.startTime, now)[0] !== 'ended')
        .map(ev => ({
          id: ev.id, sportKey: ev.sportKey, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
          startTime: ev.startTime, markets: ev.markets, leagueKey: sportKey,
          liveState: liveState(ev.startTime, now)[0], form: ev.form,
          xgHome: ev._lH, xgAway: ev._lA, aiTags: ev._aiTags,
        }))
      res.json({ sportKey, events })
    } catch (e) {
      console.error('[mobile/sports/odds]', e.message)
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── validate a selection's price against the live cache (mirror validateOdds) ──
  // Returns { ok, serverPrice } — searches every cached league for the event.
  function validateOdds(eventId, market, selection, clientOdds) {
    if (!eventId || !market || !selection || !clientOdds) return { ok: false }
    for (const cat of SportCategories) {
      for (const s of cat.sports) {
        const cached = getCacheRaw(s.key)
        if (!cached) continue
        for (const ev of cached) {
          if (ev.id !== eventId) continue
          const outcomes = ev.markets && ev.markets[market]
          if (!outcomes) return { ok: false }
          for (const o of outcomes) {
            if (o.name === selection) {
              const serverPrice = o.price
              if (!serverPrice || serverPrice <= 0) return { ok: false }
              const ratio = clientOdds / serverPrice
              return { ok: ratio >= (1 - ODDS_TOLERANCE) && ratio <= (1 + ODDS_TOLERANCE), serverPrice, ev, outcome: o }
            }
          }
          return { ok: false }
        }
      }
    }
    return { ok: false }
  }

  async function playerMaxBet(pool, identifier) {
    const [[row]] = await pool.query(
      'SELECT xp, personal_max_bet FROM hk_steak_vip WHERE identifier = ?', [identifier])
    if (!row) return 10000
    const tierMax = Math.min(getVipLevel(row.xp || 0).maxBet, MaxBet)
    const pmb = row.personal_max_bet
    return (pmb && pmb < tierMax) ? pmb : tierMax
  }

  // ── POST /mobile/sports/place ── single bet against the escrow wallet ──
  // Body mirrors the resource placeBet: { eventId, market, selection, odds, stake,
  // matchDesc, commenceTime, point, zqHomeCn, zqAwayCn }.
  router.post('/sports/place', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    try {
      const b = req.body || {}
      let stake = Math.floor(Number(b.stake) || 0)
      let odds = Number(b.odds)
      if (!stake || !odds || stake < MIN_BET) return res.status(400).json({ error: 'bad_stake' })

      const maxBet = await playerMaxBet(pool, identifier)
      if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

      const v = validateOdds(b.eventId, b.market, b.selection, odds)
      if (!v.ok) return res.status(409).json({ error: 'odds_changed' })
      odds = v.serverPrice // pay on server-verified price

      // reject started matches
      let commenceDt = null
      if (b.commenceTime) {
        const c = typeof b.commenceTime === 'number' ? b.commenceTime : Date.parse(b.commenceTime) / 1000
        if (c && Math.floor(Date.now() / 1000) >= c) return res.status(409).json({ error: 'match_started' })
        if (c) commenceDt = new Date(c * 1000).toISOString().slice(0, 19).replace('T', ' ')
      }

      const potentialWin = Math.min(Math.floor(stake * odds), PAYOUT_CAP)

      // ── Placement idempotency ──────────────────────────────────────────────
      // The client generates ONE key per bet-slip submission and sends it. A
      // dropped-response retry or double-tap re-sends the SAME key. We must then
      // neither debit again nor insert a second bet. Key = the applyCash idem key
      // AND the UNIQUE debit_key on the bet row, so both money and bet are deduped.
      // Fall back to a server-minted key only if the client omitted one (older
      // build) — that path keeps the previous behaviour for a single request.
      const rawKey = String(b.idempotencyKey || '').trim().slice(0, 60)
      const idemKey = rawKey ? 'place-' + rawKey : 'place-' + crypto.randomUUID()

      // Fast replay: if this exact placement already produced a bet, return it
      // verbatim (no debit, no insert). Balance is re-read from the mirror since
      // the original debit already moved cash.
      const [[existing]] = await pool.query(
        'SELECT id, stake, odds, potential_win FROM hk_sportsbets WHERE debit_key = ? LIMIT 1', [idemKey])
      if (existing) {
        const walletMod = require('./mobile')
        const bal = await walletMod.getMirroredCash(pool, identifier)
        return res.json({ success: true, betId: existing.id, stake: existing.stake,
          odds: existing.odds, potentialWin: existing.potential_win,
          balance: bal == null ? undefined : bal, replay: true })
      }

      // Phase 3: debit REAL game cash via the relay and WAIT for confirm. The relay
      // is the only money authority; if it can't confirm (unreachable/timeout) we
      // DENY — nothing is persisted, no money moves. The idem key makes a relay
      // retry safe (relay replays its stored result instead of double-debiting).
      const walletMod = require('./mobile')
      const debit = await walletMod.applyGameCash({
        identifier, delta: -stake, reason: 'sports-bet', idempotencyKey: idemKey })
      if (!debit.ok) {
        const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
          : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
        const code = debit.error === 'insufficient_cash' ? 400 : 503
        return res.status(code).json({ error: err })
      }

      try {
        const [ins] = await pool.query(
          `INSERT INTO hk_sportsbets
             (identifier, event_id, match_desc, market, selection, odds, stake, potential_win,
              commence_time, zq_home_cn, zq_away_cn, handicap_line, channel, debit_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mobile', ?)`,
          [identifier, b.eventId, String(b.matchDesc || '').slice(0, 255), b.market || 'h2h',
           String(b.selection || '').slice(0, 64), odds, stake, potentialWin, commenceDt,
           b.zqHomeCn || null, b.zqAwayCn || null,
           (b.market === 'ah' || b.market === 'spreads' || b.market === 'totals') ? (b.point ?? null) : null,
           idemKey])
        res.json({ success: true, betId: ins.insertId, stake, odds, potentialWin, balance: debit.newCash })
      } catch (e) {
        // A UNIQUE(debit_key) collision means a concurrent request for the SAME
        // placement already inserted the bet AND owns the (single, idempotent)
        // debit. Do NOT refund here — that would claw back a bet the player has.
        // Replay the winning row instead. Any other error = genuine failure: the
        // debit is orphaned, so refund it (money must never vanish).
        if (e.code === 'ER_DUP_ENTRY') {
          const [[dup]] = await pool.query(
            'SELECT id, stake, odds, potential_win FROM hk_sportsbets WHERE debit_key = ? LIMIT 1', [idemKey])
          if (dup) {
            return res.json({ success: true, betId: dup.id, stake: dup.stake, odds: dup.odds,
              potentialWin: dup.potential_win, balance: debit.newCash, replay: true })
          }
        }
        const refund = await walletMod.applyGameCash({
          identifier, delta: stake, reason: 'sports-bet-refund', idempotencyKey: 'refund-' + idemKey })
        if (!refund.ok) console.error('[mobile/sports/place] REFUND FAILED after insert error:', identifier, stake, refund.error)
        console.error('[mobile/sports/place] insert failed, refunded:', e.message)
        res.status(500).json({ error: 'place_failed' })
      }
    } catch (e) {
      console.error('[mobile/sports/place]', e.message)
      res.status(500).json({ error: 'internal error' })
    }
  })

  // ── shared player-data endpoints (reuse the exact steak.js builders) ──
  // These back the NUI's getMyStats / getVipData / getHomeData / getLeaderboard /
  // getSettings under the Bearer session, keyed on req.identifier (never a param).
  const steak = require('./steak')
  router.get('/stats', requireSession, async (req, res) => {
    try { res.json(await steak.buildMyStats(getPool(), req.identifier)) }
    catch (e) { console.error('[mobile/stats]', e.message); res.status(500).json({ error: 'internal error' }) }
  })
  router.get('/vipdata', requireSession, async (req, res) => {
    try { res.json(await steak.buildVipData(getPool(), req.identifier)) }
    catch (e) { console.error('[mobile/vipdata]', e.message); res.status(500).json({ error: 'internal error' }) }
  })
  router.get('/home', requireSession, async (req, res) => {
    try { res.json(await steak.buildCasinoHome(getPool(), req.identifier)) }
    catch (e) { console.error('[mobile/home]', e.message); res.status(500).json({ error: 'internal error' }) }
  })
  router.get('/leaderboard', requireSession, async (req, res) => {
    try { res.json(await steak.buildLeaderboard(getPool(), req.identifier)) }
    catch (e) { console.error('[mobile/leaderboard]', e.message); res.status(500).json({ error: 'internal error' }) }
  })
  router.get('/settings', requireSession, async (req, res) => {
    try { res.json(await steak.buildSettings(getPool(), req.identifier)) }
    catch (e) { console.error('[mobile/settings]', e.message); res.status(500).json({ error: 'internal error' }) }
  })

  // ── Provably-fair (same seeds.json the in-game casino uses, keyed req.identifier) ──
  // The public /fair/* routes sit behind the x-auth-token gate; the browser can't
  // reach those, so these session-gated mirrors reuse fair.js's shared helpers.
  const fair = require('./fair')
  router.get('/fair', requireSession, (req, res) => {
    try { res.json(fair.getOrCreateSeed(req.identifier)) }
    catch (e) { console.error('[mobile/fair]', e.message); res.status(500).json({ error: 'internal error' }) }
  })
  router.post('/fair/rotate', requireSession, (req, res) => {
    try {
      const r = fair.rotateSeedFor(req.identifier)
      if (r.error) return res.status(400).json(r)
      res.json(r)
    } catch (e) { console.error('[mobile/fair/rotate]', e.message); res.status(500).json({ error: 'internal error' }) }
  })
  router.post('/fair/client-seed', requireSession, (req, res) => {
    try {
      const r = fair.setClientSeedFor(req.identifier, req.body && req.body.clientSeed)
      if (r.error) return res.status(400).json(r)
      res.json(r)
    } catch (e) { console.error('[mobile/fair/client-seed]', e.message); res.status(500).json({ error: 'internal error' }) }
  })

  // ── GET /mobile/sports/mybets ── this player's bets (mobile + ingame) ──
  router.get('/sports/mybets', requireSession, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, event_id, match_desc, market, selection, odds, stake, potential_win,
                status, payout, channel, commence_time, placed_at, settled_at
           FROM hk_sportsbets WHERE identifier = ? ORDER BY placed_at DESC LIMIT 50`,
        [req.identifier])
      res.json({ bets: rows })
    } catch (e) {
      console.error('[mobile/sports/mybets]', e.message)
      res.status(500).json({ error: 'internal error' })
    }
  })
}

module.exports = { register, liveState, sortWeight }
