const express = require('express')
const { getPool } = require('../db')

const router = express.Router()

// Get full player profile (VIP, stats, bet history)
router.get('/:identifier', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.identifier

    const [vipRows] = await pool.query(
      'SELECT * FROM hk_steak_vip WHERE identifier = ?', [cid]
    )
    const vip = vipRows[0] || null

    const [sportsBets] = await pool.query(
      `SELECT id, event_id, match_desc, market, selection, odds, stake, potential_win, payout, status, commence_time, placed_at, settled_at
       FROM hk_sportsbets WHERE identifier = ? ORDER BY placed_at DESC LIMIT 50`, [cid]
    )

    const [casinoBets] = await pool.query(
      `SELECT id, game, stake, multiplier, payout, won, played_at
       FROM hk_casinobets WHERE identifier = ? ORDER BY played_at DESC LIMIT 50`, [cid]
    )

    const stats = vip ? {
      xp: vip.xp || 0,
      totalWageredSports: vip.total_wagered_sports || 0,
      totalWageredCasino: vip.total_wagered_casino || 0,
      totalWonSports: vip.total_won_sports || 0,
      totalWonCasino: vip.total_won_casino || 0,
      sportsBetsCount: vip.sports_bets_count || 0,
      casinoBetsCount: vip.casino_bets_count || 0,
      biggestWin: vip.biggest_win || 0,
      nickname: vip.nickname,
      showNickname: vip.show_nickname === 1,
      personalMaxBet: vip.personal_max_bet || 0,
    } : null

    res.json({ stats, sportsBets, casinoBets })
  } catch (err) {
    console.error('[players/:id]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// Add VIP XP (called by FiveM after any bet)
router.post('/:identifier/xp', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.identifier
    const { wagered, won, isCasino } = req.body

    const xpGain = Math.floor((wagered || 0) * 1)
    const wagerCol = isCasino ? 'total_wagered_casino' : 'total_wagered_sports'
    const wonCol = isCasino ? 'total_won_casino' : 'total_won_sports'
    const countCol = isCasino ? 'casino_bets_count' : 'sports_bets_count'

    await pool.query(`
      INSERT INTO hk_steak_vip (identifier, xp, ${wagerCol}, ${wonCol}, ${countCol}, biggest_win)
      VALUES (?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE
        xp = xp + ?,
        ${wagerCol} = ${wagerCol} + ?,
        ${wonCol} = ${wonCol} + ?,
        ${countCol} = ${countCol} + 1,
        biggest_win = GREATEST(biggest_win, ?)
    `, [cid, xpGain, wagered || 0, won || 0, won || 0, xpGain, wagered || 0, won || 0, won || 0])

    res.json({ success: true, xpGain })
  } catch (err) {
    console.error('[players/:id/xp]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// Get pending payouts (for when FiveM reconnects)
router.get('/payouts/pending', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(`
      SELECT id, identifier, payout, status
      FROM hk_sportsbets
      WHERE status IN ('won', 'void') AND payout > 0 AND paid_out = 0
      ORDER BY settled_at ASC LIMIT 100
    `)
    res.json(rows)
  } catch (err) {
    console.error('[payouts/pending]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// Atomically CLAIM pending payouts: flips paid_out 0->1 for the given ids and
// returns only the ids that were actually flipped by THIS call (affectedRows).
// This is the dedup guard — the resource pays money only for claimed ids, so a
// concurrent poll cycle can never double-pay. Replaces the resource's old
// "UPDATE hk_sportsbets WHERE status='active'" atomic claim.
router.post('/payouts/claim', async (req, res) => {
  try {
    const pool = getPool()
    const { betIds } = req.body
    if (!betIds || !betIds.length) return res.json({ claimed: [] })
    const claimed = []
    // per-id atomic flip so we know exactly which we won the race for
    for (const id of betIds) {
      const [r] = await pool.query(
        'UPDATE hk_sportsbets SET paid_out = 1 WHERE id = ? AND paid_out = 0', [id])
      if (r.affectedRows > 0) claimed.push(id)
    }
    res.json({ claimed })
  } catch (err) {
    console.error('[payouts/claim]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// Mark payout as delivered to player
router.post('/payouts/confirm', async (req, res) => {
  try {
    const pool = getPool()
    const { betIds } = req.body
    if (!betIds || !betIds.length) return res.status(400).json({ error: 'no betIds' })

    await pool.query(
      'UPDATE hk_sportsbets SET paid_out = 1 WHERE id IN (?)', [betIds]
    )
    res.json({ success: true, confirmed: betIds.length })
  } catch (err) {
    console.error('[payouts/confirm]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

module.exports = router
