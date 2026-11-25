const cron = require('node-cron')
const { getPool } = require('../db')
const { proxyFetch } = require('../proxy')
const { getNextKey } = require('../keys')
const { similarity } = require('../names')
const zqSource = require('../zqSource')

// Parse "Home vs Away" out of a bet's match_desc (mirrors sideOf below but returns
// both names for feed-matching). Used by the name+date settlement fallback.
function descTeams(desc) {
  const [home, away] = String(desc || '').split(' vs ')
  return { home: (home || '').trim(), away: (away || '').trim() }
}

// Does this active bet correspond to this completed feed event? Primary path is an
// exact event_id === feed.id match. But bets placed with a NON-odds-api event_id
// (legacy seeds, ZQ-slug ids like "france_-_ligue_1_angers_lille_2026-08-23_b2",
// or any id-format drift) would otherwise never settle even though the feed clearly
// has the finished fixture. Fall back to team-name similarity + same-day kickoff so
// those still settle instead of hanging 'active' forever.
function betMatchesEvent(bet, event) {
  if (bet.event_id && bet.event_id === event.id) return true
  // name + date fallback
  const { home, away } = descTeams(bet.match_desc)
  if (!home || !away) return false
  // same calendar day (UTC) — guards against settling a rematch weeks later
  const betDay = bet.commence_time ? new Date(bet.commence_time).toISOString().slice(0, 10) : null
  const evDay = event.commence_time ? String(event.commence_time).slice(0, 10) : null
  if (!betDay || !evDay || betDay !== evDay) return false
  // both team names must clear a fuzzy threshold (handles "Munich"/"Munchen" etc.)
  const hSim = Math.max(similarity(home, event.home_team), similarity(home, event.away_team))
  const aSim = Math.max(similarity(away, event.home_team), similarity(away, event.away_team))
  return hSim >= 0.5 && aSim >= 0.5
}

function startSettlementCron() {
  // Check for completed matches every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[cron:settle] Checking for completed matches...')
    await settleActiveBets()
    await settleZqBets()
  })

  // Also run once on startup after 30s
  setTimeout(async () => { await settleActiveBets(); await settleZqBets() }, 30000)
  console.log('[cron:settle] Scheduled every 30 minutes')
}

// ── DEPRECATED (Phase 3): mobile-channel escrow-wallet sweep ─────────────────
// No longer called. Mobile bets now pay REAL game cash via the relay's /payouts
// pull (settled at paid_out=0, same as ingame), so there is no escrow wallet to
// credit. Kept temporarily for reference; remove in Phase 4 cleanup.
// eslint-disable-next-line no-unused-vars
async function creditMobileWallets() {
  const pool = getPool()
  if (!pool) return
  try {
    const [rows] = await pool.query(
      `SELECT id, identifier, payout FROM hk_sportsbets
        WHERE channel = 'mobile' AND status IN ('won','void')
          AND payout > 0 AND wallet_paid = 0
        ORDER BY settled_at ASC LIMIT 200`)
    if (!rows.length) return
    let paid = 0
    for (const bet of rows) {
      // atomic claim so a concurrent run can't double-credit
      const [clm] = await pool.query(
        'UPDATE hk_sportsbets SET wallet_paid = 1 WHERE id = ? AND wallet_paid = 0', [bet.id])
      if (clm.affectedRows === 0) continue
      await pool.query(
        `INSERT INTO hk_mobile_wallet (identifier, balance) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
        [bet.identifier, Number(bet.payout)])
      paid++
    }
    if (paid) console.log(`[cron:settle] credited ${paid} mobile wallet payout(s)`)
  } catch (e) {
    console.error('[cron:settle] mobile wallet sweep:', e.message)
  }
}

async function settleActiveBets() {
  const pool = getPool()
  if (!pool) return

  // Get distinct sport keys from active bets that have started
  const [activeBets] = await pool.query(`
    SELECT DISTINCT event_id, match_desc
    FROM hk_sportsbets
    WHERE status = 'active' AND commence_time IS NOT NULL AND commence_time < NOW()
  `)

  if (!activeBets.length) {
    console.log('[cron:settle] No active bets past commence time')
    return
  }

  const [allActive] = await pool.query(`
    SELECT id, event_id, match_desc, selection, market, odds, stake, potential_win, identifier, handicap_line, commence_time, channel
    FROM hk_sportsbets WHERE status = 'active' AND commence_time < NOW()
  `)

  const sportsToCheck = detectSportsFromEvents(allActive.map(b => b.event_id))

  for (const sportKey of sportsToCheck) {
    try {
      const apiKey = getNextKey('oddsApi')
      if (!apiKey) continue
      const url = `https://YOUR_ODDS_API_HOST/v4/sports/${sportKey}/scores/?apiKey=${apiKey}&daysFrom=3`
      const resp = await proxyFetch(url)
      if (!resp.ok) continue
      const scores = await resp.json()
      const completedEvents = (scores || []).filter(e => e.completed)
      for (const event of completedEvents) {
        const matchingBets = allActive.filter(b => betMatchesEvent(b, event))
        if (!matchingBets.length) continue
        const winner = determineWinner(event)
        if (!winner) continue

        for (const bet of matchingBets) {
          const outcome = evaluateBet(bet, winner, event)
          const payout = outcome === 'won' ? bet.potential_win : outcome === 'void' ? bet.stake : 0
          // Phase 3: mobile bets pay REAL cash through the relay's /payouts pull
          // (same path as ingame's normal flow), so they must settle at paid_out=0.
          // ingame here keeps the legacy inline creditPlayer path (paid_out=1).
          const paidOut = bet.channel === 'mobile' ? 0 : 1
          const [updateResult] = await pool.query(
            'UPDATE hk_sportsbets SET status = ?, payout = ?, paid_out = ?, settled_at = NOW() WHERE id = ? AND status = ?',
            [outcome, payout, paidOut, bet.id, 'active']
          )
          if (updateResult.affectedRows === 0) continue
          // ingame bets: credit game cash directly (SharpAPI path). mobile bets:
          // left at paid_out=0 for the relay payout pull to deliver real cash.
          if (payout > 0 && bet.channel !== 'mobile') await creditPlayer(pool, bet.identifier, payout, outcome)
          console.log(`[cron:settle] Bet #${bet.id} -> ${outcome} (payout: ${payout}, ${bet.channel})`)
        }
      }
      await new Promise(r => setTimeout(r, 1500))
    } catch (e) {
      console.error(`[cron:settle] Error checking ${sportKey}:`, e.message)
    }
  }
}

function determineWinner(event) {
  if (!event.scores || event.scores.length < 2) return null
  const scores = event.scores.map(s => ({ name: s.name, score: parseInt(s.score) || 0 }))
  scores.sort((a, b) => b.score - a.score)
  if (scores[0].score === scores[1].score) return { type: 'draw', teams: scores }
  return { type: 'win', winner: scores[0].name, teams: scores }
}

function evaluateBet(bet, result, event) {
  const home = event && event.home_team, away = event && event.away_team
  const teams = result.teams || []
  const scoreOf = (name) => {
    const t = teams.find(x => x.name === name)
    return t ? Number(t.score) : null
  }
  const hs = scoreOf(home), as = scoreOf(away)

  // spreads is SharpAPI-specific: each outcome carries its OWN signed point (not a
  // single home line), so settle it directly rather than via the shared home-line model.
  if (bet.market === 'spreads') {
    const pt = Number(bet.handicap_line)
    const sel = scoreOf(bet.selection)
    if (sel == null || !Number.isFinite(pt)) return 'void'
    const total = teams.reduce((s, t) => s + (Number(t.score) || 0), 0)
    const opp = total - sel
    const adj = sel + pt
    if (adj > opp) return 'won'
    if (adj < opp) return 'lost'
    return 'void'   // exact push
  }

  // h2h / totals / ah / btts / dc / dnb: shared soccer settler (same as ZQ).
  // Falls back to the winner-based h2h check when we lack per-team scores.
  if (hs == null || as == null) {
    if (bet.market === 'h2h') {
      if (result.type === 'draw' && bet.selection === 'Draw') return 'won'
      if (result.type === 'win' && bet.selection === result.winner) return 'won'
      return 'lost'
    }
    return 'void'
  }
  return settleSoccerMarket({
    market: bet.market, selection: bet.selection, line: bet.handicap_line,
    hs, as, home, away,
  })
}

async function creditPlayer(pool, identifier, amount, reason) {
  await pool.query(
    `UPDATE players SET money = JSON_SET(money, '$.cash', GREATEST(0, CAST(JSON_EXTRACT(money, '$.cash') AS SIGNED) + ?)) WHERE citizenid = ?`,
    [amount, identifier]
  )
}

function detectSportsFromEvents(eventIds) {
  return [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga',
    'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_usa_mls',
    'basketball_wnba', 'icehockey_nhl',
    'mma_mixed_martial_arts', 'boxing_boxing',
  ]
}

// ── ZQ settlement ────────────────────────────────────────────────────────────
// ZQ matches (event_id "zq_<match_id2>") aren't covered by the-odds-api. ZQ itself
// reports finished-match scores in later scrapes' history_*_recent_list. Build a
// score lookup from ZQ, settle 1X2 (h2h) + Handicap (ah), AUTO-VOID + refund a bet
// 3 days after kickoff if no result appears. Bets settled here (paid_out=0); the
// resource's /payouts pull delivers money on .235.
const ZQ_VOID_AFTER_MS = 3 * 24 * 60 * 60 * 1000

async function buildZqScoreIndex() {
  const idx = {}
  const pj = (v) => { try { return JSON.parse(v) } catch { return [] } }
  const add = (list) => {
    for (const r of (list || [])) {
      if (r.homeTeamScore == null || r.awayTeamScore == null) continue
      const day = String(r.matchDate || '').slice(0, 10)
      const h = r.homeTeamName, a = r.awayTeamName
      if (!h || !a || !day) continue
      const k = [h, a].sort().join('|') + '|' + day
      idx[k] = { [h]: +r.homeTeamScore, [a]: +r.awayTeamScore }
    }
  }
  try {
    for (const mod of zqSource.MODULES) {
      const raw = await zqSource.fetchModule(mod, { pageSize: 200 })
      for (const m of raw) {
        add(pj(m.history_home_recent_list))
        add(pj(m.history_away_recent_list))
        add(pj(m.history_h2h_list))
      }
    }
  } catch {}
  return idx
}

function matchZqScore(bet, scoreIdx) {
  const h = bet.zq_home_cn, a = bet.zq_away_cn
  if (!h || !a || !bet.commence_time) return null
  const base = new Date(bet.commence_time)
  const keyBase = [h, a].sort().join('|')
  for (const off of [0, -1, 1]) {
    const d = new Date(base.getTime() + off * 86400000).toISOString().slice(0, 10)
    const rec = scoreIdx[keyBase + '|' + d]
    if (rec && rec[h] != null && rec[a] != null) return { hs: rec[h], as: rec[a] }
  }
  return null
}

function h2hResult(hs, as) {
  if (hs > as) return 'home'
  if (hs < as) return 'away'
  return 'draw'
}
// Handicap 1X2: apply the line (goals) to the HOME score, then decide.
function ahResult(hs, as, line) {
  const adj = hs + (Number(line) || 0)
  const diff = adj - as
  const isWholeish = Math.abs(diff - Math.round(diff)) < 1e-9
  if (Math.abs(diff) < 1e-9 && isWholeish) return 'push'
  if (diff > 0) return 'home'
  if (diff < 0) return 'away'
  return 'push'
}

async function settleZqBets() {
  const pool = getPool()
  if (!pool) return
  const [bets] = await pool.query(`
    SELECT id, identifier, event_id, match_desc, market, selection, stake, potential_win,
           commence_time, zq_home_cn, zq_away_cn, handicap_line
    FROM hk_sportsbets
    WHERE status = 'active' AND event_id LIKE 'zq_%'
  `)
  if (!bets.length) return

  const now = Date.now()
  const scoreIdx = await buildZqScoreIndex()

  let settled = 0, voided = 0
  for (const bet of bets) {
    const commence = bet.commence_time ? new Date(bet.commence_time).getTime() : null
    if (commence && commence > now) continue

    const sc = matchZqScore(bet, scoreIdx)
    if (sc) {
      const outcome = evaluateZqBet(bet, sc)
      const payout = outcome === 'won' ? bet.potential_win : outcome === 'void' ? bet.stake : 0
      const [u] = await pool.query(
        'UPDATE hk_sportsbets SET status=?, payout=?, paid_out=0, settled_at=NOW() WHERE id=? AND status=?',
        [outcome === 'push' ? 'void' : outcome, payout, bet.id, 'active'])
      if (u.affectedRows > 0) {
        settled++
        console.log(`[zqsettle] #${bet.id} -> ${outcome} (${payout})`)
      }
    } else if (commence && (now - commence) > ZQ_VOID_AFTER_MS) {
      const [u] = await pool.query(
        'UPDATE hk_sportsbets SET status=?, payout=?, paid_out=0, settled_at=NOW() WHERE id=? AND status=?',
        ['void', bet.stake, bet.id, 'active'])
      if (u.affectedRows > 0) {
        voided++
        console.log(`[zqsettle] #${bet.id} -> VOID (no result 3d)`)
      }
    }
  }
  if (settled || voided) console.log(`[zqsettle] settled=${settled} voided=${voided}`)
}

function sideOf(bet) {
  const [home, away] = String(bet.match_desc || '').split(' vs ')
  return { home: (home || '').trim(), away: (away || '').trim() }
}

// Shared soccer-market settler: given final scores + team names, resolve any of the
// six football markets to won/lost/void. Used by BOTH the ZQ settler (evaluateZqBet)
// and the SharpAPI settler (evaluateBet) so derived markets settle identically no
// matter which feed the event came from. `line` = the stored handicap/total line.
function settleSoccerMarket({ market, selection, line, hs, as, home, away }) {
  if (market === 'h2h') {
    const r = h2hResult(hs, as)
    if (/^draw$/i.test(selection)) return r === 'draw' ? 'won' : 'lost'
    if (selection === home) return r === 'home' ? 'won' : 'lost'
    if (selection === away) return r === 'away' ? 'won' : 'lost'
    return 'void'
  }
  if (market === 'ah') {
    // handicap_line stored as the CLICKED side's point; normalize to the HOME line.
    const stored = line != null ? Number(line) : 0
    const tookAway = selection === away
    const homeLine = tookAway ? -stored : stored
    const r = ahResult(hs, as, homeLine)
    if (r === 'push') return 'void'
    if (selection === home) return r === 'home' ? 'won' : 'lost'
    if (tookAway) return r === 'away' ? 'won' : 'lost'
    return 'void'
  }
  // totals AND goals settle identically: over/under the stored line, push on exact.
  if (market === 'totals' || market === 'goals') {
    const l = line != null ? Number(line) : 0
    const total = hs + as
    if (Math.abs(total - l) < 1e-9) return 'void'
    const isOver = total > l
    if (/^over$/i.test(selection)) return isOver ? 'won' : 'lost'
    if (/^under$/i.test(selection)) return isOver ? 'lost' : 'won'
    return 'void'
  }
  // correct_score: selection is the literal "H-A" scoreline. Any other result loses.
  if (market === 'correct_score') {
    const actual = `${hs}-${as}`
    return selection === actual ? 'won' : 'lost'
  }
  // Half-time / HT-FT markets need a half-time score source we don't have yet.
  // Void (stake refunded) rather than mis-settle on the full-time score.
  if (market === 'htft' || market === 'ht_totals' || market === 'ht_ah' || market === 'ht_goals') {
    return 'void'
  }
  if (market === 'btts') {
    const yes = hs >= 1 && as >= 1
    if (/^yes$/i.test(selection)) return yes ? 'won' : 'lost'
    if (/^no$/i.test(selection)) return yes ? 'lost' : 'won'
    return 'void'
  }
  if (market === 'dc') {
    const r = h2hResult(hs, as)
    const sel = String(selection || '')
    const covers = new Set()
    if (sel === `${home} or Draw`) { covers.add('home'); covers.add('draw') }
    else if (sel === `${home} or ${away}`) { covers.add('home'); covers.add('away') }
    else if (sel === `Draw or ${away}`) { covers.add('draw'); covers.add('away') }
    else return 'void'
    return covers.has(r) ? 'won' : 'lost'
  }
  if (market === 'dnb') {
    const r = h2hResult(hs, as)
    if (r === 'draw') return 'void'
    if (selection === home) return r === 'home' ? 'won' : 'lost'
    if (selection === away) return r === 'away' ? 'won' : 'lost'
    return 'void'
  }
  return 'void'
}

function evaluateZqBet(bet, sc) {
  const { home, away } = sideOf(bet)
  return settleSoccerMarket({
    market: bet.market, selection: bet.selection, line: bet.handicap_line,
    hs: sc.hs, as: sc.as, home, away,
  })
}

module.exports = { startSettlementCron }
