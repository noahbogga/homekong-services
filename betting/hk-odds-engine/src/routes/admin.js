const express = require('express')
const { getPool } = require('../db')
const { getActiveGames } = require('../gamePersist')
const { getCacheRaw, getCachedSports, setCache } = require('../oddsCache')
const { deriveFromH2H } = require('../deriveMarkets')
const { anchorEventToCurrent, fetchOddsForSport, filterUpcoming, storeBaseOdds, clearAiAnchor } = require('../crons/odds')
const { sanitizeH2H, stampSeed } = require('../oddsSanity')
const casino = require('./casino') // instant exclusion-cache mutators (dropExcluded/addExcluded)
const { requestIdentitySync } = require('../syncState')

const router = express.Router()

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'CHANGE_ME'

router.use((req, res, next) => {
  const token = req.headers['x-admin-token']
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

// NB: the QBCore `players` table (charinfo, steam name) lives on the ISOLATED
// game DB (.235), NOT this betting DB (zx_wxyz_stream). Any query that joins
// `players` 500s here with "Table 'zx_wxyz_stream.players' doesn't exist".
// So the panel resolves display names from hk_steak_vip.nickname only; charName
// / steamName are always null and the frontend falls back to nickname → id.

// Helper: name lookup from LOCAL tables (VIP nickname + synced identity mirror).
// No live game-DB access — hk_player_identity is refreshed by identitySync.js.
async function getCharName(pool, citizenid) {
  const [[row]] = await pool.query(
    `SELECT v.nickname, pi.char_name, pi.cid, pi.job, pi.job_grade, pi.cash, pi.bank, pi.synced_at
     FROM hk_steak_vip v
     LEFT JOIN hk_player_identity pi ON v.identifier = pi.identifier
     WHERE v.identifier = ?`, [citizenid]
  )
  if (!row) return { charName: null, steamName: null, nickname: null, identity: null }
  return {
    charName: row.char_name || null,
    steamName: null,
    nickname: row.nickname || null,
    identity: row.char_name || row.job || row.cash != null ? {
      charName: row.char_name || null, cid: row.cid || null,
      job: row.job || null, jobGrade: row.job_grade || null,
      cash: row.cash, bank: row.bank, syncedAt: row.synced_at || null,
    } : null,
  }
}

// Helper: bulk resolve names from VIP nicknames + mirrored QBCore char names.
// The QBCore `players` table lives on the isolated .235 game DB (no creds here),
// so char names come from hk_player_identity (pushed by the resource), not a join.
async function resolveNames(pool, identifiers) {
  if (!identifiers.length) return {}
  const [rows] = await pool.query(
    `SELECT v.identifier, v.nickname, pi.char_name, pi.cid
       FROM hk_steak_vip v
       LEFT JOIN hk_player_identity pi ON pi.identifier = v.identifier
      WHERE v.identifier IN (?)
      UNION
     SELECT pi.identifier, NULL AS nickname, pi.char_name, pi.cid
       FROM hk_player_identity pi
      WHERE pi.identifier IN (?)`,
    [identifiers, identifiers]
  )
  const map = {}
  for (const row of rows) {
    const prev = map[row.identifier] || {}
    map[row.identifier] = {
      charName: row.char_name || prev.charName || null,
      cid: row.cid || prev.cid || null,
      steamName: null,
      nickname: row.nickname || prev.nickname || null,
    }
  }
  return map
}

// --- Dashboard Stats ---
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool()
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 19).replace('T', ' ')
    const weekStart = new Date(now - now.getDay() * 86400000)
    weekStart.setHours(0, 0, 0, 0)
    const weekStartStr = weekStart.toISOString().slice(0, 19).replace('T', ' ')

    const [[todayRow]] = await pool.query(
      `SELECT COUNT(*) as total_bets, COALESCE(SUM(stake),0) as total_wagered,
              COALESCE(SUM(payout),0) as total_payout, SUM(CASE WHEN won=1 THEN 1 ELSE 0 END) as wins
       FROM hk_casinobets WHERE played_at >= ?`, [todayStart]
    )
    const [[weekRow]] = await pool.query(
      `SELECT COUNT(*) as total_bets, COALESCE(SUM(stake),0) as total_wagered,
              COALESCE(SUM(payout),0) as total_payout
       FROM hk_casinobets WHERE played_at >= ?`, [weekStartStr]
    )
    const [gameBreakdown] = await pool.query(
      `SELECT game, COUNT(*) as bets, COALESCE(SUM(stake),0) as wagered,
              COALESCE(SUM(payout),0) as paid_out
       FROM hk_casinobets WHERE played_at >= ? GROUP BY game`, [todayStart]
    )
    const [[uniquePlayers]] = await pool.query(
      `SELECT COUNT(DISTINCT identifier) as count FROM hk_casinobets WHERE played_at >= ?`, [todayStart]
    )
    const [[allTimeRow]] = await pool.query(
      `SELECT COUNT(*) as total_bets, COALESCE(SUM(stake),0) as total_wagered, COALESCE(SUM(payout),0) as total_payout FROM hk_casinobets`
    )
    const [[excluded]] = await pool.query(`SELECT COUNT(*) as count FROM hk_casino_exclusions WHERE active = 1`)

    res.json({
      today: { ...todayRow, house_profit: todayRow.total_wagered - todayRow.total_payout },
      week: { ...weekRow, house_profit: weekRow.total_wagered - weekRow.total_payout },
      allTime: { ...allTimeRow, house_profit: allTimeRow.total_wagered - allTimeRow.total_payout },
      gameBreakdown,
      uniquePlayersToday: uniquePlayers.count,
      excludedPlayers: excluded.count,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Player Lookup ---
router.get('/players', async (req, res) => {
  try {
    const pool = getPool()
    const { search, page = 1, limit = 25 } = req.query
    const offset = (page - 1) * limit
    let where = ''
    let params = []

    // Search identifier + nickname + synced char name (hk_player_identity is the
    // LOCAL mirror of the game DB, kept fresh by identitySync.js).
    if (search) {
      where = `WHERE v.identifier LIKE ? OR v.nickname LIKE ? OR pi.char_name LIKE ?`
      params = [`%${search}%`, `%${search}%`, `%${search}%`]
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM hk_steak_vip v
       LEFT JOIN hk_player_identity pi ON v.identifier = pi.identifier ${where}`, params
    )

    const [rows] = await pool.query(
      `SELECT v.*,
              pi.char_name, pi.cid, pi.job, pi.job_grade,
              (v.total_wagered_casino + v.total_wagered_sports) as total_wagered,
              (v.total_won_casino + v.total_won_sports) as total_won,
              e.active as excluded
       FROM hk_steak_vip v
       LEFT JOIN hk_player_identity pi ON v.identifier = pi.identifier
       LEFT JOIN hk_casino_exclusions e ON v.identifier = e.identifier AND e.active = 1
       ${where}
       ORDER BY v.total_wagered_casino DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    )

    const players = rows.map(r => ({ ...r, charName: r.char_name || null }))

    res.json({ players, total, page: parseInt(page), limit: parseInt(limit) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/players/:identifier', async (req, res) => {
  try {
    const pool = getPool()
    const id = req.params.identifier

    const [[player]] = await pool.query(`SELECT * FROM hk_steak_vip WHERE identifier = ?`, [id])
    if (!player) return res.status(404).json({ error: 'player not found' })

    // Optional sections: some tables (e.g. hk_fair_seeds) may not exist in every
    // deployment of the betting DB. A missing table must NOT 500 the whole page,
    // so each optional query degrades to its empty default.
    const opt = async (fn, fallback) => { try { return await fn() } catch { return fallback } }

    const names = await opt(() => getCharName(pool, id), { charName: null, steamName: null, nickname: null })
    const recentBets = await opt(async () =>
      (await pool.query(`SELECT * FROM hk_casinobets WHERE identifier = ? ORDER BY played_at DESC LIMIT 50`, [id]))[0], [])
    const recentSportsBets = await opt(async () =>
      (await pool.query(`SELECT id, match_desc, market, selection, odds, stake, potential_win, status, payout, placed_at, settled_at
                         FROM hk_sportsbets WHERE identifier = ? ORDER BY placed_at DESC LIMIT 50`, [id]))[0], [])
    const seeds = await opt(async () =>
      (await pool.query(`SELECT * FROM hk_fair_seeds WHERE identifier = ?`, [id]))[0][0], null)
    const tierHistory = await opt(async () =>
      (await pool.query(`SELECT * FROM hk_steak_tier_history WHERE identifier = ? ORDER BY reached_at DESC LIMIT 10`, [id]))[0], [])
    const raceEntry = await opt(async () =>
      (await pool.query(`SELECT * FROM hk_steak_race WHERE identifier = ? ORDER BY week_start DESC LIMIT 1`, [id]))[0][0], null)
    const exclusion = await opt(async () =>
      (await pool.query(`SELECT * FROM hk_casino_exclusions WHERE identifier = ? AND active = 1`, [id]))[0][0], null)

    res.json({ player, names, recentBets, recentSportsBets, seeds, tierHistory, raceEntry, exclusion })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Bet Explorer ---
router.get('/bets', async (req, res) => {
  try {
    const pool = getPool()
    const { game, page = 1, limit = 50, from, to, identifier, minStake } = req.query
    const offset = (page - 1) * limit
    let conditions = []
    let params = []

    if (game) { conditions.push('b.game = ?'); params.push(game) }
    if (identifier) { conditions.push('b.identifier LIKE ?'); params.push(`%${identifier}%`) }
    if (from) { conditions.push('b.played_at >= ?'); params.push(from) }
    if (to) { conditions.push('b.played_at <= ?'); params.push(to) }
    if (minStake) { conditions.push('b.stake >= ?'); params.push(parseInt(minStake)) }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM hk_casinobets b ${where}`, params)

    const [rows] = await pool.query(
      `SELECT b.*, v.nickname, pi.char_name, pi.cid
       FROM hk_casinobets b
       LEFT JOIN hk_steak_vip v ON b.identifier = v.identifier
       LEFT JOIN hk_player_identity pi ON pi.identifier = b.identifier
       ${where} ORDER BY b.played_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    )

    const bets = rows.map(r => ({ ...r, charName: r.char_name || null, cid: r.cid || null }))

    res.json({ bets, total, page: parseInt(page), limit: parseInt(limit) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- VIP Management ---
router.get('/vip/race', async (req, res) => {
  try {
    const pool = getPool()
    const [leaderboard] = await pool.query(
      `SELECT r.*, v.nickname
       FROM hk_steak_race r
       LEFT JOIN hk_steak_vip v ON r.identifier = v.identifier
       WHERE r.week_start = (SELECT MAX(week_start) FROM hk_steak_race)
       ORDER BY r.wagered DESC LIMIT 20`
    )
    const [[prizePool]] = await pool.query(
      `SELECT COALESCE(SUM(wagered),0) * 0.001 as pool FROM hk_steak_race
       WHERE week_start = (SELECT MAX(week_start) FROM hk_steak_race)`
    )
    const mapped = leaderboard.map(r => ({ ...r, charName: null }))
    res.json({ leaderboard: mapped, prizePool: Math.floor(prizePool.pool) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/vip/tiers', async (req, res) => {
  try {
    const pool = getPool()
    // Thresholds mirror steakConfig.js VIP.levels (BILLIONS scale). The old
    // query used a millions scale, which mislabelled every player's tier.
    const [distribution] = await pool.query(
      `SELECT
              CASE
                WHEN xp >= 2500000000 THEN 'Emerald I'
                WHEN xp >= 1750000000 THEN 'Emerald II'
                WHEN xp >= 1250000000 THEN 'Emerald III'
                WHEN xp >= 1000000000 THEN 'Diamond I'
                WHEN xp >= 750000000  THEN 'Diamond II'
                WHEN xp >= 500000000  THEN 'Diamond III'
                WHEN xp >= 200000000  THEN 'Platinum I'
                WHEN xp >= 100000000  THEN 'Platinum II'
                WHEN xp >= 50000000   THEN 'Platinum III'
                WHEN xp >= 15000000   THEN 'Gold'
                WHEN xp >= 5000000    THEN 'Silver'
                WHEN xp >= 1500000    THEN 'Bronze I'
                WHEN xp >= 500000     THEN 'Bronze II'
                ELSE 'Bronze III'
              END as tier,
              COUNT(*) as count
       FROM hk_steak_vip GROUP BY tier ORDER BY MIN(xp) DESC`
    )
    res.json({ distribution })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/vip/adjust', async (req, res) => {
  try {
    const pool = getPool()
    const { identifier, field, value } = req.body
    const allowed = ['xp', 'personal_max_bet', 'nickname', 'rakeback_balance', 'loss_streak', 'last_tier']
    if (!allowed.includes(field)) return res.status(400).json({ error: 'field not allowed' })
    await pool.query(`UPDATE hk_steak_vip SET ${field} = ? WHERE identifier = ?`, [value, identifier])
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Player Reset ---
router.post('/players/:identifier/reset', async (req, res) => {
  try {
    const pool = getPool()
    const id = req.params.identifier
    const { type } = req.body // 'stats', 'vip', 'all'

    if (type === 'stats' || type === 'all') {
      await pool.query(
        `UPDATE hk_steak_vip SET total_wagered_casino=0, total_won_casino=0,
         casino_bets_count=0, biggest_win=0, rakeback_balance=0, loss_streak=0
         WHERE identifier = ?`, [id]
      )
    }
    if (type === 'vip' || type === 'all') {
      await pool.query(`UPDATE hk_steak_vip SET xp=0, last_tier=NULL WHERE identifier = ?`, [id])
      await pool.query(`DELETE FROM hk_steak_tier_history WHERE identifier = ?`, [id])
    }
    if (type === 'all') {
      await pool.query(`DELETE FROM hk_steak_race WHERE identifier = ?`, [id])
      await pool.query(`DELETE FROM hk_fair_seeds WHERE identifier = ?`, [id])
      await pool.query(`DELETE FROM hk_fair_seed_history WHERE identifier = ?`, [id])
    }

    res.json({ success: true, reset: type })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Player Delete ---
router.delete('/players/:identifier', async (req, res) => {
  try {
    const pool = getPool()
    const id = req.params.identifier
    await pool.query(`DELETE FROM hk_steak_vip WHERE identifier = ?`, [id])
    await pool.query(`DELETE FROM hk_steak_race WHERE identifier = ?`, [id])
    await pool.query(`DELETE FROM hk_steak_tier_history WHERE identifier = ?`, [id])
    await pool.query(`DELETE FROM hk_fair_seeds WHERE identifier = ?`, [id])
    await pool.query(`DELETE FROM hk_fair_seed_history WHERE identifier = ?`, [id])
    await pool.query(`DELETE FROM hk_casino_exclusions WHERE identifier = ?`, [id])
    casino.dropExcluded(id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Identity sync trigger (admin panel "Sync names" button) ---
// Engine can't read the game DB — flag it and the resource picks it up on its
// next health poll (~15s) and pushes every character. See [[hk-casino-admin-names-exclusion-ui]].
router.post('/identity/sync', (req, res) => {
  requestIdentitySync()
  res.json({ success: true, message: 'Sync requested; names refresh within ~15s.' })
})

// --- Self-Exclusion (Pause) ---
router.post('/exclusion', async (req, res) => {
  try {
    const pool = getPool()
    const { identifier, reason, duration_hours } = req.body
    const expiresAt = duration_hours
      ? new Date(Date.now() + duration_hours * 3600000).toISOString().slice(0, 19).replace('T', ' ')
      : null

    await pool.query(
      `INSERT INTO hk_casino_exclusions (identifier, reason, expires_at, active, created_at)
       VALUES (?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE reason=VALUES(reason), expires_at=VALUES(expires_at), active=1, created_at=NOW()`,
      [identifier, reason || 'Admin exclusion', expiresAt]
    )
    casino.addExcluded(identifier) // pause takes effect immediately
    res.json({ success: true, expiresAt })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/exclusion/:identifier', async (req, res) => {
  try {
    const pool = getPool()
    const id = req.params.identifier
    // Hard-wipe the row (not just active=0) so a stuck/duplicated exclusion can't
    // linger, then drop it from the live cache so the lift is instant. Belt-and-braces
    // for the "pressed Lift but still banned" desync.
    await pool.query(`DELETE FROM hk_casino_exclusions WHERE identifier = ?`, [id])
    casino.dropExcluded(id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- PANIC: wipe ALL exclusions (recovery when the panel desyncs / bugs out) ---
// Clears every ban/cooldown from the DB AND the live in-memory set in one shot.
// Destructive but fully reversible by re-issuing exclusions; nobody stays wrongly locked.
router.post('/exclusions/wipe-all', async (req, res) => {
  try {
    const pool = getPool()
    const [r] = await pool.query(`DELETE FROM hk_casino_exclusions`)
    casino.clearAllExcluded()
    res.json({ success: true, wiped: r.affectedRows || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/exclusions', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT e.*, v.nickname, pi.char_name, pi.cid
       FROM hk_casino_exclusions e
       LEFT JOIN hk_steak_vip v ON e.identifier = v.identifier
       LEFT JOIN hk_player_identity pi ON pi.identifier = e.identifier
       WHERE e.active = 1 ORDER BY e.created_at DESC`
    )
    const mapped = rows.map(r => ({ ...r, charName: r.char_name || null, cid: r.cid || null }))
    res.json({ exclusions: mapped })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Big Wins ---
router.get('/bigwins', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT b.*, v.nickname, pi.char_name, pi.cid FROM hk_steak_bigwins b
       LEFT JOIN hk_steak_vip v ON b.identifier = v.identifier
       LEFT JOIN hk_player_identity pi ON pi.identifier = b.identifier
       ORDER BY b.id DESC LIMIT 50`
    )
    const mapped = rows.map(r => ({ ...r, charName: r.char_name || null, cid: r.cid || null }))
    res.json({ bigwins: mapped })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Provably Fair Audit ---
router.get('/fair/:identifier', async (req, res) => {
  try {
    const pool = getPool()
    const id = req.params.identifier
    const [[current]] = await pool.query(`SELECT * FROM hk_fair_seeds WHERE identifier = ?`, [id])
    const [history] = await pool.query(
      `SELECT * FROM hk_fair_seed_history WHERE identifier = ? ORDER BY rotated_at DESC LIMIT 20`, [id]
    )
    res.json({ current, history })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- System Health ---
router.get('/health', async (req, res) => {
  try {
    const pool = getPool()
    await pool.query('SELECT 1')

    res.json({
      engine: { uptime: process.uptime(), memory: { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed } },
      database: { connected: true },
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    res.json({
      engine: { uptime: process.uptime(), memory: process.memoryUsage() },
      database: { connected: false, error: err.message },
      timestamp: new Date().toISOString(),
    })
  }
})

// --- Identity mirror status ---
// Identity is PUSHED by the hk-sportsbetting resource (POST /steak/identity) from
// live QBCore PlayerData — the engine holds no game-DB credentials. This endpoint
// just reports how fresh the local mirror is (row count + newest sync time).
router.get('/identity/status', async (req, res) => {
  try {
    const pool = getPool()
    const [[row]] = await pool.query(
      'SELECT COUNT(*) AS mirrored, MAX(synced_at) AS last_synced FROM hk_player_identity')
    res.json({ mirrored: row.mirrored || 0, lastSynced: row.last_synced || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Active Games ---
router.get('/active-games', (req, res) => {
  const games = getActiveGames()
  res.json({ count: Object.keys(games).length, games })
})

// --- Hourly P&L (last 24h) ---
router.get('/stats/hourly', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(played_at, '%Y-%m-%d %H:00') as hour,
              COUNT(*) as bets, SUM(stake) as wagered, SUM(payout) as paid_out,
              SUM(stake) - SUM(payout) as profit
       FROM hk_casinobets
       WHERE played_at >= NOW() - INTERVAL 24 HOUR
       GROUP BY hour ORDER BY hour`
    )
    res.json({ hourly: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── SPORTS BOOK ───────────────────────────────────────────────────
// Sports bets live in hk_sportsbets (separate from casino's hk_casinobets).
// status: active | won | lost | void. For settled bets house_profit = stake -
// payout; won pays potential_win, void refunds stake, lost pays 0. "Exposure"
// is the sum of potential_win still owed on active bets (max liability).

// --- Sports P&L / revenue ---
router.get('/sports/stats', async (req, res) => {
  try {
    const pool = getPool()
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 19).replace('T', ' ')
    const weekStart = new Date(now - now.getDay() * 86400000)
    weekStart.setHours(0, 0, 0, 0)
    const weekStartStr = weekStart.toISOString().slice(0, 19).replace('T', ' ')

    // Settled-bet aggregates keyed off settled_at for the period windows.
    const settledCols = `COUNT(*) as total_bets, COALESCE(SUM(stake),0) as total_wagered,
              COALESCE(SUM(payout),0) as total_payout,
              SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) as wins`
    const [[todayRow]] = await pool.query(
      `SELECT ${settledCols} FROM hk_sportsbets WHERE status IN ('won','lost','void') AND settled_at >= ?`, [todayStart]
    )
    const [[weekRow]] = await pool.query(
      `SELECT ${settledCols} FROM hk_sportsbets WHERE status IN ('won','lost','void') AND settled_at >= ?`, [weekStartStr]
    )
    const [[allTimeRow]] = await pool.query(
      `SELECT ${settledCols} FROM hk_sportsbets WHERE status IN ('won','lost','void')`
    )
    // Open exposure = liability still owed on active bets.
    const [[openRow]] = await pool.query(
      `SELECT COUNT(*) as active_bets, COALESCE(SUM(stake),0) as active_stake,
              COALESCE(SUM(potential_win),0) as exposure
       FROM hk_sportsbets WHERE status = 'active'`
    )
    const [[uniquePlayers]] = await pool.query(
      `SELECT COUNT(DISTINCT identifier) as count FROM hk_sportsbets WHERE placed_at >= ?`, [todayStart]
    )

    const withProfit = r => ({ ...r, house_profit: r.total_wagered - r.total_payout })
    res.json({
      today: withProfit(todayRow),
      week: withProfit(weekRow),
      allTime: withProfit(allTimeRow),
      open: openRow,
      uniquePlayersToday: uniquePlayers.count,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Sports bet explorer (filterable + paginated) ---
router.get('/sports/bets', async (req, res) => {
  try {
    const pool = getPool()
    const { status, market, search, minStake, page = 1, limit = 25 } = req.query
    const offset = (page - 1) * limit
    const conds = []
    const params = []
    if (status) { conds.push('b.status = ?'); params.push(status) }
    if (market) { conds.push('b.market = ?'); params.push(market) }
    if (minStake) { conds.push('b.stake >= ?'); params.push(parseFloat(minStake)) }
    if (search) {
      conds.push('(b.identifier LIKE ? OR b.match_desc LIKE ? OR b.selection LIKE ?)')
      params.push(`%${search}%`, `%${search}%`, `%${search}%`)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM hk_sportsbets b ${where}`, params)
    // NB: no join to `players` — that table lives on the isolated game DB (.235),
    // not this betting DB (zx_wxyz_stream). Player display name comes from the
    // VIP nickname; the panel falls back to identifier when absent.
    const [rows] = await pool.query(
      `SELECT b.id, b.identifier, b.event_id, b.match_desc, b.market, b.selection, b.odds,
              b.stake, b.potential_win, b.status, b.payout, b.commence_time, b.placed_at, b.settled_at,
              v.nickname, pi.char_name, pi.cid
       FROM hk_sportsbets b
       LEFT JOIN hk_steak_vip v ON b.identifier = v.identifier
       LEFT JOIN hk_player_identity pi ON pi.identifier = b.identifier
       ${where}
       ORDER BY b.placed_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    )
    const bets = rows.map(r => ({ ...r, charName: r.char_name || null, cid: r.cid || null }))
    res.json({ bets, total, page: parseInt(page), limit: parseInt(limit) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Sports market breakdown (volume + P&L per market) ---
router.get('/sports/markets', async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT market,
              COUNT(*) as bets,
              COALESCE(SUM(stake),0) as wagered,
              SUM(CASE WHEN status IN ('won','lost','void') THEN 1 ELSE 0 END) as settled,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active,
              COALESCE(SUM(CASE WHEN status IN ('won','lost','void') THEN stake - payout ELSE 0 END),0) as house_profit
       FROM hk_sportsbets
       GROUP BY market ORDER BY bets DESC`
    )
    res.json({ markets: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Odds coverage (what the engine currently offers, live from cache) ---
router.get('/sports/coverage', (req, res) => {
  try {
    const sports = getCachedSports() || []
    const coverage = sports.map(sportKey => {
      const events = getCacheRaw(sportKey) || []
      let marketCount = 0
      let nextStart = null
      for (const ev of events) {
        if (ev.markets) marketCount += Object.keys(ev.markets).length
        const st = ev.startTime || ev.commence_time
        if (st && (!nextStart || st < nextStart)) nextStart = st
      }
      return { sportKey, matches: events.length, markets: marketCount, nextStart }
    }).sort((a, b) => b.matches - a.matches)
    const totalMatches = coverage.reduce((s, c) => s + c.matches, 0)
    res.json({ coverage, totalMatches, sportsTracked: coverage.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Manually settle / void an active sports bet ---
// Mirrors bets.js /settle math so panel-driven and resource-driven settlement
// agree: won → potential_win, void → stake refund, lost → 0.
router.post('/sports/settle', async (req, res) => {
  try {
    const { betId, result: outcome } = req.body
    if (!betId || !['won', 'lost', 'void'].includes(outcome)) {
      return res.status(400).json({ error: 'betId and result (won|lost|void) required' })
    }
    const pool = getPool()
    const [rows] = await pool.query(`SELECT * FROM hk_sportsbets WHERE id = ? AND status = 'active'`, [betId])
    if (!rows.length) return res.status(404).json({ error: 'bet not found or already settled' })
    const bet = rows[0]
    let payout = 0
    if (outcome === 'won') payout = bet.potential_win
    else if (outcome === 'void') payout = bet.stake
    const [upd] = await pool.query(
      `UPDATE hk_sportsbets SET status = ?, payout = ?, paid_out = 1, settled_at = NOW() WHERE id = ? AND status = 'active'`,
      [outcome, payout, betId]
    )
    if (upd.affectedRows === 0) return res.status(409).json({ error: 'bet was settled concurrently' })
    res.json({ success: true, betId, outcome, payout, identifier: bet.identifier, stake: bet.stake })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Live events for one sport (for the odds editor) ---
// Returns the current cached events with just the h2h prices + lock/AI flags, so the
// panel can list matches and spot insane lines without pulling every derived market.
router.get('/sports/events/:sportKey', (req, res) => {
  try {
    const events = getCacheRaw(req.params.sportKey) || []
    const out = events.map(ev => {
      const h2h = (ev.markets && ev.markets.h2h) || []
      const home = h2h.find(o => o.name === ev.homeTeam)
      const away = h2h.find(o => o.name === ev.awayTeam)
      const draw = h2h.find(o => /^(draw|tie|x)$/i.test(String(o.name || '').trim()))
      // implied max: the single longest price (used to flag "insane" lines in the UI)
      const maxPrice = h2h.reduce((m, o) => Math.max(m, o.price || 0), 0)
      return {
        id: ev.id, homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, startTime: ev.startTime,
        h2h: { home: home ? home.price : null, draw: draw ? draw.price : null, away: away ? away.price : null },
        maxPrice: +maxPrice.toFixed(2),
        locked: !!ev._oddsLocked, aiAdjusted: !!ev._aiAdjusted, aiTags: ev._aiTags || [],
      }
    }).sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
    res.json({ sportKey: req.params.sportKey, events: out })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Manual odds override for one match's 1X2 (h2h) ---
// Body: { sportKey, eventId, home, draw, away }  (decimal odds; draw optional for 2-way)
// Sets the h2h, RE-DERIVES all synthetic soccer markets from it (so AH/BTTS/CS/goals
// stay coherent), locks the match from AI re-adjust until the next daily seed, and
// re-anchors drift to the new line so it holds. The sanity clamp still applies, so you
// can't accidentally set a sub-floor price either.
router.post('/sports/odds', (req, res) => {
  try {
    const { sportKey, eventId, home, draw, away } = req.body || {}
    if (!sportKey || !eventId) return res.status(400).json({ error: 'sportKey and eventId required' })
    const nHome = parseFloat(home), nAway = parseFloat(away)
    const hasDraw = draw != null && draw !== ''
    const nDraw = hasDraw ? parseFloat(draw) : null
    const bad = (v) => !Number.isFinite(v) || v < 1.01 || v > 1000
    if (bad(nHome) || bad(nAway) || (hasDraw && bad(nDraw))) {
      return res.status(400).json({ error: 'odds must be decimal between 1.01 and 1000' })
    }
    const events = getCacheRaw(sportKey)
    if (!events) return res.status(404).json({ error: 'sport not cached' })
    const ev = events.find(e => e.id === eventId)
    if (!ev) return res.status(404).json({ error: 'event not found' })

    // Build the new h2h in canonical Home / Draw / Away order.
    const h2h = [{ name: ev.homeTeam, price: nHome }]
    if (hasDraw) h2h.push({ name: 'Draw', price: nDraw })
    h2h.push({ name: ev.awayTeam, price: nAway })

    // Apply the same safety clamp the drift cycle uses (absolute floor; no seed band here
    // since the admin IS the new seed).
    sanitizeH2H(h2h)
    ev.markets = ev.markets || {}
    ev.markets.h2h = h2h

    // Re-derive synthetic markets from the new win market so nothing de-coheres.
    if (h2h.length >= 3) {
      const { markets: derived, lH, lA } =
        deriveFromH2H(h2h, ev.homeTeam, ev.awayTeam, { hasTotals: !!(ev.markets.totals && ev.markets.totals.length) })
      for (const [k, v] of Object.entries(derived)) ev.markets[k] = v
      if (lH > 0 && lA > 0) { ev._lH = lH; ev._lA = lA }
    }

    ev._oddsLocked = true
    ev._aiAdjusted = false            // manual line supersedes any AI adjustment
    ev._oddsOverride = { at: new Date().toISOString() }
    stampSeed(ev, true)               // admin line becomes the pristine baseline
    anchorEventToCurrent(sportKey, ev)   // drift now mean-reverts to THIS line
    setCache(sportKey, events)

    res.json({ success: true, eventId, h2h, locked: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Clear a manual override lock (lets AI adjust the match again) ---
router.post('/sports/odds/unlock', (req, res) => {
  try {
    const { sportKey, eventId } = req.body || {}
    if (!sportKey || !eventId) return res.status(400).json({ error: 'sportKey and eventId required' })
    const events = getCacheRaw(sportKey)
    if (!events) return res.status(404).json({ error: 'sport not cached' })
    const ev = events.find(e => e.id === eventId)
    if (!ev) return res.status(404).json({ error: 'event not found' })
    delete ev._oddsLocked
    delete ev._oddsOverride
    setCache(sportKey, events)
    res.json({ success: true, eventId, locked: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Force a clean re-seed of one sport (or all soccer) from the live feed ---
// Fetches fresh odds, replaces the cache, re-stamps pristine _seedH2H baselines, resets
// the drift seed, and clears AI anchors — wiping any accumulated poison from the old
// AI-loop bug. Body: { sportKey } (omit to reseed every currently-cached soccer league).
// Respects locked (manually-overridden) matches: their line is preserved.
router.post('/sports/reseed', async (req, res) => {
  try {
    const { sportKey } = req.body || {}
    const targets = sportKey
      ? [sportKey]
      : (getCachedSports() || []).filter(k => k.startsWith('soccer_'))
    const out = []
    for (const key of targets) {
      // preserve locked overrides from the existing cache
      const prev = getCacheRaw(key) || []
      const lockedById = {}
      for (const e of prev) if (e._oddsLocked) lockedById[e.id] = e

      let events = null
      try { events = await fetchOddsForSport(key) } catch (e) { events = null }
      if (!events || !events.length) { out.push({ sportKey: key, ok: false, reason: 'no feed data' }); continue }

      let upcoming = filterUpcoming(events)
      // re-apply any locked overrides on top of the fresh feed
      upcoming = upcoming.map(e => lockedById[e.id] ? lockedById[e.id] : e)
      // stamp pristine seeds on the fresh (non-locked) events
      for (const e of upcoming) if (!e._oddsLocked) stampSeed(e, true)

      setCache(key, upcoming)
      storeBaseOdds(key, upcoming)
      clearAiAnchor(key)
      out.push({ sportKey: key, ok: true, events: upcoming.length, lockedKept: Object.keys(lockedById).length })
    }
    res.json({ success: true, reseeded: out })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
