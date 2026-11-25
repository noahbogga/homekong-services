// mobileCasino.js — web/PWA instant-casino bridge. Mounted under /mobile with the
// SAME requireSession auth as mobileSports. In-game, the relay (casino.lua) does the
// cash moves and calls the engine's /casino/* game logic. On web there is no relay
// in the loop, so THIS module owns the money too: it debits/credits REAL game cash
// via applyGameCash (the guaranteed-sync path, same as sports/place) and drives the
// existing engine game endpoints for the outcome.
//
// Scope (Phase 2a): INSTANT games only — mines, dice, chicken, plinko. Realtime
// games (crash, blackjack, mahjong) need live table streaming and are a later phase.
//
// Money safety mirrors sports/place:
//   • debit BEFORE the outcome; if the engine logic call fails, REFUND.
//   • every applyGameCash carries an idempotency key so a relay retry replays the
//     stored result instead of moving cash twice.
//   • payouts are credited exactly once, keyed per game round.
const crypto = require('crypto')
const { getPool } = require('../db')
const { MaxBet, VIP, getVipLevel } = require('../steakConfig')

const MIN_BET = 20
const PAYOUT_CAP = 50000000

// Per-game minimums (mirror config.lua Config.Casino.*.minBet; default MIN_BET).
const GAME_MIN = { mines: 20, dice: 20, chicken: 20, plinko: 20 }

function register(router, requireSession) {
  const casino = require('./casino')
  const seedStore = require('../seeds')
  const wallet = () => require('./mobile')


  async function playerMaxBet(pool, identifier) {
    const [[row]] = await pool.query(
      'SELECT xp, personal_max_bet FROM hk_steak_vip WHERE identifier = ?', [identifier])
    if (!row) return 10000
    const tierMax = Math.min(getVipLevel(row.xp || 0).maxBet, MaxBet)
    const pmb = row.personal_max_bet
    return (pmb && pmb < tierMax) ? pmb : tierMax
  }

  // Fire-and-forget: record the bet + grant XP. Never blocks the money path; a
  // failure here only costs stats, not cash. Matches the in-game casino.lua record.
  function recordAndXp({ identifier, game, stake, multiplier, payout, won, seed, nonce }) {
    const pool = getPool()
    pool.query(
      `INSERT INTO hk_casinobets (identifier, game, stake, multiplier, payout, won, seed, nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [identifier, String(game).slice(0, 32), stake, multiplier || 0, payout || 0,
       won ? 1 : 0, (seed || '').slice(0, 128), nonce || 0]
    ).catch(e => console.error('[mobileCasino record]', e.message))
    const xpGain = Math.floor(stake || 0)
    pool.query(`
      INSERT INTO hk_steak_vip (identifier, xp, total_wagered_casino, total_won_casino, casino_bets_count, biggest_win)
      VALUES (?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE
        xp = xp + ?, total_wagered_casino = total_wagered_casino + ?,
        total_won_casino = total_won_casino + ?, casino_bets_count = casino_bets_count + 1,
        biggest_win = GREATEST(biggest_win, ?)`,
      [identifier, xpGain, stake || 0, payout || 0, payout || 0, xpGain, stake || 0, payout || 0, payout || 0]
    ).catch(e => console.error('[mobileCasino xp]', e.message))
  }

  // Restore an in-progress round after a page reload OR when re-entering a game the
  // player left without finishing. The engine holds all of this even with the tab
  // closed. Returns { active, games:[...] } — one entry per game the player has a
  // live round/seat in. Instant games (mines/chicken/crash) carry full restore
  // fields; live tables (blackjack/mahjong) carry the room/lobby to rejoin.
  router.get('/casino/active', requireSession, (req, res) => {
    const identifier = req.identifier
    const games = []

    const mines = casino.peekActiveGame(identifier, 'mines')
    if (mines) {
      games.push({ game: 'mines',
        stake: mines.stake, numMines: mines.numMines,
        revealCount: mines.revealCount || 0,
        revealedTiles: [...(mines.revealed || [])],
        multiplier: casino.calcMinesMultiplier(mines.numMines, mines.revealCount || 0),
      })
    }
    const chicken = casino.peekActiveGame(identifier, 'chicken')
    if (chicken) {
      games.push({ game: 'chicken',
        stake: chicken.stake, cols: chicken.cols || 4,
        currentRow: chicken.currentRow || 0,
      })
    }
    // Web crash: a live bet in the current shared round.
    const crashBet = casino.peekWebCrashBet && casino.peekWebCrashBet(identifier)
    if (crashBet) games.push({ game: 'crash', ...crashBet })

    // Live table games — just enough to rejoin the exact room/lobby.
    try {
      const bj = require('./blackjack')
      const s = bj.peekSeat && bj.peekSeat(identifier)
      if (s) games.push({ game: 'blackjack', room: s.room, seat: s.seat, behind: s.behind, state: s.state })
    } catch (e) { console.error('[casino/active] blackjack:', e.message) }
    try {
      const mj = require('./mahjong')
      const s = mj.peekSeat && mj.peekSeat(identifier)
      if (s) games.push({ game: 'mahjong', lobby: s.lobby, seat: s.seat, style: s.style, state: s.state, name: s.name, stack: s.stack })
    } catch (e) { console.error('[casino/active] mahjong:', e.message) }

    res.json({ active: games.length > 0, games })
  })

  // ── MAHJONG (web read-only resume/watch) ───────────────────────────────────
  // Web mahjong is view-only for now — the buy-in/cash-out/rake money layer lives
  // in-game (relay). These serve the browser + a viewer-scoped table stream so a
  // player who left a table without clicking Leave can resume and watch their seat.
  // state is gated to lobbies the caller is actually seated at (webState checks).
  router.get('/casino/mj/styles', requireSession, (req, res) => {
    try { res.json(require('./mahjong').webStyles()) }
    catch (e) { console.error('[mj/styles]', e.message); res.status(500).json({ error: 'internal' }) }
  })
  router.get('/casino/mj/lobbies', requireSession, (req, res) => {
    try { res.json(require('./mahjong').webLobbies()) }
    catch (e) { console.error('[mj/lobbies]', e.message); res.status(500).json({ error: 'internal' }) }
  })
  router.get('/casino/mj/state', requireSession, (req, res) => {
    try {
      const view = require('./mahjong').webState(String(req.query.lobby || ''), req.identifier)
      if (!view) return res.status(404).json({ error: 'not_seated' })
      res.json(view)
    } catch (e) { console.error('[mj/state]', e.message); res.status(500).json({ error: 'internal' }) }
  })

  // ── MINES ────────────────────────────────────────────────────────────────
  // start: validate, debit stake, call engine /mines/start, refund on failure.
  router.post('/casino/mines/start', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const stake = Math.floor(Number(req.body?.amount) || 0)
    const numMines = Math.floor(Number(req.body?.mines) || 0)
    if (numMines < 1 || numMines > 24) return res.status(400).json({ error: 'bad_mines' })
    if (stake < GAME_MIN.mines) return res.status(400).json({ error: 'bad_stake' })
    const maxBet = await playerMaxBet(pool, identifier)
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    // one idem key per round; ties debit+refund together
    const round = crypto.randomUUID()
    const debit = await wallet().applyGameCash({
      identifier, delta: -stake, reason: 'casino-mines', idempotencyKey: 'mines-bet-' + round })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }

    const o = seedStore.nextOutcome(identifier)
    const r = casino.startMines
      ? casino.startMines({ identifier, stake, numMines, serverSeed: o.hash, clientSeed: o.clientSeed, nonce: o.nonce })
      : null
    if (!r || !r.success) {
      // refund — engine couldn't open the round (e.g. one already active)
      await wallet().applyGameCash({
        identifier, delta: stake, reason: 'casino-mines-refund', idempotencyKey: 'mines-refund-' + round })
      return res.status(409).json({ error: (r && r.error) || 'game_active' })
    }
    res.json({ success: true, balance: debit.newCash, round,
      fairness: { nonce: o.nonce, seedHash: o.serverSeedHash, clientSeed: o.clientSeed } })
  })

  router.post('/casino/mines/reveal', requireSession, async (req, res) => {
    const identifier = req.identifier
    const tile = Math.floor(Number(req.body?.index))
    if (!(tile >= 0 && tile <= 24)) return res.status(400).json({ error: 'bad_tile' })
    const r = casino.revealMine ? casino.revealMine({ identifier, tile }) : null
    if (!r || !r.success) return res.status(404).json({ error: (r && r.error) || 'no_game' })
    if (r.hit) {
      recordAndXp({ identifier, game: 'mines', stake: r.stake || 0, multiplier: 0, payout: 0, won: false, seed: r.hash, nonce: r.nonce })
      return res.json({ success: true, hit: true, index: tile, mines: r.mines })
    }
    res.json({ success: true, hit: false, index: tile, multiplier: r.multiplier, revealCount: r.revealCount })
  })

  router.post('/casino/mines/cashout', requireSession, async (req, res) => {
    const identifier = req.identifier
    const r = casino.cashoutMines ? casino.cashoutMines({ identifier }) : null
    if (!r || !r.success) return res.status(404).json({ error: (r && r.error) || 'no_game' })
    const payout = Math.min(Math.floor(r.payout || 0), PAYOUT_CAP)
    let balance
    if (payout > 0) {
      const credit = await wallet().applyGameCash({
        identifier, delta: payout, reason: 'casino-mines-win', idempotencyKey: 'mines-win-' + identifier + '-' + (r.nonce || 0) })
      balance = credit.ok ? credit.newCash : undefined
    }
    recordAndXp({ identifier, game: 'mines', stake: r.stake || 0, multiplier: r.multiplier, payout, won: true, seed: r.hash, nonce: r.nonce })
    res.json({ success: true, payout, multiplier: r.multiplier, mines: r.mines, balance })
  })

  // ── DICE ─────────────────────────────────────────────────────────────────
  // single-shot: debit, roll, credit on win, all in one request.
  router.post('/casino/dice', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const stake = Math.floor(Number(req.body?.amount) || 0)
    const target = Number(req.body?.target)
    const isOver = req.body?.mode === 'over'
    if (stake < GAME_MIN.dice) return res.status(400).json({ error: 'bad_stake' })
    if (!(target >= 2 && target <= 98)) return res.status(400).json({ error: 'bad_target' })
    const maxBet = await playerMaxBet(pool, identifier)
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    const round = crypto.randomUUID()
    const debit = await wallet().applyGameCash({
      identifier, delta: -stake, reason: 'casino-dice', idempotencyKey: 'dice-bet-' + round })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }
    const o = seedStore.nextOutcome(identifier)
    const r = casino.playDice({ stake, target, isOver, serverSeed: o.hash })
    let balance = debit.newCash
    if (r.won && r.payout > 0) {
      const credit = await wallet().applyGameCash({
        identifier, delta: Math.min(r.payout, PAYOUT_CAP), reason: 'casino-dice-win', idempotencyKey: 'dice-win-' + round })
      if (credit.ok) balance = credit.newCash
    }
    recordAndXp({ identifier, game: 'dice', stake, multiplier: r.won ? r.multiplier : 0, payout: r.won ? r.payout : 0, won: r.won, seed: o.hash, nonce: o.nonce })
    res.json({ success: true, roll: r.roll, won: r.won, multiplier: r.multiplier, payout: r.payout, balance })
  })

  // ── CHICKEN ────────────────────────────────────────────────────────────────
  router.post('/casino/chicken/start', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const stake = Math.floor(Number(req.body?.amount) || 0)
    const cols = Math.floor(Number(req.body?.cols) || 4)
    if (stake < GAME_MIN.chicken) return res.status(400).json({ error: 'bad_stake' })
    const maxBet = await playerMaxBet(pool, identifier)
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    const round = crypto.randomUUID()
    const debit = await wallet().applyGameCash({
      identifier, delta: -stake, reason: 'casino-chicken', idempotencyKey: 'chicken-bet-' + round })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }
    const o = seedStore.nextOutcome(identifier)
    const r = casino.startChicken
      ? casino.startChicken({ identifier, stake, serverSeed: o.hash, clientSeed: o.clientSeed, nonce: o.nonce, cols })
      : null
    if (!r || !r.success) {
      await wallet().applyGameCash({
        identifier, delta: stake, reason: 'casino-chicken-refund', idempotencyKey: 'chicken-refund-' + round })
      return res.status(409).json({ error: (r && r.error) || 'game_active' })
    }
    res.json({ success: true, cols: r.cols, balance: debit.newCash, round })
  })

  router.post('/casino/chicken/step', requireSession, async (req, res) => {
    const identifier = req.identifier
    const lane = Math.floor(Number(req.body?.col)) + 1  // NUI is 0-indexed, engine 1-indexed
    const r = casino.stepChicken ? casino.stepChicken({ identifier, lane }) : null
    if (!r || !r.success) return res.status(404).json({ error: (r && r.error) || 'no_game' })
    if (r.hit) {
      recordAndXp({ identifier, game: 'chicken', stake: r.stake || 0, multiplier: 0, payout: 0, won: false, seed: r.hash, nonce: r.nonce })
      return res.json({ success: true, hit: true, row: r.row - 1, col: lane - 1,
        hazardPos: (r.hazardPos || 1) - 1, hazardType: r.hazardType || 'bone', field: r.field })
    }
    res.json({ success: true, hit: false, row: r.row - 1, col: lane - 1,
      multiplier: r.multiplier, gift: r.gift, hazardType: r.hazardType || 'bone' })
  })

  router.post('/casino/chicken/cashout', requireSession, async (req, res) => {
    const identifier = req.identifier
    const r = casino.cashoutChicken ? casino.cashoutChicken({ identifier }) : null
    if (!r || !r.success) return res.status(404).json({ error: (r && r.error) || 'no_game' })
    const payout = Math.min(Math.floor(r.payout || 0), PAYOUT_CAP)
    let balance
    if (payout > 0) {
      const credit = await wallet().applyGameCash({
        identifier, delta: payout, reason: 'casino-chicken-win', idempotencyKey: 'chicken-win-' + identifier + '-' + (r.nonce || 0) })
      balance = credit.ok ? credit.newCash : undefined
    }
    recordAndXp({ identifier, game: 'chicken', stake: r.stake || 0, multiplier: r.multiplier, payout, won: true, seed: r.hash, nonce: r.nonce })
    res.json({ success: true, payout, multiplier: r.multiplier, field: r.field, balance })
  })

  // ── PLINKO ───────────────────────────────────────────────────────────────
  // single-shot per ball: debit, drop, credit payout.
  router.post('/casino/plinko', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const stake = Math.floor(Number(req.body?.amount) || 0)
    const rows = Math.floor(Number(req.body?.rows) || 12)
    const risk = req.body?.risk || 'medium'
    if (stake < GAME_MIN.plinko) return res.status(400).json({ error: 'bad_stake' })
    const maxBet = await playerMaxBet(pool, identifier)
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    const round = crypto.randomUUID()
    const debit = await wallet().applyGameCash({
      identifier, delta: -stake, reason: 'casino-plinko', idempotencyKey: 'plinko-bet-' + round })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }
    const r = casino.playPlinko({ identifier, stake, rows, risk })
    let balance = debit.newCash
    const payout = Math.min(Math.floor(r.payout || 0), PAYOUT_CAP)
    if (payout > 0) {
      const credit = await wallet().applyGameCash({
        identifier, delta: payout, reason: 'casino-plinko-win', idempotencyKey: 'plinko-win-' + round })
      if (credit.ok) balance = credit.newCash
    }
    recordAndXp({ identifier, game: 'plinko', stake, multiplier: r.multiplier, payout, won: payout > stake, seed: r.hash, nonce: r.nonce })
    res.json({ success: true, bucket: r.bucket, multiplier: r.multiplier, payout, path: r.path, balance })
  })

  // ── CRASH (realtime, shared round) ───────────────────────────────────────────
  // The engine already runs the round loop; web just needs money + a state feed.
  // Money model differs from in-game: the relay pays only its own crashBetSources,
  // so web bets (absent from that table) are settled HERE by the settle handler we
  // register below. Debit on bet; credit winners exactly once at round end.

  // Bet-list display name: nickname (if shown) else char first name else Hidden.
  async function crashDisplayName(pool, identifier) {
    try {
      const [[vip]] = await pool.query(
        'SELECT nickname, show_nickname FROM hk_steak_vip WHERE identifier = ?', [identifier])
      if (vip && vip.show_nickname && vip.nickname) return String(vip.nickname).slice(0, 24)
      const [[ident]] = await pool.query(
        'SELECT char_name FROM hk_player_identity WHERE identifier = ?', [identifier])
      if (ident && ident.char_name) return String(ident.char_name).split(' ')[0].slice(0, 24)
    } catch { /* fall through */ }
    return 'Player'
  }

  router.post('/casino/crash/join', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    casino.addCrashWatcher(identifier)
    const state = casino.getCrashStateFor(identifier)
    const balance = await wallet().getMirroredCash(pool, identifier)
    res.json({ success: true, ...state, balance: balance == null ? undefined : balance })
  })

  router.get('/casino/crash/state', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const state = casino.getCrashStateFor(identifier)
    const balance = await wallet().getMirroredCash(pool, identifier)
    res.json({ success: true, ...state, balance: balance == null ? undefined : balance })
  })

  router.post('/casino/crash/leave', requireSession, (req, res) => {
    const identifier = req.identifier
    // Keep the watcher if a live (un-cashed) bet remains, so settlement still reaches them.
    const live = casino.peekWebCrashBet(identifier)
    if (!live) casino.removeCrashWatcher(identifier)
    res.json({ success: true })
  })

  router.post('/casino/crash/bet', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const stake = Math.floor(Number(req.body?.amount) || 0)
    let autoCashout = req.body?.autoCashout != null ? Number(req.body.autoCashout) : null
    if (autoCashout != null && !(autoCashout >= 1.1)) autoCashout = null
    if (stake < MIN_BET) return res.status(400).json({ error: 'bad_stake' })
    const maxBet = await playerMaxBet(pool, identifier)
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    // The shared round must be accepting bets and the player must not already be in.
    const pre = casino.getCrashStateFor(identifier)
    if (pre.state !== 'waiting') return res.status(400).json({ error: 'not_accepting' })
    if (pre.myBet && pre.myBet.hasBet) return res.status(400).json({ error: 'already_bet' })

    // Debit FIRST (guaranteed-sync). Key per round-nonce so a retry can't double-charge.
    const debitKey = 'crash-bet-' + pre.nonce + '-' + identifier
    const debit = await wallet().applyGameCash({
      identifier, delta: -stake, reason: 'casino-crash', idempotencyKey: debitKey })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }

    const name = await crashDisplayName(pool, identifier)
    const placed = casino.placeWebCrashBet(identifier, stake, autoCashout, name)
    if (!placed.ok) {
      // Round moved on / already bet between checks — refund the debit.
      await wallet().applyGameCash({
        identifier, delta: stake, reason: 'casino-crash-refund', idempotencyKey: 'crash-refund-' + pre.nonce + '-' + identifier })
      return res.status(409).json({ error: placed.error || 'place_failed' })
    }
    casino.tagWebCrashBet(identifier, debitKey)
    res.json({ success: true, balance: debit.newCash, betList: placed.betList })
  })

  router.post('/casino/crash/cashout', requireSession, (req, res) => {
    const identifier = req.identifier
    const multiplier = Number(req.body?.multiplier) || null
    const r = casino.cashoutWebCrash(identifier, multiplier)
    if (!r.ok) return res.status(400).json({ error: r.error || 'cashout_failed' })
    // Money is paid at round settle (parity w/ in-game); just confirm the lock here.
    res.json({ success: true, multiplier: r.multiplier, payout: r.payout, betList: r.betList })
  })

  // Settlement for WEB crash bets — invoked once per round on running->ended.
  // Credits cashed-out winners exactly once (idem key), records every web bet.
  casino.setWebCrashSettleHandler((snapshot, crashPoint, nonce) => {
    for (const bet of snapshot) {
      const won = bet.cashedOut && bet.payout > 0
      if (won) {
        const payout = Math.min(Math.floor(bet.payout), PAYOUT_CAP)
        wallet().applyGameCash({
          identifier: bet.identifier, delta: payout, reason: 'casino-crash-win',
          idempotencyKey: 'crash-win-' + nonce + '-' + bet.identifier,
        }).then(credit => {
          if (!credit.ok) console.error('[crash web settle] credit FAILED', bet.identifier, credit.error)
        }).catch(e => console.error('[crash web settle]', e.message))
      }
      recordAndXp({
        identifier: bet.identifier, game: 'crash', stake: bet.stake,
        multiplier: won ? bet.multiplier : 0, payout: won ? Math.min(Math.floor(bet.payout), PAYOUT_CAP) : 0,
        won, seed: '', nonce: nonce || 0,
      })
    }
  })
}

module.exports = { register }
