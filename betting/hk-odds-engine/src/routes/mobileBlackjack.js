// mobileBlackjack.js — web/PWA bridge for LIVE multiplayer blackjack at the SHARED
// tables (bj_main / bj_vip). Web players sit at the SAME engine tables as in-game
// players — this is NOT a separate web room. Sync model mirrors crash:
//
//   • The engine (blackjack.js) runs the shoe + state machine for both surfaces.
//   • In-game, the relay (casino.lua) escrows/pays and broadcasts state to NUI.
//   • On web there is no relay in the loop, so THIS module owns the money: it
//     debits stake/side/double/split/insurance via applyGameCash (guaranteed-sync,
//     same path as sports/place + instant casino) and drives the engine's web-facing
//     table functions. Web seats are tagged web=true so the relay's bjSettleRoom
//     SKIPS them (gate: `if not p.web`), and the engine settles them here via
//     setWebBjSettleHandler — exactly-once, keyed per round. No double-pay, one table.
//
// Money safety (mirrors sports/place + crash):
//   • debit BEFORE the mutation; REFUND if the engine rejects (unless the debit was
//     a relay REPLAY — then the original request already ran, so we don't refund).
//   • client mints one idempotency key per money action → a dropped-response retry
//     replays the stored result instead of moving cash twice.
//   • payouts credited exactly once per round via the settle handler.
const crypto = require('crypto')
const { getPool } = require('../db')
const { MaxBet, getVipLevel } = require('../steakConfig')

const PAYOUT_CAP = 50000000
const BJ_SALON_MIN_XP = 15000000    // bj_vip Gold+ gate (mirrors casino.lua BJ_SALON_MIN_XP)

function register(router, requireSession) {
  const bj = require('./blackjack')
  const wallet = () => require('./mobile')

  // Player's per-tier max bet (mirrors mobileCasino.playerMaxBet). Also returns xp
  // so the bj_vip Salon rank gate can be checked from the same row.
  async function playerLimits(pool, identifier) {
    const [[row]] = await pool.query(
      'SELECT xp, personal_max_bet FROM hk_steak_vip WHERE identifier = ?', [identifier])
    const xp = row ? (row.xp || 0) : 0
    const tierMax = Math.min(getVipLevel(xp).maxBet, MaxBet)
    const pmb = row && row.personal_max_bet
    const maxBet = (pmb && pmb < tierMax) ? pmb : tierMax
    return { xp, maxBet }
  }

  // Display name for the shared bet list (nickname if shown, else char first name).
  async function displayName(pool, identifier) {
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

  // Fire-and-forget stats/XP write (mirrors mobileCasino.recordAndXp + casino.lua record).
  function recordAndXp({ identifier, stake, payout, won, seed, nonce }) {
    const pool = getPool()
    pool.query(
      `INSERT INTO hk_casinobets (identifier, game, stake, multiplier, payout, won, seed, nonce)
       VALUES (?, 'blackjack', ?, ?, ?, ?, ?, ?)`,
      [identifier, stake, stake > 0 ? payout / stake : 0, payout || 0, won ? 1 : 0,
       (seed || '').slice(0, 128), nonce || 0]
    ).catch(e => console.error('[mobileBj record]', e.message))
    const xpGain = Math.floor(stake || 0)
    pool.query(`
      INSERT INTO hk_steak_vip (identifier, xp, total_wagered_casino, total_won_casino, casino_bets_count, biggest_win)
      VALUES (?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE
        xp = xp + ?, total_wagered_casino = total_wagered_casino + ?,
        total_won_casino = total_won_casino + ?, casino_bets_count = casino_bets_count + 1,
        biggest_win = GREATEST(biggest_win, ?)`,
      [identifier, xpGain, stake || 0, payout || 0, payout || 0, xpGain, stake || 0, payout || 0, payout || 0]
    ).catch(e => console.error('[mobileBj xp]', e.message))
  }

  // Sum the escrow for a sit/behind body: main stake + the four side bets. Clamped
  // to >=0 so a malformed negative field can't skew the debit. Matches the engine's
  // own escrow math (stake + Σ sides) so refund-on-reject returns the exact amount.
  function escrowOf(body) {
    let total = Math.max(0, Math.floor(Number(body.stake) || 0))
    for (const k of ['pairs', 'p3', 'bust', 'hot3']) {
      total += Math.max(0, Math.floor(Number(body[k]) || 0))
    }
    return total
  }

  // A short random idem key when the client didn't supply one (older bundles).
  function keyOf(body, prefix) {
    const k = body && typeof body.idem === 'string' && body.idem.length >= 8
      ? body.idem.slice(0, 48) : crypto.randomUUID()
    return prefix + '-' + k
  }

  // ── Lobby / join / state / leave ────────────────────────────────────────
  // Room list + live seat counts for the picker (no money).
  router.get('/casino/bj/rooms', requireSession, (req, res) => {
    res.json({ rooms: bj.getRoomsWeb() })
  })

  // Join a room as a watcher; returns the scoped view (isMe on our seat).
  router.post('/casino/bj/join', requireSession, async (req, res) => {
    const room = String(req.body?.room || '')
    const view = bj.addBjWatcher(room, req.identifier)
    if (!view) return res.status(404).json({ error: 'no_such_room' })
    const balance = await wallet().getMirroredCash(getPool(), req.identifier)
    res.json({ success: true, room, view, balance: balance == null ? undefined : balance })
  })

  // Poll target: current scoped view for the room. The web poller diffs this.
  // In the payout phase we also attach the settle result so the client can render
  // the round banner (parity with the relay's `settled` broadcast).
  router.get('/casino/bj/state', requireSession, async (req, res) => {
    const room = String(req.query?.room || '')
    const view = bj.getViewFor(room, req.identifier)
    if (!view) return res.status(404).json({ error: 'no_such_room' })
    const balance = await wallet().getMirroredCash(getPool(), req.identifier)
    const out = { success: true, room, view, balance: balance == null ? undefined : balance }
    if (view.state === 'payout') {
      const lr = bj.getLastResult(room)
      if (lr && lr.result) out.result = lr.result
    }
    res.json(out)
  })

  // Leave a room: free the seat if still in the betting window and REFUND escrow.
  router.post('/casino/bj/leave', requireSession, async (req, res) => {
    const room = String(req.body?.room || '')
    const r = bj.leaveWeb(room, req.identifier)
    if (r.refund > 0) {
      await wallet().applyGameCash({
        identifier: req.identifier, delta: r.refund, reason: 'casino-blackjack-leave-refund',
        idempotencyKey: keyOf(req.body, 'bj-leave-' + room),
      }).catch(e => console.error('[mobileBj leave refund]', e.message))
    }
    res.json({ success: true })
  })

  // ── Sit (main + side bets) ──────────────────────────────────────────────
  router.post('/casino/bj/sit', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const room = String(req.body?.room || '')
    const t = bj.getTableByRoom(room)
    if (!t) return res.status(404).json({ error: 'no_such_room' })

    const stake = Math.floor(Number(req.body?.stake) || 0)
    const { xp, maxBet } = await playerLimits(pool, identifier)
    if (room === 'bj_vip' && xp < BJ_SALON_MIN_XP) return res.status(400).json({ error: 'salon_gold_only' })
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    const escrow = escrowOf(req.body)
    if (escrow <= 0) return res.status(400).json({ error: 'bad_stake' })

    // Debit the full escrow FIRST (guaranteed-sync). Key per round so a retry replays.
    const debitKey = keyOf(req.body, 'bj-sit-' + room + '-' + t.roundId)
    const debit = await wallet().applyGameCash({
      identifier, delta: -escrow, reason: 'casino-blackjack', idempotencyKey: debitKey })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }

    const name = await displayName(pool, identifier)
    const placed = bj.sitWeb(room, { identifier, name, seat: req.body.seat, stake,
      pairs: req.body.pairs, p3: req.body.p3, bust: req.body.bust, hot3: req.body.hot3 })
    if (placed.error) {
      // Engine rejected the sit. Refund the debit UNLESS it was a relay replay (the
      // original request already sat/settled — refunding would leak cash out).
      if (!debit.replay) {
        await wallet().applyGameCash({
          identifier, delta: escrow, reason: 'casino-blackjack-refund',
          idempotencyKey: 'bj-sit-refund-' + room + '-' + t.roundId + '-' + identifier })
          .catch(e => console.error('[mobileBj sit refund]', e.message))
      }
      return res.status(400).json({ error: placed.error })
    }
    res.json({ success: true, balance: debit.newCash, seat: placed.seat, view: placed.view })
  })

  // ── Bet behind a seated player (+ optional side bets) ───────────────────
  router.post('/casino/bj/behind', requireSession, async (req, res) => {
    const pool = getPool()
    const identifier = req.identifier
    const room = String(req.body?.room || '')
    const t = bj.getTableByRoom(room)
    if (!t) return res.status(404).json({ error: 'no_such_room' })

    const stake = Math.floor(Number(req.body?.stake) || 0)
    const { xp, maxBet } = await playerLimits(pool, identifier)
    if (room === 'bj_vip' && xp < BJ_SALON_MIN_XP) return res.status(400).json({ error: 'salon_gold_only' })
    if (stake > maxBet) return res.status(400).json({ error: 'over_max', maxBet })

    const escrow = escrowOf(req.body)
    if (escrow <= 0) return res.status(400).json({ error: 'bad_stake' })

    const debitKey = keyOf(req.body, 'bj-behind-' + room + '-' + t.roundId)
    const debit = await wallet().applyGameCash({
      identifier, delta: -escrow, reason: 'casino-blackjack-behind', idempotencyKey: debitKey })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }

    const name = await displayName(pool, identifier)
    const placed = bj.behindWeb(room, { identifier, name, seat: req.body.seat, stake,
      pairs: req.body.pairs, p3: req.body.p3, bust: req.body.bust, hot3: req.body.hot3 })
    if (placed.error) {
      if (!debit.replay) {
        await wallet().applyGameCash({
          identifier, delta: escrow, reason: 'casino-blackjack-behind-refund',
          idempotencyKey: 'bj-behind-refund-' + room + '-' + t.roundId + '-' + identifier })
          .catch(e => console.error('[mobileBj behind refund]', e.message))
      }
      return res.status(400).json({ error: placed.error })
    }
    res.json({ success: true, balance: debit.newCash, view: placed.view })
  })

  // ── Insurance ────────────────────────────────────────────────────────────
  router.post('/casino/bj/insure', requireSession, async (req, res) => {
    const identifier = req.identifier
    const room = String(req.body?.room || '')
    const t = bj.getTableByRoom(room)
    if (!t) return res.status(404).json({ error: 'no_such_room' })

    const want = Math.floor(Number(req.body?.stake) || 0)
    if (want <= 0) return res.status(400).json({ error: 'bad_stake' })

    // Debit first, then place. If the engine capped it below `want`, refund the diff.
    const debitKey = keyOf(req.body, 'bj-ins-' + room + '-' + t.roundId)
    const debit = await wallet().applyGameCash({
      identifier, delta: -want, reason: 'casino-blackjack-insurance', idempotencyKey: debitKey })
    if (!debit.ok) {
      const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
        : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
      return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
    }
    const placed = bj.insureWeb(room, { identifier, stake: want })
    if (placed.error) {
      if (!debit.replay) {
        await wallet().applyGameCash({
          identifier, delta: want, reason: 'casino-blackjack-insurance-refund',
          idempotencyKey: 'bj-ins-refund-' + room + '-' + t.roundId + '-' + identifier })
          .catch(e => console.error('[mobileBj ins refund]', e.message))
      }
      return res.status(400).json({ error: placed.error })
    }
    // Engine took `escrow` (the capped amount). Refund any overpayment vs `want`.
    const took = Math.floor(placed.escrow || 0)
    if (!debit.replay && took < want) {
      await wallet().applyGameCash({
        identifier, delta: want - took, reason: 'casino-blackjack-insurance-cap-refund',
        idempotencyKey: 'bj-ins-cap-' + room + '-' + t.roundId + '-' + identifier })
        .catch(e => console.error('[mobileBj ins cap refund]', e.message))
    }
    res.json({ success: true, view: placed.view })
  })

  // ── Turn action: hit | stand | double | split | surrender ───────────────
  router.post('/casino/bj/action', requireSession, async (req, res) => {
    const identifier = req.identifier
    const room = String(req.body?.room || '')
    const action = String(req.body?.action || '')
    const t = bj.getTableByRoom(room)
    if (!t) return res.status(404).json({ error: 'no_such_room' })

    const needsEscrow = (action === 'double' || action === 'split')
    let extra = 0
    if (needsEscrow) {
      // Escrow the extra matching stake BEFORE the engine draws (parity w/ in-game).
      extra = bj.actionCost(room, identifier)
      if (extra <= 0) return res.status(400).json({ error: 'not_your_turn' })
      const debit = await wallet().applyGameCash({
        identifier, delta: -extra, reason: 'casino-blackjack-' + action,
        idempotencyKey: keyOf(req.body, 'bj-' + action + '-' + room + '-' + t.roundId) })
      if (!debit.ok) {
        const err = debit.error === 'insufficient_cash' ? 'insufficient_cash'
          : debit.error === 'relay_down' ? 'server_unreachable' : (debit.error || 'debit_failed')
        return res.status(debit.error === 'insufficient_cash' ? 400 : 503).json({ error: err })
      }
      // Remember whether this was a replay so a reject-refund below stays correct.
      req._bjDebitReplay = debit.replay
    }

    const r = bj.actionWeb(room, { identifier, action })
    if (r.error) {
      if (needsEscrow && !req._bjDebitReplay) {
        await wallet().applyGameCash({
          identifier, delta: extra, reason: 'casino-blackjack-' + action + '-refund',
          idempotencyKey: 'bj-' + action + '-refund-' + room + '-' + t.roundId + '-' + identifier })
          .catch(e => console.error('[mobileBj action refund]', e.message))
      }
      return res.status(400).json({ error: r.error })
    }
    // The engine may have charged a different escrowDelta than we took (shouldn't,
    // but keep parity with the relay's reconcile): refund any positive difference.
    if (needsEscrow && !req._bjDebitReplay) {
      const charged = Math.floor(Number(r.escrowDelta) || extra)
      if (charged < extra) {
        await wallet().applyGameCash({
          identifier, delta: extra - charged, reason: 'casino-blackjack-escrow-reconcile',
          idempotencyKey: 'bj-' + action + '-reconcile-' + room + '-' + t.roundId + '-' + identifier })
          .catch(e => console.error('[mobileBj reconcile]', e.message))
      }
    }
    res.json({ success: true, view: r.view })
  })

  // ── Web settlement ────────────────────────────────────────────────────────
  // Fired once per round by the engine (setWebBjSettleHandler) with ONLY the web
  // players. Credit each player's total payout (capped) exactly once, keyed per
  // round so a re-fire can't double-pay; record stats. Loss protection is an
  // in-game-only VIP perk (needs the live Player object) so it's intentionally
  // not applied on web — parity with how it degrades for offline players in-game.
  bj.setWebBjSettleHandler((room, result) => {
    if (!result || !Array.isArray(result.players)) return
    for (const p of result.players) {
      const identifier = p.identifier
      if (!identifier) continue
      const staked = Math.floor(Number(p.staked) || 0)
      const rawPayout = Math.floor(Number(p.payout) || 0)
      const payout = Math.min(rawPayout, PAYOUT_CAP)
      if (rawPayout > payout) {
        console.error(`[mobileBj] PAYOUT CLIPPED room=${room} id=${identifier} earned=${rawPayout} paid=${payout} (cap ${PAYOUT_CAP})`)
      }
      const won = payout > staked
      if (payout > 0) {
        wallet().applyGameCash({
          identifier, delta: payout, reason: 'casino-blackjack-win',
          idempotencyKey: 'bj-win-' + room + '-' + result.roundId + '-' + identifier,
        }).then(credit => {
          if (!credit.ok) console.error('[mobileBj settle] credit FAILED', identifier, credit.error)
        }).catch(e => console.error('[mobileBj settle]', e.message))
      }
      recordAndXp({
        identifier, stake: staked, payout, won,
        seed: result.serverSeedHash || '', nonce: result.shoeNonce || 0,
      })
    }
  })

  // Restore an in-progress web blackjack round after a page reload (mounted onto
  // the shared /casino/active response by mobileCasino? — no; we expose our own).
  router.get('/casino/bj/active', requireSession, (req, res) => {
    const seat = bj.peekWebSeat(req.identifier)
    if (!seat) return res.json({ active: false })
    const view = bj.getViewFor(seat.room, req.identifier)
    res.json({ active: true, room: seat.room, seat: seat.seat, behind: seat.behind, view })
  })
}

module.exports = { register }
