const express = require('express')
const { getPool } = require('../db')

const router = express.Router()

router.post('/place', async (req, res) => {
  try {
    const { identifier, eventId, matchDesc, market, selection, odds, stake, commenceTime } = req.body
    // ZQ-only fields (present when betting a ZQ match) — let settlement match the
    // result by the original Chinese names + handicap line, with no reverse-translation.
    const { zqHomeCn, zqAwayCn, handicapLine } = req.body
    if (!identifier || !eventId || !odds || !stake) {
      return res.status(400).json({ error: 'missing fields' })
    }

    // Server-side sanity on the money inputs (NUI is untrusted — a crafted request
    // could otherwise send NaN/negative/huge values straight into the ledger).
    const stakeN = Number(stake)
    const oddsN = Number(odds)
    if (!Number.isFinite(stakeN) || stakeN <= 0 || !Number.isFinite(oddsN) || oddsN < 1) {
      return res.status(400).json({ error: 'invalid stake or odds' })
    }

    // Hard payout ceiling. potential_win is the single value every settlement path
    // pays out (SharpAPI settle, ZQ settle, /payouts pull), so capping it here bounds
    // the whole system at one honest chokepoint — the player sees the capped number
    // in their slip up front, no silent back-end shave.
    const MAX_PAYOUT = 1000000000 // 1B
    const potentialWin = Math.min(Math.floor(stakeN * oddsN), MAX_PAYOUT)

    // commence_time is a MySQL DATETIME. Events send ISO-8601 strings — SharpAPI as
    // "2026-08-22T11:30:00Z" and ZQ as date-only "2026-08-08Z". MariaDB strict mode
    // rejects both (the "T"/"Z"), 500ing the insert → the resource refunds and shows
    // "under maintenance". Normalize any parseable input to "YYYY-MM-DD HH:MM:SS".
    const toMysqlDatetime = (v) => {
      if (!v) return null
      const d = new Date(v)
      if (isNaN(d.getTime())) return null
      return d.toISOString().slice(0, 19).replace('T', ' ')
    }
    const commenceDt = toMysqlDatetime(commenceTime)

    const pool = getPool()

    const [result] = await pool.query(
      `INSERT INTO hk_sportsbets (identifier, event_id, match_desc, market, selection, odds, stake, potential_win, commence_time, zq_home_cn, zq_away_cn, handicap_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [identifier, eventId, (matchDesc || '').slice(0, 255), market || 'h2h', (selection || '').slice(0, 64), oddsN, stakeN, potentialWin, commenceDt,
       zqHomeCn ? String(zqHomeCn).slice(0, 64) : null,
       zqAwayCn ? String(zqAwayCn).slice(0, 64) : null,
       (handicapLine != null && handicapLine !== '') ? parseFloat(handicapLine) : null]
    )

    res.json({ success: true, betId: result.insertId, potentialWin })
  } catch (err) {
    console.error('[bets/place]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

router.get('/active', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT id, event_id, match_desc, selection, odds, stake, potential_win, commence_time, placed_at
       FROM hk_sportsbets WHERE status = 'active' ORDER BY placed_at DESC LIMIT 200`
    )
    res.json(rows)
  } catch (err) {
    console.error('[bets/active]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

router.get('/player/:identifier', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT id, event_id, match_desc, market, selection, odds, stake, potential_win, status, payout, commence_time, placed_at, settled_at
       FROM hk_sportsbets WHERE identifier = ? ORDER BY placed_at DESC LIMIT 50`,
      [req.params.identifier]
    )
    res.json(rows)
  } catch (err) {
    console.error('[bets/player]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

router.post('/settle', async (req, res) => {
  try {
    const { betId, result: outcome } = req.body
    if (!betId || !outcome) return res.status(400).json({ error: 'missing betId or result' })

    const pool = getPool()
    let payout = 0

    const [rows] = await pool.query('SELECT * FROM hk_sportsbets WHERE id = ? AND status = ?', [betId, 'active'])
    if (!rows.length) return res.status(404).json({ error: 'bet not found or already settled' })

    const bet = rows[0]
    if (outcome === 'won') payout = bet.potential_win
    else if (outcome === 'void') payout = bet.stake

    const [updateResult] = await pool.query(
      'UPDATE hk_sportsbets SET status = ?, payout = ?, paid_out = 1, settled_at = NOW() WHERE id = ? AND status = ?',
      [outcome, payout, betId, 'active']
    )

    if (updateResult.affectedRows === 0) {
      return res.status(409).json({ error: 'bet was settled concurrently' })
    }

    res.json({
      success: true, betId, outcome, payout,
      identifier: bet.identifier, stake: bet.stake, potentialWin: bet.potential_win,
    })
  } catch (err) {
    console.error('[bets/settle]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// Correct a settled bet's stored payout to the actual net-after-tax amount the
// resource paid (settle stores gross potential_win; tax is applied resource-side).
router.post('/set-payout', async (req, res) => {
  try {
    const { betId, payout } = req.body
    if (!betId) return res.status(400).json({ error: 'missing betId' })
    await getPool().query('UPDATE hk_sportsbets SET payout = ? WHERE id = ?', [payout || 0, betId])
    res.json({ success: true })
  } catch (err) {
    console.error('[bets/set-payout]', err.message)
    res.status(500).json({ error: 'internal error' })
  }
})

module.exports = router
