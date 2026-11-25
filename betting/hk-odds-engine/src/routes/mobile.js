// mobile.js — public web/PWA mirror of the Steak NUI. Lets a player use the
// sportsbook + casino from a browser while OFFLINE in-game.
//
// MONEY INVARIANT (unchanged): this engine NEVER writes the game `players` table.
// Web play runs against an ESCROW wallet (hk_mobile_wallet) held in the isolated
// betting DB. The ONLY money-authority crossing is load/cashout, which is queued
// (hk_mobile_queue) and fulfilled by the .235 relay's offline players-table write
// path. The engine moves the wallet side only after the relay acks the cash side.
//
// AUTH REALMS in this router (mounted BEFORE the global x-auth-token gate so the
// browser can reach it without the internal secret):
//   • browser endpoints  → Bearer session token (issued by /mobile/login)
//   • relay endpoints     → x-auth-token (same internal secret as the rest of the
//     engine); /pending, /ack, /keypush. Guarded by requireRelay().
const express = require('express')
const crypto = require('crypto')
const { getPool } = require('../db')

const router = express.Router()

const AUTH_SECRET = process.env.AUTH_SECRET || 'CHANGE_ME'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h
const MAX_LOAD = 50000000   // cap a single load/cashout, mirrors payout cap
const MIN_MOVE = 1

// ── Phase 3 real-cash pipeline: call the relay's applyCash HTTP handler ────────
// The relay (.235) is the ONLY thing that may touch game cash. We call it and WAIT
// for confirm before persisting anything. Exactly-once via idempotencyKey (the
// relay logs it and replays the stored result on retry). Returns:
//   { ok:true, newCash }              money moved (or replayed)
//   { ok:false, error }               relay said no (insufficient_cash / no_character)
//   { ok:false, error:'relay_down' }  unreachable/timeout  -> caller MUST deny
const GAME_CASH_URL = process.env.GAME_CASH_URL || 'http://192.168.50.235:30120/hk-sportsbetting/applyCash'
const GAME_CASH_SECRET = process.env.GAME_CASH_SECRET || 'CHANGE_ME'
async function applyGameCash({ identifier, delta, reason, idempotencyKey }) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000) // generous: covers offline SQL write
    const r = await fetch(GAME_CASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cash-secret': GAME_CASH_SECRET },
      body: JSON.stringify({ identifier, delta, reason, idempotencyKey }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer))
    if (!r.ok && r.status !== 200) {
      // 4xx from the relay = a definitive "no" (bad fields / cap / auth); surface it
      const d = await r.json().catch(() => ({}))
      return { ok: false, error: d.error || ('relay_http_' + r.status) }
    }
    const d = await r.json()
    // `replay` = this idem key was already applied (relay returned the stored
    // result). Callers doing debit-then-conditional-refund must NOT refund on a
    // replay: the original request already ran its downstream action.
    return { ok: d.ok === true, newCash: Number(d.newCash) || 0, error: d.error, replay: d.replay === true }
  } catch (e) {
    // network/timeout/abort — treat as engine-can't-confirm, DENY the action
    return { ok: false, error: 'relay_down' }
  }
}
router.applyGameCash = applyGameCash

// ── Relay-mediated mirror refresh (READ-ONLY) ─────────────────────────────────
// Ask the relay to re-read a player's REAL game cash (online PlayerData or offline
// players-table JSON) and push it into hk_mobile_mirror. Never moves money. Used to
// heal a stale display balance when cash changed out of band (e.g. a direct DB
// edit) while the player was never connected to FiveM, so no push ever fired.
const GAME_REFRESH_URL = process.env.GAME_REFRESH_URL ||
  'http://192.168.50.235:30120/hk-sportsbetting/refreshCash'
async function refreshGameCash(identifier) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000) // covers offline SQL read
    const r = await fetch(GAME_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cash-secret': GAME_CASH_SECRET },
      body: JSON.stringify({ identifier }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer))
    if (!r.ok && r.status !== 200) return { ok: false, error: 'relay_http_' + r.status }
    const d = await r.json()
    return { ok: d.ok === true, cash: Number(d.cash) || 0 }
  } catch (e) {
    return { ok: false, error: 'relay_down' }
  }
}
router.refreshGameCash = refreshGameCash

// Throttle self-heal refreshes so a polling client can't hammer the relay. Keyed
// per identifier; we only fire an async refresh if the last one was >= this ago.
const REFRESH_THROTTLE_MS = 15 * 1000
const lastRefreshAt = new Map()
function maybeSelfHealMirror(identifier) {
  const now = Date.now()
  const last = lastRefreshAt.get(identifier) || 0
  if (now - last < REFRESH_THROTTLE_MS) return
  lastRefreshAt.set(identifier, now)
  // fire-and-forget: the fresh value lands in the mirror for the NEXT read
  refreshGameCash(identifier).catch(() => {})
}

// Presence: a web session is "active" while it heartbeats. If we haven't heard
// from it within this window the tab is treated as gone (crash/close) and the
// in-game lock releases. Web heartbeats ~every 10s, so 30s tolerates two misses.
const PRESENCE_STALE_MS = 30 * 1000

// ── password hashing (scrypt) ──────────────────────────────────────
function hashKey(rawKey, salt) {
  return crypto.scryptSync(String(rawKey), salt, 64).toString('hex')
}
// constant-time compare to avoid timing oracles on the key check
function safeEqual(a, b) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// ── login rate-limit / lockout (in-memory) ─────────────────────────
// keyed by loginId; also track by IP to blunt distributed guessing.
const attempts = new Map() // key -> { n, until }
const LOCK_AFTER = 6
const LOCK_MS = 5 * 60 * 1000
function lockState(key) {
  const a = attempts.get(key)
  if (a && a.until && Date.now() < a.until) return { locked: true, retryMs: a.until - Date.now() }
  return { locked: false }
}
function noteFail(key) {
  const a = attempts.get(key) || { n: 0, until: 0 }
  a.n += 1
  if (a.n >= LOCK_AFTER) { a.until = Date.now() + LOCK_MS; a.n = 0 }
  attempts.set(key, a)
}
function noteOk(key) { attempts.delete(key) }

// ── relay guard: internal secret only ──────────────────────────────
function requireRelay(req, res, next) {
  if (req.headers['x-auth-token'] !== AUTH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

// ── session middleware: resolve Bearer token -> identifier ─────────
// Rejects unless the token exists, is unexpired, and its key_ver still matches
// the player's current auth row (a regenerate bumps key_ver and orphans it).
async function requireSession(req, res, next) {
  try {
    const auth = req.headers['authorization'] || ''
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!raw) return res.status(401).json({ error: 'no_session' })
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex')
    const pool = getPool()
    const [[row]] = await pool.query(
      `SELECT s.identifier, s.key_ver, s.expires_at, a.key_ver AS cur_ver
         FROM hk_mobile_session s
         JOIN hk_mobile_auth a ON a.identifier = s.identifier
        WHERE s.token_hash = ?`, [tokenHash])
    if (!row) return res.status(401).json({ error: 'invalid_session' })
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query('DELETE FROM hk_mobile_session WHERE token_hash = ?', [tokenHash])
      return res.status(401).json({ error: 'expired' })
    }
    if (row.key_ver !== row.cur_ver) {
      await pool.query('DELETE FROM hk_mobile_session WHERE token_hash = ?', [tokenHash])
      return res.status(401).json({ error: 'revoked' })
    }
    req.identifier = row.identifier
    req.tokenHash = tokenHash
    // touch last_seen (fire-and-forget)
    pool.query('UPDATE hk_mobile_session SET last_seen = CURRENT_TIMESTAMP WHERE token_hash = ?', [tokenHash]).catch(() => {})
    next()
  } catch (e) {
    console.error('[mobile/session]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
}

// ── POST /mobile/login  { loginId, key } -> { token, expiresAt } ───
// The player's loginId + 8-char web key (both set in-game via hk-hub). Verifies
// against the hashed key pushed one-way from the relay. Rate-limited + locked out.
router.post('/login', async (req, res) => {
  try {
    const loginId = String(req.body?.loginId || '').trim().slice(0, 32)
    const key = String(req.body?.key || '').trim().slice(0, 64)
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    if (!loginId || !key) return res.status(400).json({ error: 'missing_credentials' })

    // lockout check (by login and by ip)
    for (const k of ['l:' + loginId, 'ip:' + ip]) {
      const st = lockState(k)
      if (st.locked) return res.status(429).json({ error: 'locked', retryMs: st.retryMs })
    }

    const pool = getPool()
    const [[row]] = await pool.query(
      'SELECT identifier, key_hash, key_salt, key_ver FROM hk_mobile_auth WHERE login_id = ?', [loginId])
    // Always run a hash even on unknown login to keep timing uniform.
    const salt = row ? row.key_salt : 'x'.repeat(32)
    const computed = hashKey(key, salt)
    const ok = row && safeEqual(computed, row.key_hash)
    if (!ok) {
      noteFail('l:' + loginId); noteFail('ip:' + ip)
      return res.status(401).json({ error: 'bad_credentials' })
    }
    noteOk('l:' + loginId); noteOk('ip:' + ip)

    // issue session token (raw handed to browser, only hash stored)
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expires = new Date(Date.now() + SESSION_TTL_MS)
    await pool.query(
      `INSERT INTO hk_mobile_session (token_hash, identifier, key_ver, expires_at)
       VALUES (?, ?, ?, ?)`,
      [tokenHash, row.identifier, row.key_ver, expires])
    // opportunistic cleanup of this player's expired tokens
    pool.query('DELETE FROM hk_mobile_session WHERE identifier = ? AND expires_at < CURRENT_TIMESTAMP',
      [row.identifier]).catch(() => {})
    // Mark THIS web session as the presence owner. Note: in-game now has PRIORITY
    // (the phone suspends while the casino is open in-game), so this no longer locks
    // the in-game client out. It only arbitrates BETWEEN web sessions: a second
    // browser/tab logging in takes over, and the older tab's heartbeat returns
    // taken:true and bounces to login. One web session at a time.
    markWebActive(pool, row.identifier, tokenHash).catch(() => {})

    res.json({ token: rawToken, expiresAt: expires.toISOString() })
  } catch (e) {
    console.error('[mobile/login]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /mobile/logout ── drop the current session token
router.post('/logout', requireSession, async (req, res) => {
  try {
    const pool = getPool()
    await pool.query('DELETE FROM hk_mobile_session WHERE token_hash = ?', [req.tokenHash])
    // release the in-game lock, but only if this session still owns it
    await clearWebActive(pool, req.identifier, req.tokenHash)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: 'internal error' }) }
})

// ── POST /mobile/heartbeat ── web app pings ~every 10s to keep presence fresh.
// Returns { taken:true } if another session has taken over this player's lock
// (this token no longer owns presence), so the web app can bounce to login.
router.post('/heartbeat', requireSession, async (req, res) => {
  try {
    const pool = getPool()
    const [[row]] = await pool.query(
      'SELECT web_active, web_token_hash FROM hk_mobile_presence WHERE identifier = ?', [req.identifier])
    // someone else owns the web lock now -> this session was taken over (another tab)
    if (row && row.web_active && row.web_token_hash && row.web_token_hash !== req.tokenHash) {
      return res.json({ ok: true, taken: true })
    }
    // refresh our ownership + timestamp
    await markWebActive(pool, req.identifier, req.tokenHash)
    // In-game PRIORITY: if the player has the casino open in-game, the phone
    // SUSPENDS (pauses, does not log out). Auto-clears when in-game closes.
    const suspended = await isIngameActive(pool, req.identifier)
    res.json({ ok: true, taken: false, suspended })
  } catch (e) {
    console.error('[mobile/heartbeat]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── GET /mobile/me ── who am I (identifier + display bits)
router.get('/me', requireSession, async (req, res) => {
  try {
    const pool = getPool()
    const [[ident]] = await pool.query(
      'SELECT char_name, cid, job FROM hk_player_identity WHERE identifier = ?', [req.identifier])
    const [[vip]] = await pool.query(
      'SELECT nickname, show_nickname FROM hk_steak_vip WHERE identifier = ?', [req.identifier])
    res.json({
      identifier: req.identifier,
      charName: ident?.char_name || null,
      cid: ident?.cid || null,
      nickname: vip?.nickname || null,
    })
  } catch (e) {
    console.error('[mobile/me]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── wallet helpers ─────────────────────────────────────────────────
async function getWallet(pool, identifier) {
  const [[row]] = await pool.query(
    'SELECT balance FROM hk_mobile_wallet WHERE identifier = ?', [identifier])
  return row ? Number(row.balance) : 0
}
// Real in-game cash mirrored from the relay. This is the DISPLAY balance the web
// app shows (one synced number). Returns null if we've never received a push yet
// (player hasn't come online since the mirror shipped), so callers can distinguish
// "0 cash" from "not yet mirrored".
async function getMirroredCash(pool, identifier) {
  const [[row]] = await pool.query(
    'SELECT cash FROM hk_mobile_mirror WHERE identifier = ?', [identifier])
  return row ? Number(row.cash) : null
}
// Atomic wallet debit: only succeeds if balance covers it. Returns new balance or null.
async function debitWallet(pool, identifier, amount) {
  const [r] = await pool.query(
    'UPDATE hk_mobile_wallet SET balance = balance - ? WHERE identifier = ? AND balance >= ?',
    [amount, identifier, amount])
  if (r.affectedRows !== 1) return null
  return getWallet(pool, identifier)
}
async function creditWallet(pool, identifier, amount) {
  await pool.query(
    `INSERT INTO hk_mobile_wallet (identifier, balance) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)`,
    [identifier, amount])
  return getWallet(pool, identifier)
}
// ── presence helpers (single-session mutex) ───────────────────────
// Mark a web session live. Records which token owns it so a later takeover can
// tell "still me" from "someone else grabbed it".
async function markWebActive(pool, identifier, tokenHash) {
  await pool.query(
    `INSERT INTO hk_mobile_presence (identifier, web_active, web_seen_at, web_token_hash)
     VALUES (?, 1, CURRENT_TIMESTAMP, ?)
     ON DUPLICATE KEY UPDATE web_active = 1, web_seen_at = CURRENT_TIMESTAMP, web_token_hash = VALUES(web_token_hash)`,
    [identifier, tokenHash || null])
}
// Clear web presence (logout / takeover). If onlyToken is given, only clears when
// that token still owns the row (so we don't stomp a newer session).
async function clearWebActive(pool, identifier, onlyToken) {
  if (onlyToken) {
    await pool.query(
      `UPDATE hk_mobile_presence SET web_active = 0, web_token_hash = NULL
        WHERE identifier = ? AND web_token_hash = ?`, [identifier, onlyToken])
  } else {
    await pool.query(
      `UPDATE hk_mobile_presence SET web_active = 0, web_token_hash = NULL WHERE identifier = ?`,
      [identifier])
  }
}
// Is the player's web session currently active (and not stale)?
async function isWebActive(pool, identifier) {
  const [[row]] = await pool.query(
    'SELECT web_active, web_seen_at FROM hk_mobile_presence WHERE identifier = ?', [identifier])
  if (!row || !row.web_active) return false
  if (!row.web_seen_at) return false
  const age = Date.now() - new Date(row.web_seen_at).getTime()
  return age <= PRESENCE_STALE_MS
}

// ── in-game presence (in-game PRIORITY) ────────────────────────────
// The in-game casino client publishes this via the relay while it has the UI open.
// A stale ingame_seen_at counts as inactive so a crash/disconnect self-releases and
// the web session resumes (fail-safe: never leave the phone stuck suspended).
async function setIngameActive(pool, identifier, active) {
  await pool.query(
    `INSERT INTO hk_mobile_presence (identifier, ingame_active, ingame_seen_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE ingame_active = VALUES(ingame_active),
       ingame_seen_at = CASE WHEN VALUES(ingame_active) = 1 THEN CURRENT_TIMESTAMP ELSE ingame_seen_at END`,
    [identifier, active ? 1 : 0])
}
async function isIngameActive(pool, identifier) {
  const [[row]] = await pool.query(
    'SELECT ingame_active, ingame_seen_at FROM hk_mobile_presence WHERE identifier = ?', [identifier])
  if (!row || !row.ingame_active) return false
  if (!row.ingame_seen_at) return false
  const age = Date.now() - new Date(row.ingame_seen_at).getTime()
  return age <= PRESENCE_STALE_MS
}

// expose to other route modules (bets/casino mobile paths) via router props
router.getWallet = getWallet
router.getMirroredCash = getMirroredCash
router.debitWallet = debitWallet
router.creditWallet = creditWallet
router.requireSession = requireSession

// ── GET /mobile/wallet ── balance = REAL mirrored in-game cash (one synced number)
// Phase 1 of the real-cash sync: the balance the web app shows is the player's
// actual game cash, pushed by the relay. `mirrored` tells the client whether we
// have a fresh figure yet (false = player hasn't been online since sync shipped).
router.get('/wallet', requireSession, async (req, res) => {
  try {
    const pool = getPool()
    const cash = await getMirroredCash(pool, req.identifier)
    const [pending] = await pool.query(
      `SELECT id, kind, amount, status, reason, created_at
         FROM hk_mobile_queue
        WHERE identifier = ? AND status IN ('pending','claimed')
        ORDER BY id DESC LIMIT 10`, [req.identifier])
    res.json({ balance: cash == null ? 0 : cash, mirrored: cash != null, pending })
    // Self-heal (throttled, async, AFTER responding): keep the mirror converging to
    // real game cash even for out-of-band changes made while the player was offline.
    // The fresh value lands for the NEXT poll, so the display converges on its own.
    maybeSelfHealMirror(req.identifier)
  } catch (e) {
    console.error('[mobile/wallet]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /mobile/wallet/refresh ── force an immediate relay-mediated mirror pull
// and return the fresh balance. Backs the "Refresh balance" button in Settings.
// READ-ONLY: never moves money. Bypasses the self-heal throttle (explicit action).
router.post('/wallet/refresh', requireSession, async (req, res) => {
  try {
    const pool = getPool()
    const r = await refreshGameCash(req.identifier)
    lastRefreshAt.set(req.identifier, Date.now())
    if (r.ok) {
      res.json({ balance: r.cash, mirrored: true })
    } else {
      // relay unreachable — return whatever the mirror currently holds so the UI
      // still shows something rather than erroring out.
      const cash = await getMirroredCash(pool, req.identifier)
      res.json({ balance: cash == null ? 0 : cash, mirrored: cash != null, stale: true })
    }
  } catch (e) {
    console.error('[mobile/wallet/refresh]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── GET /mobile/wallet/history ── recently completed loads/cashouts
router.get('/wallet/history', requireSession, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, kind, amount, status, reason, created_at, done_at
         FROM hk_mobile_queue WHERE identifier = ?
        ORDER BY id DESC LIMIT 25`, [req.identifier])
    res.json({ items: rows })
  } catch (e) { res.status(500).json({ error: 'internal error' }) }
})

// ── POST /mobile/wallet/load  { amount } ───────────────────────────
// Enqueue a game-cash -> wallet transfer. Engine does NOT credit the wallet here;
// the relay debits game cash first, then acks, and /mobile/ack credits the wallet.
router.post('/wallet/load', requireSession, async (req, res) => {
  try {
    const amount = Math.floor(Number(req.body?.amount) || 0)
    if (!(amount >= MIN_MOVE) || amount > MAX_LOAD) return res.status(400).json({ error: 'bad_amount' })
    const pool = getPool()
    // one in-flight money move at a time per player (avoids racing the relay)
    const [[busy]] = await pool.query(
      `SELECT COUNT(*) AS n FROM hk_mobile_queue WHERE identifier = ? AND status IN ('pending','claimed')`,
      [req.identifier])
    if (busy.n > 0) return res.status(409).json({ error: 'transfer_in_progress' })
    const [ins] = await pool.query(
      `INSERT INTO hk_mobile_queue (identifier, kind, amount, status) VALUES (?, 'load', ?, 'pending')`,
      [req.identifier, amount])
    res.json({ success: true, queueId: ins.insertId, status: 'pending' })
  } catch (e) {
    console.error('[mobile/load]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /mobile/wallet/cashout  { amount } ────────────────────────
// Move wallet -> game cash. Debit the wallet IMMEDIATELY (engine-authoritative)
// and enqueue the game-cash credit for the relay. If the relay ultimately fails,
// /mobile/ack refunds the wallet.
router.post('/wallet/cashout', requireSession, async (req, res) => {
  try {
    const amount = Math.floor(Number(req.body?.amount) || 0)
    if (!(amount >= MIN_MOVE) || amount > MAX_LOAD) return res.status(400).json({ error: 'bad_amount' })
    const pool = getPool()
    const [[busy]] = await pool.query(
      `SELECT COUNT(*) AS n FROM hk_mobile_queue WHERE identifier = ? AND status IN ('pending','claimed')`,
      [req.identifier])
    if (busy.n > 0) return res.status(409).json({ error: 'transfer_in_progress' })
    const newBal = await debitWallet(pool, req.identifier, amount)
    if (newBal === null) return res.status(400).json({ error: 'insufficient_wallet' })
    const [ins] = await pool.query(
      `INSERT INTO hk_mobile_queue (identifier, kind, amount, status) VALUES (?, 'cashout', ?, 'pending')`,
      [req.identifier, amount])
    res.json({ success: true, queueId: ins.insertId, status: 'pending', balance: newBal })
  } catch (e) {
    console.error('[mobile/cashout]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ═══════════════════════════════════════════════════════════════════
// RELAY-FACING (x-auth-token). The .235 relay polls + fulfills money moves
// and pushes web-key hashes. Never reachable by a browser session token.
// ═══════════════════════════════════════════════════════════════════

// ── GET /mobile/presence?identifier= ── relay asks whether a player's web
// session is live. Mobile has priority: if active, the in-game client locks out.
// Returns { active: bool }. A stale heartbeat counts as inactive.
router.get('/presence', requireRelay, async (req, res) => {
  try {
    const identifier = String(req.query.identifier || '').slice(0, 64)
    if (!identifier) return res.status(400).json({ error: 'missing_identifier' })
    const active = await isWebActive(getPool(), identifier)
    res.json({ active })
  } catch (e) {
    console.error('[mobile/presence]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /mobile/ingame  { identifier, active } ── (relay) ──────────
// The in-game client tells us it opened (active:1) or closed (active:0) the casino
// UI, and refreshes ingame_seen_at via a ~10s heartbeat while open. While active,
// the player's web heartbeat returns suspended:true so the phone pauses. IN-GAME
// HAS PRIORITY over web.
router.post('/ingame', requireRelay, async (req, res) => {
  try {
    const b = req.body || {}
    const identifier = String(b.identifier || '').slice(0, 64)
    if (!identifier) return res.status(400).json({ error: 'missing_identifier' })
    await setIngameActive(getPool(), identifier, b.active ? 1 : 0)
    res.json({ success: true })
  } catch (e) {
    console.error('[mobile/ingame]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── GET /mobile/roundcheck?identifier= ── (relay) ──────────────────
// Does this player have a LIVE casino round the engine is still holding? The
// engine owns all of this even when the phone app is closed, so the in-game client
// can WAIT for it to resolve before opening (option 1: "in-game waits"). Covers
// mines/chicken (persisted), crash (staked this round), blackjack + mahjong (seated
// in a hand past the betting window). Returns { liveRound: bool, kinds: [...] }.
router.get('/roundcheck', requireRelay, async (req, res) => {
  try {
    const identifier = String(req.query.identifier || '').slice(0, 64)
    if (!identifier) return res.status(400).json({ error: 'missing_identifier' })
    const kinds = []
    try {
      const casino = require('./casino')
      for (const k of casino.liveRoundKinds(identifier)) kinds.push(k)
    } catch (e) { console.error('[roundcheck] casino:', e.message) }
    try {
      const bj = require('./blackjack')
      if (bj.hasLiveRound(identifier)) kinds.push('blackjack')
    } catch (e) { console.error('[roundcheck] blackjack:', e.message) }
    try {
      const mj = require('./mahjong')
      if (mj.hasLiveRound(identifier)) kinds.push('mahjong')
    } catch (e) { console.error('[roundcheck] mahjong:', e.message) }
    res.json({ liveRound: kinds.length > 0, kinds })
  } catch (e) {
    console.error('[mobile/roundcheck]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /mobile/keypush  { identifier, loginId, key, keyVer } ──
// ── POST /mobile/mirror  { identifier, cash } ──
// The relay pushes the player's REAL in-game cash so the web app can display one
// synced number. Read-only reflection: the engine never edits real money, so this
// only ever overwrites the display figure. Called on session start, on every
// in-game cash change, and via a periodic sweep.
router.post('/mirror', requireRelay, async (req, res) => {
  try {
    const b = req.body || {}
    const identifier = String(b.identifier || '').slice(0, 64)
    const cash = Math.max(0, Math.floor(Number(b.cash) || 0))
    if (!identifier) return res.status(400).json({ error: 'missing_identifier' })
    await getPool().query(
      `INSERT INTO hk_mobile_mirror (identifier, cash) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE cash = VALUES(cash)`,
      [identifier, cash])
    res.json({ success: true })
  } catch (e) {
    console.error('[mobile/mirror]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// One-way key mirror from hk-hub. The relay generates + stores the RAW key (so it
// can re-display it in-game) and pushes it here once; the engine derives its OWN
// salt + scrypt hash and stores only the hash — the raw key is never persisted in
// the betting DB. On regenerate the relay bumps keyVer; we store the new hash and
// DROP all this player's sessions so old tokens die immediately.
router.post('/keypush', requireRelay, async (req, res) => {
  try {
    const b = req.body || {}
    const identifier = String(b.identifier || '').slice(0, 64)
    const loginId = b.loginId != null ? String(b.loginId).slice(0, 32) : null
    const key = String(b.key || '').slice(0, 64)
    const keyVer = Math.max(1, Math.floor(Number(b.keyVer) || 1))
    if (!identifier || !key) return res.status(400).json({ error: 'missing_fields' })
    const salt = crypto.randomBytes(16).toString('hex')
    const keyHash = hashKey(key, salt)
    const pool = getPool()
    await pool.query(
      `INSERT INTO hk_mobile_auth (identifier, login_id, key_hash, key_salt, key_ver)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE login_id = VALUES(login_id), key_hash = VALUES(key_hash),
         key_salt = VALUES(key_salt), key_ver = VALUES(key_ver)`,
      [identifier, loginId, keyHash, salt, keyVer])
    // regenerate => kill existing sessions immediately
    await pool.query('DELETE FROM hk_mobile_session WHERE identifier = ?', [identifier])
    res.json({ success: true })
  } catch (e) {
    console.error('[mobile/keypush]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── GET /mobile/pending ── relay claims up to N pending money moves.
// Atomically flips pending->claimed so two relay polls can't double-fulfill.
router.get('/pending', requireRelay, async (req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.query(
      `SELECT id, identifier, kind, amount FROM hk_mobile_queue
        WHERE status = 'pending' ORDER BY id ASC LIMIT 25`)
    if (rows.length === 0) return res.json({ items: [] })
    const ids = rows.map(r => r.id)
    const [upd] = await pool.query(
      `UPDATE hk_mobile_queue SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP
        WHERE id IN (?) AND status = 'pending'`, [ids])
    // only return the ones we actually claimed (guard against a racing poll)
    const [claimed] = await pool.query(
      `SELECT id, identifier, kind, amount FROM hk_mobile_queue
        WHERE id IN (?) AND status = 'claimed'`, [ids])
    res.json({ items: claimed })
  } catch (e) {
    console.error('[mobile/pending]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── POST /mobile/ack  { id, ok, reason } ── relay reports a move's outcome.
// LOAD ok  -> credit the wallet (game cash already debited on the relay).
// LOAD fail-> nothing to undo (relay didn't debit).
// CASHOUT ok  -> nothing (wallet already debited at request; relay credited cash).
// CASHOUT fail-> refund the wallet (relay couldn't credit game cash).
router.post('/ack', requireRelay, async (req, res) => {
  try {
    const id = Math.floor(Number(req.body?.id) || 0)
    const ok = req.body?.ok === true || req.body?.ok === 1 || req.body?.ok === '1'
    const reason = req.body?.reason != null ? String(req.body.reason).slice(0, 128) : null
    if (!id) return res.status(400).json({ error: 'missing_id' })
    const pool = getPool()
    // only process rows still 'claimed' (idempotent against duplicate acks)
    const [[row]] = await pool.query(
      `SELECT identifier, kind, amount, status FROM hk_mobile_queue WHERE id = ?`, [id])
    if (!row) return res.status(404).json({ error: 'no_such_move' })
    if (row.status !== 'claimed') return res.json({ success: true, already: row.status })

    if (ok) {
      if (row.kind === 'load') await creditWallet(pool, row.identifier, Number(row.amount))
      // cashout ok: wallet already debited at request time — nothing to do
      await pool.query(
        `UPDATE hk_mobile_queue SET status = 'done', done_at = CURRENT_TIMESTAMP, reason = ?
          WHERE id = ? AND status = 'claimed'`, [reason, id])
    } else {
      if (row.kind === 'cashout') await creditWallet(pool, row.identifier, Number(row.amount)) // refund
      // load fail: relay didn't debit game cash — nothing to undo
      await pool.query(
        `UPDATE hk_mobile_queue SET status = 'failed', done_at = CURRENT_TIMESTAMP, reason = ?
          WHERE id = ? AND status = 'claimed'`, [reason, id])
    }
    res.json({ success: true })
  } catch (e) {
    console.error('[mobile/ack]', e.message)
    res.status(500).json({ error: 'internal error' })
  }
})

// ── sportsbook read + placement (uses requireSession + wallet helpers above) ──
require('./mobileSports').register(router, requireSession)
// ── instant casino (mines/dice/chicken/plinko) — owns real cash via applyGameCash ──
require('./mobileCasino').register(router, requireSession)
// ── live blackjack at SHARED tables (bj_main/bj_vip) — engine settles web seats ──
require('./mobileBlackjack').register(router, requireSession)

module.exports = router
