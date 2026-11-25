// steak.js — betting/casino persistence endpoints. The hk-sportsbetting resource
// used to write these tables directly via oxmysql; now they live in the isolated
// zx_wxyz_stream DB owned by this engine. The resource calls these over HTTP and
// keeps only the money (players) + FiveM side-effects local.
//
// MONEY INVARIANT: this engine NEVER writes the game `players` table. Endpoints
// return what the resource should pay; the resource does AddMoney + client events.
const express = require('express')
const { getPool } = require('../db')
const { VIP, MaxBet, getVipLevel, getNextLevel } = require('../steakConfig')

const router = express.Router()

// ── health-lite: cheap DB-reachability probe for the resource's maintenance gate ──
// Returns {ok:true} only if the betting DB actually answers. The resource polls this
// and shows "The house is closed" overlay + denies bets whenever ok!=true.
router.get('/health-lite', async (req, res) => {
  try {
    await getPool().query('SELECT 1')
    res.json({ ok: true })
  } catch (e) {
    res.status(503).json({ ok: false })
  }
})

// ── week-start (Mon 00:00 UTC) helper, mirrors vip.lua getWeekStart ──
function weekStart() {
  const d = new Date()
  const day = (d.getUTCDay() + 6) % 7 // 0=Mon
  d.setUTCDate(d.getUTCDate() - day)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString().slice(0, 10)
}

// ── referral code generator (mirrors vip.lua ensureVipRow: 8 chars, no ambiguous) ──
function genReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

// Ensure a vip row exists (with a referral_code). Idempotent; backfills a missing
// code on existing rows. Returns nothing — callers re-SELECT as needed.
async function ensureVipRow(pool, cid) {
  await pool.query(
    'INSERT IGNORE INTO hk_steak_vip (identifier, referral_code) VALUES (?, ?)',
    [cid, genReferralCode()])
  await pool.query(
    'UPDATE hk_steak_vip SET referral_code = ? WHERE identifier = ? AND (referral_code IS NULL OR referral_code = "")',
    [genReferralCode(), cid])
}

// ── CASINO: record one casino bet (replaces casino.lua INSERT hk_casinobets) ──
router.post('/casino/record', async (req, res) => {
  try {
    const { identifier, game, stake, multiplier, payout, won, seed, nonce } = req.body
    if (!identifier || !game || stake == null) return res.status(400).json({ error: 'missing fields' })
    const pool = getPool()
    const [r] = await pool.query(
      `INSERT INTO hk_casinobets (identifier, game, stake, multiplier, payout, won, seed, nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [identifier, String(game).slice(0, 32), stake, multiplier || 0, payout || 0,
       won ? 1 : 0, (seed || '').slice(0, 128), nonce || 0]
    )
    res.json({ success: true, id: r.insertId })
  } catch (e) {
    console.error('[steak/casino/record]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── CASINO EXCLUSION (self-exclusion / responsible gaming) ──
router.get('/casino/exclusion-status/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      'SELECT reason, expires_at FROM hk_casino_exclusions WHERE identifier = ? LIMIT 1',
      [req.params.cid]
    )
    const row = rows[0]
    if (!row) return res.json({ excluded: false })
    const now = Date.now()
    const exp = row.expires_at ? new Date(row.expires_at).getTime() : null
    if (exp && exp <= now) {
      await pool.query('DELETE FROM hk_casino_exclusions WHERE identifier = ?', [req.params.cid])
      return res.json({ excluded: false })
    }
    res.json({
      excluded: true,
      reason: row.reason || 'Account paused',
      expiresAt: exp,
      remainingMs: exp ? Math.max(0, exp - now) : null,
    })
  } catch (e) {
    console.error('[steak/exclusion-status]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

router.post('/casino/exclusion', async (req, res) => {
  try {
    const { identifier, reason, durationMs } = req.body
    if (!identifier) return res.status(400).json({ error: 'missing identifier' })
    const pool = getPool()
    if (durationMs && durationMs > 0) {
      const expires = new Date(Date.now() + durationMs)
      await pool.query(
        `INSERT INTO hk_casino_exclusions (identifier, reason, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), expires_at = VALUES(expires_at)`,
        [identifier, (reason || 'Account paused').slice(0, 255), expires]
      )
    } else {
      await pool.query('DELETE FROM hk_casino_exclusions WHERE identifier = ?', [identifier])
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[steak/exclusion]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── CASINO history (paginated, per-player) — replaces casino.lua getGameHistory reads ──
router.get('/casino/history/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.cid
    const game = String(req.query.game || '')
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = 30
    const offset = (page - 1) * limit
    const filterGame = game && game !== 'all'
    const whereGame = filterGame ? ' AND game = ?' : ''
    const cntParams = filterGame ? [cid, game] : [cid]
    const [[cnt]] = [await pool.query(
      'SELECT COUNT(*) AS c FROM hk_casinobets WHERE identifier = ?' + whereGame, cntParams)]
    const total = Number(cnt.c) || 0
    const selParams = filterGame ? [cid, game, limit, offset] : [cid, limit, offset]
    const [rows] = await pool.query(
      'SELECT game, stake, multiplier, payout, won, played_at FROM hk_casinobets WHERE identifier = ?' +
      whereGame + ' ORDER BY played_at DESC LIMIT ? OFFSET ?', selParams)
    res.json({ bets: rows, page, total, totalPages: Math.ceil(total / limit) })
  } catch (e) {
    console.error('[steak/casino/history]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── CASINO home data: recent bets (with display name) + player's last game ──
router.get('/casino/home/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.cid
    const [recent] = await pool.query(
      `SELECT b.game, b.stake, b.multiplier, b.payout, b.won, b.played_at, v.nickname, v.show_nickname
       FROM hk_casinobets b LEFT JOIN hk_steak_vip v ON b.identifier = v.identifier
       ORDER BY b.played_at DESC LIMIT 6`)
    const recentBets = recent.map(b => ({
      game: b.game, stake: b.stake, multiplier: b.multiplier, payout: b.payout,
      won: b.won, played_at: b.played_at,
      playerName: (b.nickname && b.show_nickname === 1) ? b.nickname : 'Hidden',
    }))
    const [[last]] = [await pool.query(
      'SELECT game FROM hk_casinobets WHERE identifier = ? ORDER BY played_at DESC LIMIT 1', [cid])]
    res.json({ recentBets, lastGame: last ? last.game : null })
  } catch (e) {
    console.error('[steak/casino/home]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── VIP AWARD: the full awardVip DB cluster (replaces ~20 vip.lua writes) ──
// Does all zx_wxyz_stream bookkeeping and RETURNS side-effects the resource must
// apply (tier-up cash/homecoin, client messages). Engine never pays money.
router.post('/vip/award', async (req, res) => {
  try {
    const { identifier, stake, payout, isCasino, game, isWeekend } = req.body
    if (!identifier || stake == null) return res.status(400).json({ error: 'missing fields' })
    const pool = getPool()
    await ensureVipRow(pool, identifier)   // guarantee row + referral_code exists
    const st = Number(stake) || 0
    const pay = Number(payout) || 0

    // xp gain (mirrors AddVipXP)
    const mult = isCasino
      ? (isWeekend ? VIP.xpMultWeekend.casino : VIP.xpMult.casino)
      : (isWeekend ? VIP.xpMultWeekend.sports : VIP.xpMult.sports)
    const xpGain = st >= 500 ? Math.floor(st * mult) : 0

    const wagerCol = isCasino ? 'total_wagered_casino' : 'total_wagered_sports'
    const countCol = isCasino ? 'casino_bets_count' : 'sports_bets_count'
    const wonCol = isCasino ? 'total_won_casino' : 'total_won_sports'

    await pool.query(
      `INSERT INTO hk_steak_vip (identifier, xp, ${wagerCol}, ${countCol}, ${wonCol}, biggest_win)
       VALUES (?, ?, ?, 1, ?, GREATEST(0, ?))
       ON DUPLICATE KEY UPDATE xp = xp + ?, ${wagerCol} = ${wagerCol} + ?,
         ${countCol} = ${countCol} + 1, ${wonCol} = ${wonCol} + ?,
         biggest_win = GREATEST(biggest_win, ?)`,
      [identifier, xpGain, st, pay, pay, xpGain, st, pay, pay]
    )

    const [vrows] = await pool.query(
      'SELECT xp, rakeback_balance, last_tier, referred_by FROM hk_steak_vip WHERE identifier = ?',
      [identifier]
    )
    const row = vrows[0]
    const result = { xpGain, tierUp: null, reward: null }
    if (!row) return res.json(result)

    const level = getVipLevel((row.xp || 0))
    const tier = level.tier || 'Bronze'

    // rakeback accrual
    const rakeRate = VIP.rakeback[tier] || 0
    const gameKey = isCasino ? (game || 'dice') : 'sports'
    const edge = VIP.houseEdge[gameKey] || 0.02
    const rakebackEarned = Math.floor(st * edge * rakeRate)
    if (rakebackEarned > 0) {
      await pool.query('UPDATE hk_steak_vip SET rakeback_balance = rakeback_balance + ? WHERE identifier = ?',
        [rakebackEarned, identifier])
    }
    // referral kickback
    if (row.referred_by) {
      const kickback = Math.floor(st * VIP.referralKickback)
      if (kickback > 0) {
        await pool.query(
          'UPDATE hk_steak_vip SET rakeback_balance = rakeback_balance + ?, referral_earned = referral_earned + ? WHERE identifier = ?',
          [kickback, kickback, row.referred_by])
      }
    }
    // weekly race + pool
    const ws = weekStart()
    await pool.query(
      `INSERT INTO hk_steak_race (identifier, week_start, wagered) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE wagered = wagered + ?`, [identifier, ws, st, st])
    const poolContrib = Math.floor(st * VIP.racePoolPercent)
    if (poolContrib > 0) {
      await pool.query(
        `INSERT INTO hk_steak_race (identifier, week_start, wagered) VALUES ('__pool__', ?, ?)
         ON DUPLICATE KEY UPDATE wagered = wagered + ?`, [ws, poolContrib, poolContrib])
    }
    // big win — qualify by MULTIPLIER only (a genuine lucky hit), not stake size.
    // A 1.2x on a whale bet is not a "big win" no matter the payout.
    const won = pay > 0
    if (won) {
      const m = pay / Math.max(1, st)
      if (m >= 10) {
        // label with the specific game (mines/plinko/dice/...) when provided,
        // else fall back to casino/sports.
        const gameLabel = (game && String(game).trim()) || (isCasino ? 'casino' : 'sports')
        await pool.query(
          'INSERT INTO hk_steak_bigwins (identifier, game, stake, multiplier, payout) VALUES (?, ?, ?, ?, ?)',
          [identifier, String(gameLabel).slice(0, 32), st, m, pay])
      }
    }
    // loss streak
    const minStreakStake = Math.max(1000, Math.floor(MaxBet * 0.01))
    if (won) {
      await pool.query('UPDATE hk_steak_vip SET loss_streak = 0 WHERE identifier = ?', [identifier])
    } else if (isCasino && st >= minStreakStake) {
      await pool.query('UPDATE hk_steak_vip SET loss_streak = loss_streak + 1 WHERE identifier = ?', [identifier])
    }
    // tier-up
    const oldTierId = row.last_tier || 'bronze_3'
    const newTierId = level.id
    if (newTierId !== oldTierId) {
      await pool.query('UPDATE hk_steak_vip SET last_tier = ? WHERE identifier = ?', [newTierId, identifier])
      const reward = VIP.levelUpRewards[newTierId]
      if (reward) {
        const [cnt] = await pool.query(
          'SELECT COUNT(*) AS c FROM hk_steak_tier_history WHERE identifier = ? AND tier_id = ?',
          [identifier, newTierId])
        if (Number(cnt[0].c) === 0) {
          const [ins] = await pool.query(
            'INSERT IGNORE INTO hk_steak_tier_history (identifier, tier_id, rewarded_cash, rewarded_hc) VALUES (?, ?, ?, ?)',
            [identifier, newTierId, reward.cash || 0, reward.homecoin || 0])
          if (ins.affectedRows > 0) {
            result.tierUp = { id: newTierId, name: level.name }
            result.reward = { cash: reward.cash || 0, homecoin: reward.homecoin || 0 }
          }
        }
      }
    }
    res.json(result)
  } catch (e) {
    console.error('[steak/vip/award]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── VIP TAX (ApplyBetTax) — pure math + one xp read ──
router.post('/vip/tax', async (req, res) => {
  try {
    const { identifier, stake, payout, isWeekend } = req.body
    const st = Number(stake) || 0, pay = Number(payout) || 0
    if (pay <= st) return res.json({ netPayout: pay, gov: 0, fee: 0 })
    const effMult = pay / Math.max(1, st)
    if (effMult <= VIP.taxThresholdMult) return res.json({ netPayout: pay, gov: 0, fee: 0 })

    const pool = getPool()
    const [rows] = await pool.query('SELECT xp FROM hk_steak_vip WHERE identifier = ?', [identifier])
    const level = getVipLevel(rows[0] ? rows[0].xp : 0)
    const rates = VIP.taxRates[level.tier] || { gov: 0.05, fee: 0.02 }
    let totalRate = rates.gov + rates.fee
    if (isWeekend) totalRate = Math.max(0, totalRate - VIP.taxWeekendDiscount)
    const profit = pay - st
    const taxAmount = Math.floor(profit * totalRate)
    const gov = Math.floor(profit * rates.gov)
    res.json({ netPayout: pay - taxAmount, gov, fee: taxAmount - gov })
  } catch (e) {
    console.error('[steak/vip/tax]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── raw VIP row (ensures existence + referral code); mirrors resource ensureVipRow ──
router.get('/vip/row/:cid', async (req, res) => {
  try {
    const pool = getPool()
    await ensureVipRow(pool, req.params.cid)
    const [rows] = await pool.query('SELECT * FROM hk_steak_vip WHERE identifier = ?', [req.params.cid])
    res.json(rows[0] || null)
  } catch (e) {
    console.error('[steak/vip/row]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── VIP DATA (getVipData reads) ──
router.get('/vip/data/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.cid
    // ensure row exists
    await ensureVipRow(pool, cid)
    const [rows] = await pool.query('SELECT * FROM hk_steak_vip WHERE identifier = ?', [cid])
    const row = rows[0] || { xp: 0 }
    const level = getVipLevel(row.xp || 0)
    const next = getNextLevel(row.xp || 0)
    const ws = weekStart()
    const weeklyAvail = !row.weekly_claimed_at ||
      ws > new Date(row.weekly_claimed_at).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    const dailyAvail = !row.daily_claimed_at ||
      today > new Date(row.daily_claimed_at).toISOString().slice(0, 10)
    const [refc] = await pool.query('SELECT COUNT(*) AS c FROM hk_steak_vip WHERE referred_by = ?', [cid])
    res.json({
      xp: row.xp || 0,
      vip: {
        level: level.name, color: level.color, xp: row.xp || 0,
        currentLevelXP: level.minXP, nextLevel: next ? next.name : null,
        nextXP: next ? next.minXP : null,
      },
      rakebackBalance: row.rakeback_balance || 0,
      weeklyAvailable: weeklyAvail, dailyAvailable: dailyAvail,
      referralCode: row.referral_code, referralCount: Number(refc[0].c) || 0,
      referralEarned: row.referral_earned || 0, lossStreak: row.loss_streak || 0,
    })
  } catch (e) {
    console.error('[steak/vip/data]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── CLAIMS: engine does the atomic DB guard, returns amount for resource to pay ──
router.post('/vip/claim/weekly', async (req, res) => {
  try {
    const cid = req.body.identifier
    if (!cid) return res.status(400).json({ error: 'missing identifier' })
    const pool = getPool()
    await ensureVipRow(pool, cid)
    const [rows] = await pool.query('SELECT xp, weekly_claimed_at FROM hk_steak_vip WHERE identifier = ?', [cid])
    const row = rows[0]
    const level = getVipLevel(row.xp || 0)
    const reward = VIP.weeklyRewards[level.tier] || 0
    if (reward <= 0) return res.json({ success: false, message: 'No weekly reward for your tier' })
    // atomic: only claim if not already this week
    const ws = weekStart()
    const [upd] = await pool.query(
      `UPDATE hk_steak_vip SET weekly_claimed_at = NOW()
       WHERE identifier = ? AND (weekly_claimed_at IS NULL OR DATE(weekly_claimed_at) < ?)`,
      [cid, ws])
    if (upd.affectedRows === 0) return res.json({ success: false, message: 'Already claimed this week' })
    res.json({ success: true, cash: reward, homecoin: 0 })
  } catch (e) { console.error('[steak/claim/weekly]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/claim/daily', async (req, res) => {
  try {
    const cid = req.body.identifier
    if (!cid) return res.status(400).json({ error: 'missing identifier' })
    const pool = getPool()
    await ensureVipRow(pool, cid)
    const [rows] = await pool.query('SELECT xp, daily_claimed_at FROM hk_steak_vip WHERE identifier = ?', [cid])
    const row = rows[0]
    const bonus = VIP.dailyBonus[getVipLevel(row.xp || 0).tier]
    if (!bonus) return res.json({ success: false, message: 'Daily bonus requires Diamond+' })
    const [upd] = await pool.query(
      `UPDATE hk_steak_vip SET daily_claimed_at = NOW()
       WHERE identifier = ? AND (daily_claimed_at IS NULL OR DATE(daily_claimed_at) < CURDATE())`,
      [cid])
    if (upd.affectedRows === 0) return res.json({ success: false, message: 'Already claimed today' })
    res.json({ success: true, cash: bonus.cash || 0, homecoin: bonus.homecoin || 0 })
  } catch (e) { console.error('[steak/claim/daily]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/claim/rakeback', async (req, res) => {
  try {
    const cid = req.body.identifier
    if (!cid) return res.status(400).json({ error: 'missing identifier' })
    const pool = getPool()
    const [rows] = await pool.query('SELECT rakeback_balance FROM hk_steak_vip WHERE identifier = ?', [cid])
    const bal = (rows[0] && rows[0].rakeback_balance) || 0
    if (bal <= 0) return res.json({ success: false, message: 'No rewards to claim' })
    // atomic drain
    const [upd] = await pool.query(
      'UPDATE hk_steak_vip SET rakeback_balance = 0 WHERE identifier = ? AND rakeback_balance >= ?', [cid, bal])
    if (upd.affectedRows === 0) return res.json({ success: false, message: 'Claim failed — try again' })
    res.json({ success: true, cash: bal, homecoin: 0 })
  } catch (e) { console.error('[steak/claim/rakeback]', e.message); res.status(500).json({ error: 'internal error' }) }
})

// ── bet-ceiling + loss-streak (GetPlayerMaxBet / CheckLossStreakProtection) ──
router.get('/vip/maxbet/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query('SELECT xp, personal_max_bet FROM hk_steak_vip WHERE identifier = ?', [req.params.cid])
    const row = rows[0]
    if (!row) return res.json({ maxBet: 10000 })
    const tierMax = Math.min(getVipLevel(row.xp || 0).maxBet, MaxBet)
    const pmb = row.personal_max_bet
    res.json({ maxBet: (pmb && pmb < tierMax) ? pmb : tierMax })
  } catch (e) { console.error('[steak/maxbet]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/lossstreak-check', async (req, res) => {
  try {
    const { identifier, stake } = req.body
    const pool = getPool()
    const [rows] = await pool.query('SELECT xp, loss_streak FROM hk_steak_vip WHERE identifier = ?', [identifier])
    const row = rows[0]
    if (!row) return res.json({ refund: 0 })
    if ((row.loss_streak || 0) < VIP.lossStreak.threshold) return res.json({ refund: 0 })
    const refundRate = VIP.lossStreak.refund[getVipLevel(row.xp || 0).tier]
    if (!refundRate) return res.json({ refund: 0 })
    const [upd] = await pool.query(
      'UPDATE hk_steak_vip SET loss_streak = 0 WHERE identifier = ? AND loss_streak >= ?',
      [identifier, VIP.lossStreak.threshold])
    if (upd.affectedRows === 0) return res.json({ refund: 0 })
    res.json({ refund: Math.floor((Number(stake) || 0) * refundRate) })
  } catch (e) { console.error('[steak/lossstreak]', e.message); res.status(500).json({ error: 'internal error' }) }
})

// ── LEADERBOARD (race / bigwins / alltime) ──
router.get('/leaderboard/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.cid
    const ws = weekStart()
    const dn = (r) => (r.nickname && r.show_nickname === 1) ? r.nickname : 'Hidden'

    const [raceRows] = await pool.query(
      `SELECT r.identifier, r.wagered, v.xp, v.nickname, v.show_nickname
       FROM hk_steak_race r LEFT JOIN hk_steak_vip v ON v.identifier = r.identifier
       WHERE r.week_start = ? AND r.identifier != '__pool__'
       ORDER BY r.wagered DESC LIMIT 20`, [ws])
    const [[poolRow]] = [await pool.query(
      "SELECT COALESCE(wagered,0) AS w FROM hk_steak_race WHERE identifier='__pool__' AND week_start=?", [ws])]
    const race = raceRows.map(r => {
      const lv = getVipLevel(r.xp || 0)
      return { name: dn(r), level: lv.name, color: lv.color, wagered: r.wagered, isMe: r.identifier === cid }
    })

    // Big wins ranked by MULTIPLIER (highest lucky hits first), not recency/stake.
    const [bwRows] = await pool.query(
      `SELECT b.identifier, b.game, b.stake, b.multiplier, b.payout, b.created_at, v.xp, v.nickname, v.show_nickname
       FROM hk_steak_bigwins b LEFT JOIN hk_steak_vip v ON v.identifier = b.identifier
       ORDER BY b.multiplier DESC LIMIT 50`)
    const bigwins = bwRows.map(r => {
      const lv = getVipLevel(r.xp || 0)
      return { name: dn(r), level: lv.name, color: lv.color, game: r.game, stake: r.stake,
               multiplier: r.multiplier, payout: r.payout, time: r.created_at }
    })

    // All-Time tab removed — it read like a big-win page. Leaderboard = Race + Big Wins.
    res.json({ race, bigwins, racePool: Number(poolRow && poolRow.w) || 0 })
  } catch (e) { console.error('[steak/leaderboard]', e.message); res.status(500).json({ error: 'internal error' }) }
})

// ── MY STATS (vip row + recent bets); maxBet computed here too ──
router.get('/mystats/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const cid = req.params.cid
    await ensureVipRow(pool, cid)
    const [vr] = await pool.query('SELECT * FROM hk_steak_vip WHERE identifier = ?', [cid])
    const s = vr[0] || { xp: 0 }
    const level = getVipLevel(s.xp || 0), next = getNextLevel(s.xp || 0)
    const tierMax = Math.min(level.maxBet, MaxBet)
    const maxBet = (s.personal_max_bet && s.personal_max_bet < tierMax) ? s.personal_max_bet : tierMax
    const [sb] = await pool.query('SELECT * FROM hk_sportsbets WHERE identifier = ? ORDER BY placed_at DESC LIMIT 50', [cid])
    const [cb] = await pool.query('SELECT * FROM hk_casinobets WHERE identifier = ? ORDER BY played_at DESC LIMIT 50', [cid])
    res.json({
      vip: { level: level.name, color: level.color, xp: s.xp, currentLevelXP: level.minXP,
             nextLevel: next ? next.name : null, nextXP: next ? next.minXP : null, maxBet },
      stats: {
        totalWageredSports: s.total_wagered_sports, totalWageredCasino: s.total_wagered_casino,
        totalWonSports: s.total_won_sports, totalWonCasino: s.total_won_casino,
        sportsBetsCount: s.sports_bets_count, casinoBetsCount: s.casino_bets_count, biggestWin: s.biggest_win,
      },
      sportsBets: sb, casinoBets: cb,
    })
  } catch (e) { console.error('[steak/mystats]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/clear-stats', async (req, res) => {
  try {
    await getPool().query(
      `UPDATE hk_steak_vip SET total_wagered_sports=0, total_wagered_casino=0, total_won_sports=0,
       total_won_casino=0, sports_bets_count=0, casino_bets_count=0, biggest_win=0 WHERE identifier=?`,
      [req.body.identifier])
    res.json({ success: true })
  } catch (e) { console.error('[steak/clear-stats]', e.message); res.status(500).json({ error: 'internal error' }) }
})

// ── SETTINGS read + mutations ──
router.get('/vip/settings/:cid', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      'SELECT nickname, show_nickname, personal_max_bet, nickname_updated_at, referral_code, referred_by FROM hk_steak_vip WHERE identifier = ?',
      [req.params.cid])
    const row = rows[0]
    // First nickname is always free; cooldown only gates changes once one is set.
    let canChangeNick = true
    if (row && row.nickname && row.nickname_updated_at) {
      const elapsed = (Date.now() - new Date(row.nickname_updated_at).getTime()) / 1000
      canChangeNick = elapsed >= 1800
    }
    res.json({
      nickname: row ? row.nickname : null,
      showNickname: row ? row.show_nickname === 1 : true,
      personalMaxBet: row ? row.personal_max_bet : null,
      canChangeNick,
      referralCode: row ? row.referral_code : null,
      hasReferrer: row ? row.referred_by != null : false,
    })
  } catch (e) { console.error('[steak/settings]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/nickname', async (req, res) => {
  try {
    const { identifier, nickname } = req.body
    const nick = String(nickname || '').slice(0, 20).replace(/<[^>]*>/g, '').replace(/[<>"'`&;/\\%]/g, '').trim()
    if (nick.length < 2) return res.json({ success: false, message: 'Nickname must be at least 2 characters' })
    const pool = getPool()
    const [rows] = await pool.query('SELECT nickname, nickname_updated_at FROM hk_steak_vip WHERE identifier = ?', [identifier])
    // Cooldown applies only to CHANGES — the first nickname a player ever sets is
    // free. If they already have a nickname, enforce the 30-min cooldown.
    if (rows[0] && rows[0].nickname && rows[0].nickname_updated_at) {
      const left = 1800 - (Date.now() - new Date(rows[0].nickname_updated_at).getTime()) / 1000
      if (left > 0) return res.json({ success: false, message: 'Wait ' + Math.ceil(left / 60) + ' min before changing nickname' })
    }
    await ensureVipRow(pool, identifier)
    await pool.query('UPDATE hk_steak_vip SET nickname = ?, nickname_updated_at = NOW() WHERE identifier = ?', [nick, identifier])
    res.json({ success: true, nickname: nick })
  } catch (e) { console.error('[steak/nickname]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/show-nickname', async (req, res) => {
  try {
    await getPool().query('UPDATE hk_steak_vip SET show_nickname = ? WHERE identifier = ?',
      [req.body.show ? 1 : 0, req.body.identifier])
    res.json({ success: true, showNickname: !!req.body.show })
  } catch (e) { console.error('[steak/show-nickname]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/max-bet', async (req, res) => {
  try {
    let mb = Number(req.body.maxBet)
    const minBet = Number(req.body.minBet) || 20
    if (!mb || mb < minBet) mb = null
    if (mb && mb > MaxBet) mb = MaxBet
    await getPool().query('UPDATE hk_steak_vip SET personal_max_bet = ? WHERE identifier = ?', [mb, req.body.identifier])
    res.json({ success: true, personalMaxBet: mb })
  } catch (e) { console.error('[steak/max-bet]', e.message); res.status(500).json({ error: 'internal error' }) }
})

router.post('/vip/referral', async (req, res) => {
  try {
    const { identifier } = req.body
    const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    if (code.length < 4) return res.json({ success: false, message: 'Invalid referral code' })
    const pool = getPool()
    const [mr] = await pool.query('SELECT referred_by, referral_code FROM hk_steak_vip WHERE identifier = ?', [identifier])
    const my = mr[0]
    if (!my) return res.json({ success: false, message: 'No account' })
    if (my.referred_by) return res.json({ success: false, message: 'You already have a referrer' })
    if (my.referral_code === code) return res.json({ success: false, message: 'Cannot use your own code' })
    const [rr] = await pool.query('SELECT identifier FROM hk_steak_vip WHERE referral_code = ?', [code])
    if (!rr[0]) return res.json({ success: false, message: 'Code not found' })
    const [upd] = await pool.query(
      'UPDATE hk_steak_vip SET referred_by = ? WHERE identifier = ? AND referred_by IS NULL',
      [rr[0].identifier, identifier])
    if (upd.affectedRows === 0) return res.json({ success: false, message: 'Already have a referrer' })
    res.json({ success: true, message: 'Referral linked! Your friend earns from your bets now.' })
  } catch (e) { console.error('[steak/referral]', e.message); res.status(500).json({ error: 'internal error' }) }
})

module.exports = router
