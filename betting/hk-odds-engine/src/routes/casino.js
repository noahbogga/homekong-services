const express = require('express')
const crypto = require('crypto')
const { getActiveGames, setActiveGame, deleteActiveGame, getActiveGame } = require('../gamePersist')
const discord = require('../discord')
const { getPool } = require("../db")
const seedStore = require('../seeds')

const router = express.Router()

// Exclusion cache (refreshed every 60s)
let excludedSet = new Set()
async function refreshExclusions() {
  try {
    const pool = getPool()
    if (!pool) return
    const [rows] = await pool.query("SELECT identifier FROM hk_casino_exclusions WHERE active = 1 AND (expires_at IS NULL OR expires_at > NOW())")
    excludedSet = new Set(rows.map(r => r.identifier))
  } catch {}
}
setInterval(refreshExclusions, 60000)
setTimeout(refreshExclusions, 3000)

// Immediate cache mutators so an admin Lift/Pause takes effect NOW instead of
// waiting up to 60s for the next refresh. admin.js calls these after the DB write.
function dropExcluded(id) { if (id) excludedSet.delete(id) }
function addExcluded(id) { if (id) excludedSet.add(id) }
function clearAllExcluded() { excludedSet = new Set() } // panic reset for the "wipe all bans" button

function checkExclusion(req, res, next) {
  if (req.path.startsWith("/exclusion-status/") || req.path === "/crash/state" || req.path.startsWith("/active/")) return next()
  const id = req.body?.identifier || req.params?.identifier
  if (id && excludedSet.has(id)) {
    return res.status(403).json({ error: "excluded", message: "Account paused from casino" })
  }
  next()
}
router.use(checkExclusion)

// --- Crypto helpers (mirror of FiveM crypto.lua) ---

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex')
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function generateGameHash(serverSeed, clientSeed, nonce, cursor = 0) {
  const message = `${clientSeed}:${nonce}:${cursor}`
  return hmacSha256(serverSeed, message)
}

function floatFromHash(hash, cursor) {
  const idx = cursor * 8
  let h = hash
  if (idx + 8 > h.length) {
    h = sha256(hash + ':' + String(cursor))
    const hex4 = h.substring(0, 8)
    const int = parseInt(hex4, 16)
    return int / 0x100000000
  }
  const hex4 = h.substring(idx, idx + 8)
  const int = parseInt(hex4, 16)
  return int / 0x100000000
}

function generateCrashPoint(hash) {
  const hs = parseInt(hash.substring(0, 8), 16)
  const e = Math.pow(2, 32)
  const result = Math.floor((100 * e - hs) / (e - hs)) / 100
  return Math.max(1.0, result)
}

// --- Game math ---

function calcMinesMultiplier(numMines, opened) {
  if (opened <= 0) return 1
  const gridSize = 25
  const edge = 0.02
  let mult = 1
  for (let i = 0; i < opened; i++) {
    mult *= (gridSize - numMines - i) > 0
      ? (gridSize - i) / (gridSize - numMines - i)
      : 1
  }
  return parseFloat((mult * (1 - edge)).toFixed(4))
}

function calcChickenMultiplier(rowsCleared, cols) {
  cols = cols || 4
  const edge = 0.02
  const raw = Math.pow(cols / (cols - 1), rowsCleared) * (1 - edge)
  return parseFloat(Math.min(raw, 1500).toFixed(4))
}

function getChickenHazard(hash, row, cols) {
  cols = cols || 4
  const f = floatFromHash(hash, row)
  return (Math.floor(f * cols) % cols) + 1
}

const HAZARD_TYPES = ['bone', 'bomb', 'banana', 'spike', 'skull']

function getHazardType(hash, row) {
  const f = floatFromHash(hash, row + 200)
  return HAZARD_TYPES[Math.floor(f * HAZARD_TYPES.length)]
}

function getDiceRoll(hash) {
  return floatFromHash(hash, 0) * 100
}

function getPlinkoBucket(hash, rows) {
  let pos = 0
  for (let i = 0; i < rows; i++) {
    const f = floatFromHash(hash, i + 10)
    pos += f < 0.5 ? -1 : 1
  }
  return Math.floor((pos + rows) / 2)
}

// --- Active games state (persisted via gamePersist.js) ---
const crashState = {
  state: 'idle',
  bets: {},
  watchers: {},
  hash: null,
  crashPoint: null,
  startTime: null,
  countdownEnd: null,
  serverSeed: crypto.randomBytes(32).toString('hex'),
  nonce: 0,
}

const CRASH_WAIT_TIME = 15
const CRASH_END_DELAY = 5

// ── WEB crash settlement hook ────────────────────────────────────────────────
// In-game, the relay polls /crash/settle and pays only bets it locally tracks in
// crashBetSources. WEB bets (placed straight against the engine via mobileCasino)
// are NOT in crashBetSources, so the relay never sees or pays them. To avoid any
// double-pay, the engine settles web bets itself: mobileCasino registers a handler
// here, and on the running->ended transition we hand it a snapshot of the round's
// web bets exactly once. Money stays out of this file; the handler owns applyGameCash.
let onWebCrashSettle = null
function setWebCrashSettleHandler(fn) { onWebCrashSettle = fn }

// Full crash state for one identifier — used by the web poll/join endpoints. Mirrors
// the /crash/join response shape so the web poller matches the in-game broadcast.
function getCrashStateFor(identifier) {
  const elapsed = crashState.state === 'running' && crashState.startTime
    ? Date.now() - crashState.startTime : 0
  const bet = crashState.bets[identifier]
  return {
    state: crashState.state,
    countdown: crashState.countdownEnd ? Math.max(0, crashState.countdownEnd - Math.floor(Date.now() / 1000)) : 0,
    elapsed,
    nonce: crashState.nonce,
    crashPoint: crashState.state === 'ended' ? crashState.crashPoint : null,
    betList: getCrashBetList(),
    myBet: bet ? {
      hasBet: true,
      cashedOut: !!bet.cashedOut,
      multiplier: bet.multiplier || null,
      payout: bet.payout || 0,
      stake: bet.stake,
    } : { hasBet: false },
  }
}

// Register a web crash watcher (so getCrashBetList/state stays warm; parity w/ /crash/join).
function addCrashWatcher(identifier) { crashState.watchers[identifier] = true }
function removeCrashWatcher(identifier) { delete crashState.watchers[identifier] }

// Place a WEB crash bet. The caller (mobileCasino) has ALREADY debited the stake.
// We only touch shared round state here. Returns {ok, error?, betList?}.
function placeWebCrashBet(identifier, stake, autoCashout, displayName) {
  if (crashState.state !== 'waiting') return { ok: false, error: 'not accepting bets' }
  if (crashState.bets[identifier]) return { ok: false, error: 'already bet' }
  let auto = autoCashout
  if (auto && auto > 30) auto = 30
  crashState.bets[identifier] = {
    stake, autoCashout: auto || null,
    cashedOut: false, multiplier: null, payout: 0,
    name: displayName || 'Hidden',
    web: true, debitKey: null, nonce: crashState.nonce,
  }
  return { ok: true, betList: getCrashBetList(), nonce: crashState.nonce }
}

// Attach the debit idempotency key to a placed web bet (for audit/settle parity).
function tagWebCrashBet(identifier, debitKey) {
  const bet = crashState.bets[identifier]
  if (bet && bet.web) bet.debitKey = debitKey
}

// Remove a just-placed web bet if the debit's follow-up failed (refund path).
function dropWebCrashBet(identifier) {
  const bet = crashState.bets[identifier]
  if (bet && bet.web) delete crashState.bets[identifier]
}

// Manual cashout for a WEB bet — locks the multiplier; payment happens at settle
// (matches in-game: cashout only marks the bet, money is paid on round end).
function cashoutWebCrash(identifier, multiplier) {
  if (crashState.state !== 'running') return { ok: false, error: 'not running' }
  const bet = crashState.bets[identifier]
  if (!bet || !bet.web) return { ok: false, error: 'no bet' }
  if (bet.cashedOut) return { ok: false, error: 'already cashed' }
  const currentMult = getCurrentCrashMultiplier()
  if (currentMult >= crashState.crashPoint) return { ok: false, error: 'round ended' }
  const cashMult = Math.min(multiplier || currentMult, currentMult, crashState.crashPoint - 0.01)
  bet.cashedOut = true
  bet.multiplier = parseFloat(cashMult.toFixed(2))
  bet.payout = Math.floor(bet.stake * bet.multiplier)
  return { ok: true, multiplier: bet.multiplier, payout: bet.payout, betList: getCrashBetList() }
}

// True if this identifier has a live (un-cashed) WEB crash bet — restore-after-reload.
function peekWebCrashBet(identifier) {
  const bet = crashState.bets[identifier]
  if (!bet || !bet.web) return null
  return { hasBet: true, cashedOut: !!bet.cashedOut, multiplier: bet.multiplier || null, stake: bet.stake }
}

function settleWebCrashBets() {
  if (!onWebCrashSettle) return
  const snapshot = []
  for (const [id, bet] of Object.entries(crashState.bets)) {
    if (!bet.web) continue
    snapshot.push({
      identifier: id,
      stake: bet.stake,
      cashedOut: !!bet.cashedOut,
      multiplier: bet.multiplier || 0,
      payout: bet.payout || 0,
      debitKey: bet.debitKey || null,
    })
  }
  if (snapshot.length === 0) return
  try {
    onWebCrashSettle(snapshot, crashState.crashPoint, crashState.nonce)
  } catch (e) {
    console.error('[crash web settle]', e.message)
  }
}

// --- Dice ---
router.post('/dice/bet', (req, res) => {
  const { identifier, stake, target, isOver, serverSeed, clientSeed, nonce } = req.body
  const hash = serverSeed
  const roll = getDiceRoll(hash)
  const won = isOver ? roll > target : roll < target
  const edge = 0.01
  const multiplier = isOver
    ? parseFloat((100 / (100 - target) * (1 - edge)).toFixed(4))
    : parseFloat((100 / target * (1 - edge)).toFixed(4))
  const payout = won ? Math.floor(stake * multiplier) : 0

  discord.logBet({ identifier, game: 'dice', stake, multiplier, payout, won })
  if (won && payout >= 1000000) discord.logBigWin({ identifier, game: 'dice', stake, multiplier, payout })
  if (!won && stake >= 500000) discord.logGameLoss({ identifier, game: 'dice', stake })

  res.json({
    success: true, roll: parseFloat(roll.toFixed(2)),
    won, multiplier, payout, hash, nonce,
  })
})

// --- Mines ---
router.post('/mines/start', (req, res) => {
  const { identifier, stake, numMines, serverSeed, clientSeed, nonce } = req.body
  if (!identifier || !stake || stake <= 0) return res.status(400).json({ error: 'invalid params' })
  if (!Number.isInteger(numMines) || numMines < 1 || numMines > 24) return res.status(400).json({ error: 'numMines must be 1-24' })
  const hash = serverSeed
  const key = `${identifier}_mines`

  if (getActiveGame(key)) {
    return res.status(400).json({ error: 'game already active' })
  }

  const mines = new Set()
  let cursor = 0
  while (mines.size < numMines) {
    const f = floatFromHash(hash, cursor)
    const pos = Math.floor(f * 25)
    mines.add(pos)
    cursor++
  }

  setActiveGame(key, {
    game: 'mines', stake, numMines, hash, nonce,
    mines: [...mines], revealed: new Set(), revealCount: 0,
  })

  res.json({ success: true })
})

router.post('/mines/reveal', (req, res) => {
  const { identifier, tile } = req.body
  const key = `${identifier}_mines`
  const game = getActiveGame(key)
  if (!game) return res.status(404).json({ error: 'no active game' })
  if (!Number.isInteger(tile) || tile < 0 || tile > 24) return res.status(400).json({ error: 'tile must be 0-24' })

  if (game.revealed.has(tile)) {
    return res.status(400).json({ error: 'already revealed' })
  }

  const isMine = game.mines.includes(tile)
  game.revealed.add(tile)

  if (isMine) {
    const stake = game.stake
    deleteActiveGame(key)
    discord.logBet({ identifier, game: 'mines', stake, multiplier: 0, payout: 0, won: false })
    if (stake >= 500000) discord.logGameLoss({ identifier, game: 'mines', stake })
    return res.json({
      success: true, hit: true, tile, mines: game.mines,
      hash: game.hash, nonce: game.nonce, stake,
    })
  }

  game.revealCount++
  const multiplier = calcMinesMultiplier(game.numMines, game.revealCount)
  const payout = Math.floor(game.stake * multiplier)
  setActiveGame(key, game)

  res.json({ success: true, hit: false, tile, multiplier, payout, revealCount: game.revealCount })
})

router.post('/mines/cashout', (req, res) => {
  const { identifier } = req.body
  const key = `${identifier}_mines`
  const game = getActiveGame(key)
  if (!game) return res.status(404).json({ error: 'no active game' })

  const multiplier = calcMinesMultiplier(game.numMines, game.revealCount)
  const payout = Math.floor(game.stake * multiplier)
  const mines = game.mines
  const stake = game.stake
  deleteActiveGame(key)

  discord.logBet({ identifier, game: 'mines', stake, multiplier, payout, won: true })
  discord.logCashout({ identifier, game: 'mines', stake, multiplier, payout })
  if (payout >= 1000000) discord.logBigWin({ identifier, game: 'mines', stake, multiplier, payout })

  res.json({ success: true, multiplier, payout, mines, hash: game.hash, nonce: game.nonce, stake })
})

// --- Chicken ---
router.post('/chicken/start', (req, res) => {
  const { identifier, stake, serverSeed, clientSeed, nonce, cols } = req.body
  const hash = serverSeed
  const key = `${identifier}_chicken`
  const gameCols = Math.min(6, Math.max(3, cols || 4))

  if (getActiveGame(key)) {
    return res.status(400).json({ error: 'game already active' })
  }

  setActiveGame(key, {
    game: 'chicken', stake, hash, nonce, cols: gameCols,
    currentRow: 0, lastLane: null, revealedHazards: {},
  })

  res.json({ success: true, cols: gameCols })
})

router.post('/chicken/step', (req, res) => {
  const { identifier, lane } = req.body
  const key = `${identifier}_chicken`
  const game = getActiveGame(key)
  if (!game) return res.status(404).json({ error: 'no active game' })
  const gameCols = game.cols || 4
  if (lane < 1 || lane > gameCols) return res.status(400).json({ error: 'invalid lane' })

  const nextRow = game.currentRow + 1
  const hazardPos = getChickenHazard(game.hash, nextRow, gameCols)
  const hazardType = getHazardType(game.hash, nextRow)
  game.revealedHazards[nextRow] = { pos: hazardPos, type: hazardType }

  if (lane === hazardPos) {
    const field = { ...game.revealedHazards }
    const stake = game.stake
    deleteActiveGame(key)
    discord.logBet({ identifier, game: 'chicken', stake, multiplier: 0, payout: 0, won: false })
    if (stake >= 500000) discord.logGameLoss({ identifier, game: 'chicken', stake })
    return res.json({
      success: true, hit: true, row: nextRow, lane, hazardPos, hazardType, field,
      hash: game.hash, nonce: game.nonce, stake,
    })
  }

  game.currentRow = nextRow
  game.lastLane = lane
  const multiplier = calcChickenMultiplier(game.currentRow, gameCols)
  const payout = Math.floor(game.stake * multiplier)
  setActiveGame(key, game)

  const giftRows = { 4: true, 8: true, 13: true, 19: true, 26: true }
  let gift = null
  if (giftRows[nextRow]) {
    const giftAmount = Math.floor(game.stake * (0.05 + Math.random() * 0.10))
    const giftType = nextRow % 2 === 0 ? 'homecoin' : 'cash'
    gift = { type: giftType, amount: giftAmount }
  }

  res.json({ success: true, hit: false, row: nextRow, lane, multiplier, payout, gift, hazardType })
})

router.post('/chicken/cashout', (req, res) => {
  const { identifier } = req.body
  const key = `${identifier}_chicken`
  const game = getActiveGame(key)
  if (!game) return res.status(404).json({ error: 'no active game' })

  const multiplier = calcChickenMultiplier(game.currentRow, game.cols || 4)
  const payout = Math.floor(game.stake * multiplier)
  const field = { ...game.revealedHazards }
  const stake = game.stake
  deleteActiveGame(key)

  discord.logBet({ identifier, game: 'chicken', stake, multiplier, payout, won: true })
  discord.logCashout({ identifier, game: 'chicken', stake, multiplier, payout })
  if (payout >= 1000000) discord.logBigWin({ identifier, game: 'chicken', stake, multiplier, payout })

  res.json({ success: true, multiplier, payout, field, hash: game.hash, nonce: game.nonce, stake })
})

// --- Plinko ---
router.post('/plinko/bet', (req, res) => {
  const { identifier, stake, rows, risk } = req.body
  let { serverSeed, clientSeed, nonce } = req.body
  if (!identifier || !stake || stake <= 0) return res.status(400).json({ error: 'invalid params' })
  const validRows = [8, 12, 16]
  const validRisk = ['low', 'medium', 'high']

  // FAST PATH: when the resource sets autoSeed, the engine generates the outcome
  // hash itself (one request per ball, no separate /fair/outcome round-trip). Falls
  // back to a caller-supplied serverSeed for backward compatibility.
  let serverSeedHash
  if (req.body.autoSeed || !serverSeed) {
    const o = seedStore.nextOutcome(identifier)
    serverSeed = o.hash          // the per-round game hash used by floatFromHash
    nonce = o.nonce
    clientSeed = o.clientSeed
    serverSeedHash = o.serverSeedHash
  }
  const hash = serverSeed
  const numRows = validRows.includes(rows) ? rows : 12
  const safeRisk = validRisk.includes(risk) ? risk : 'medium'
  const bucket = getPlinkoBucket(hash, numRows)

  const path = []
  for (let i = 0; i < numRows; i++) {
    const f = floatFromHash(hash, i + 10)
    path.push(f < 0.5 ? 0 : 1)
  }

  const MULTIPLIERS = getMultiplierTable(safeRisk, numRows)
  const multiplier = MULTIPLIERS[bucket] || 1
  const payout = Math.floor(stake * multiplier)

  discord.logBet({ identifier, game: 'plinko', stake, multiplier, payout, won: payout > stake })
  if (payout >= 1000000) discord.logBigWin({ identifier, game: 'plinko', stake, multiplier, payout })
  if (payout === 0 && stake >= 500000) discord.logGameLoss({ identifier, game: 'plinko', stake })

  res.json({ success: true, bucket, multiplier, payout, hash, nonce, path, clientSeed, serverSeedHash })
})

// --- Crash (state machine) ---
router.get('/crash/state', (req, res) => {
  const elapsed = crashState.state === 'running' && crashState.startTime
    ? Date.now() - crashState.startTime : 0

  res.json({
    state: crashState.state,
    countdown: crashState.countdownEnd ? Math.max(0, crashState.countdownEnd - Math.floor(Date.now() / 1000)) : 0,
    elapsed,
    crashPoint: crashState.state === 'ended' ? crashState.crashPoint : null,
    betList: getCrashBetList(),
  })
})

router.post('/crash/bet', (req, res) => {
  const { identifier, stake, displayName } = req.body
  let { autoCashout } = req.body
  if (crashState.state !== 'waiting') {
    return res.status(400).json({ error: 'not accepting bets' })
  }
  if (crashState.bets[identifier]) {
    return res.status(400).json({ error: 'already bet' })
  }
  if (autoCashout && autoCashout > 30) autoCashout = 30

  crashState.bets[identifier] = {
    stake, autoCashout: autoCashout || null,
    cashedOut: false, multiplier: null, payout: 0,
    name: displayName || 'Hidden',
  }

  res.json({ success: true, betList: getCrashBetList() })
})

router.post('/crash/cashout', (req, res) => {
  const { identifier, multiplier } = req.body
  if (crashState.state !== 'running') {
    return res.status(400).json({ error: 'not running' })
  }
  const bet = crashState.bets[identifier]
  if (!bet || bet.cashedOut) {
    return res.status(400).json({ error: 'no bet or already cashed' })
  }

  const currentMult = getCurrentCrashMultiplier()
  if (currentMult >= crashState.crashPoint) {
    return res.status(400).json({ error: 'round ended' })
  }
  const cashMult = Math.min(multiplier || currentMult, currentMult, crashState.crashPoint - 0.01)

  bet.cashedOut = true
  bet.multiplier = parseFloat(cashMult.toFixed(2))
  bet.payout = Math.floor(bet.stake * bet.multiplier)

  res.json({ success: true, multiplier: bet.multiplier, payout: bet.payout, stake: bet.stake, betList: getCrashBetList() })
})

router.post('/crash/join', (req, res) => {
  const { identifier } = req.body
  crashState.watchers[identifier] = true
  const elapsed = crashState.state === 'running' && crashState.startTime
    ? Date.now() - crashState.startTime : 0
  const bet = crashState.bets[identifier]

  res.json({
    state: crashState.state,
    countdown: crashState.countdownEnd ? Math.max(0, crashState.countdownEnd - Math.floor(Date.now() / 1000)) : 0,
    elapsed,
    crashPoint: crashState.state === 'ended' ? crashState.crashPoint : null,
    betList: getCrashBetList(),
    hasBet: !!bet,
    cashedOut: bet?.cashedOut || false,
    cashoutMultiplier: bet?.multiplier || null,
  })
})

router.post('/crash/leave', (req, res) => {
  const { identifier } = req.body
  delete crashState.watchers[identifier]
  res.json({ success: true })
})

router.get('/crash/settle', (req, res) => {
  const results = Object.entries(crashState.bets).map(([id, bet]) => ({
    identifier: id,
    stake: bet.stake,
    cashedOut: bet.cashedOut,
    multiplier: bet.multiplier,
    payout: bet.payout,
  }))

  let totalStake = 0, totalPayout = 0, winners = 0, losers = 0
  for (const [id, bet] of Object.entries(crashState.bets)) {
    totalStake += bet.stake
    totalPayout += bet.payout
    if (bet.cashedOut) {
      winners++
      discord.logBet({ identifier: id, game: 'crash', stake: bet.stake, multiplier: bet.multiplier, payout: bet.payout, won: true })
      if (bet.payout >= 1000000) discord.logBigWin({ identifier: id, game: 'crash', stake: bet.stake, multiplier: bet.multiplier, payout: bet.payout })
    } else {
      losers++
      discord.logBet({ identifier: id, game: 'crash', stake: bet.stake, multiplier: 0, payout: 0, won: false })
      if (bet.stake >= 500000) discord.logGameLoss({ identifier: id, game: 'crash', stake: bet.stake })
    }
  }
  if (Object.keys(crashState.bets).length > 0) {
    discord.logCrashRound({ crashPoint: crashState.crashPoint, totalBets: Object.keys(crashState.bets).length, totalStake, totalPayout, winners, losers })
  }

  res.json({ success: true, crashPoint: crashState.crashPoint, bets: results })
})

// True while the player has a mines or chicken round in progress. Used by
// fair.js to block seed rotation/changes mid-game (prevents outcome prediction).
function hasActiveGame(identifier) {
  return !!(getActiveGame(`${identifier}_mines`) || getActiveGame(`${identifier}_chicken`))
}

// Live-round kinds for this identifier (in-game-priority suspend / roundcheck).
// Returns the list of casino games this player currently has an UNRESOLVED round
// in: mines/chicken (persisted single-player) + an unsettled crash bet (they have
// staked this round and haven't cashed out / it hasn't busted). The engine holds
// all of this even when the player's phone app is closed, so the in-game client
// can safely wait on it. Blackjack/mahjong are added by their own modules.
function liveRoundKinds(identifier) {
  const kinds = []
  if (getActiveGame(`${identifier}_mines`)) kinds.push('mines')
  if (getActiveGame(`${identifier}_chicken`)) kinds.push('chicken')
  // Crash: a bet placed for the current round that hasn't resolved. Once the round
  // ends (busted) or the player cashes out, their entry is cleared, so presence of
  // the entry == money still in play this round.
  const cb = crashState.bets[identifier]
  if (cb && !cb.cashedOut) kinds.push('crash')
  return kinds
}

// --- Active games query ---
router.get('/active/:identifier', (req, res) => {
  const id = req.params.identifier
  const games = []

  const minesGame = getActiveGame(`${id}_mines`)
  if (minesGame) {
    const mult = calcMinesMultiplier(minesGame.numMines, minesGame.revealCount)
    games.push({
      game: 'mines', stake: minesGame.stake,
      numMines: minesGame.numMines, revealCount: minesGame.revealCount,
      revealedTiles: [...minesGame.revealed],
      multiplier: mult, payout: Math.floor(minesGame.stake * mult),
    })
  }

  const chickenGame = getActiveGame(`${id}_chicken`)
  if (chickenGame) {
    const mult = calcChickenMultiplier(chickenGame.currentRow, chickenGame.cols || 4)
    games.push({
      game: 'chicken', stake: chickenGame.stake,
      currentRow: chickenGame.currentRow, lastLane: chickenGame.lastLane,
      cols: chickenGame.cols || 4,
      multiplier: mult, payout: Math.floor(chickenGame.stake * mult),
    })
  }

  // Live table games. These hold a seat/table rather than a persisted single-player
  // round, so we report just enough for the client to offer "Resume" and rejoin the
  // exact room/lobby. Lazy-required to dodge a load-time circular require.
  try {
    const bj = require('./blackjack')
    const bjSeat = bj.peekSeat && bj.peekSeat(id)
    if (bjSeat) games.push({ game: 'blackjack', room: bjSeat.room, seat: bjSeat.seat, behind: bjSeat.behind, state: bjSeat.state })
  } catch (e) { console.error('[active] blackjack:', e.message) }
  try {
    const mj = require('./mahjong')
    const mjSeat = mj.peekSeat && mj.peekSeat(id)
    if (mjSeat) games.push({ game: 'mahjong', lobby: mjSeat.lobby, seat: mjSeat.seat, style: mjSeat.style, state: mjSeat.state, name: mjSeat.name, stack: mjSeat.stack })
  } catch (e) { console.error('[active] mahjong:', e.message) }

  res.json({ active: games.length > 0, games })
})

// --- Player disconnect cleanup ---
router.post('/disconnect/:identifier', (req, res) => {
  const id = req.params.identifier
  deleteActiveGame(`${id}_mines`)
  deleteActiveGame(`${id}_chicken`)
  delete crashState.watchers[id]
  res.json({ success: true })
})

// --- Crash loop (runs independently) ---
function getCurrentCrashMultiplier() {
  if (crashState.state !== 'running' || !crashState.startTime) return 1
  const elapsed = (Date.now() - crashState.startTime) / 1000
  return Math.pow(Math.E, 0.08 * elapsed)
}

function getCrashBetList() {
  return Object.entries(crashState.bets).map(([id, bet]) => ({
    name: bet.name, stake: bet.stake,
    cashedOut: bet.cashedOut, multiplier: bet.multiplier,
    payout: bet.payout,
  }))
}

const SEED_ROTATE_INTERVAL = 50

function startCrashRound() {
  crashState.state = 'waiting'
  crashState.bets = {}
  crashState.nonce++
  if (crashState.nonce % SEED_ROTATE_INTERVAL === 0) {
    crashState.serverSeed = crypto.randomBytes(32).toString("hex")
    console.log("[crash] Server seed rotated at nonce " + crashState.nonce)
  }
  crashState.hash = generateGameHash(crashState.serverSeed, 'crash-round', crashState.nonce)
  crashState.crashPoint = generateCrashPoint(crashState.hash)
  crashState.countdownEnd = Math.floor(Date.now() / 1000) + CRASH_WAIT_TIME
  crashState.startTime = null
  crashState._webSettled = false
}

function runCrashRound() {
  crashState.state = 'running'
  crashState.startTime = Date.now()
}

setInterval(() => {
  if (crashState.state === 'idle') {
    startCrashRound()
  } else if (crashState.state === 'waiting') {
    if (Math.floor(Date.now() / 1000) >= crashState.countdownEnd) {
      runCrashRound()
    }
  } else if (crashState.state === 'running') {
    const mult = getCurrentCrashMultiplier()
    if (mult >= crashState.crashPoint) {
      crashState.state = 'ended'
      // Single settlement edge for web bets (guard against re-entry within the tick).
      if (!crashState._webSettled) {
        crashState._webSettled = true
        settleWebCrashBets()
      }
    } else {
      for (const [id, bet] of Object.entries(crashState.bets)) {
        if (!bet.cashedOut && bet.autoCashout && mult >= bet.autoCashout) {
          bet.cashedOut = true
          bet.multiplier = bet.autoCashout
          bet.payout = Math.floor(bet.stake * bet.multiplier)
        }
      }
    }
  } else if (crashState.state === 'ended') {
  }
}, 50)

setInterval(() => {
  if (crashState.state === 'ended') {
    if (!crashState._endTimer) {
      crashState._endTimer = Date.now()
    } else if (Date.now() - crashState._endTimer >= CRASH_END_DELAY * 1000) {
      crashState._endTimer = null
      startCrashRound()
    }
  }
}, 500)

setTimeout(() => startCrashRound(), 2000)

// --- Plinko multiplier tables ---
function getMultiplierTable(risk, rows) {
  const tables = {
    low: {
      8: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
      12: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
      16: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    },
    medium: {
      8: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
      12: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
      16: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    },
    high: {
      8: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
      12: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
      16: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
    },
  }
  return tables[risk]?.[rows] || tables.medium[12]
}

// ── Pure game-logic helpers (money-free) shared with the mobile web bridge ──
// The /casino/* routes above are driven by the in-game relay, which owns cash.
// mobileCasino.js needs the SAME outcome logic but owns cash itself (applyGameCash),
// so these expose the engine's game math as plain function calls. They use the
// identical gamePersist keys, so an in-game round and a web round can never overlap
// for one identifier (roundcheck also reads these keys).
function startMines({ identifier, stake, numMines, serverSeed, clientSeed, nonce }) {
  const key = `${identifier}_mines`
  if (getActiveGame(key)) return { success: false, error: 'game already active' }
  const hash = serverSeed
  const mines = new Set()
  let cursor = 0
  while (mines.size < numMines) {
    mines.add(Math.floor(floatFromHash(hash, cursor) * 25)); cursor++
  }
  setActiveGame(key, { game: 'mines', stake, numMines, hash, nonce, mines: [...mines], revealed: new Set(), revealCount: 0 })
  return { success: true }
}
function revealMine({ identifier, tile }) {
  const key = `${identifier}_mines`
  const game = getActiveGame(key)
  if (!game) return { success: false, error: 'no active game' }
  if (game.revealed.has(tile)) return { success: false, error: 'already revealed' }
  const isMine = game.mines.includes(tile)
  game.revealed.add(tile)
  if (isMine) {
    const stake = game.stake, hash = game.hash, nonce = game.nonce, minesArr = game.mines
    deleteActiveGame(key)
    return { success: true, hit: true, tile, mines: minesArr, hash, nonce, stake }
  }
  game.revealCount++
  const multiplier = calcMinesMultiplier(game.numMines, game.revealCount)
  setActiveGame(key, game)
  return { success: true, hit: false, tile, multiplier, revealCount: game.revealCount, stake: game.stake }
}
function cashoutMines({ identifier }) {
  const key = `${identifier}_mines`
  const game = getActiveGame(key)
  if (!game) return { success: false, error: 'no active game' }
  const multiplier = calcMinesMultiplier(game.numMines, game.revealCount)
  const payout = Math.floor(game.stake * multiplier)
  const out = { success: true, multiplier, payout, mines: game.mines, hash: game.hash, nonce: game.nonce, stake: game.stake }
  deleteActiveGame(key)
  return out
}
function playDice({ stake, target, isOver, serverSeed }) {
  const hash = serverSeed
  const roll = getDiceRoll(hash)
  const won = isOver ? roll > target : roll < target
  const edge = 0.01
  const multiplier = isOver
    ? parseFloat((100 / (100 - target) * (1 - edge)).toFixed(4))
    : parseFloat((100 / target * (1 - edge)).toFixed(4))
  const payout = won ? Math.floor(stake * multiplier) : 0
  return { roll: parseFloat(roll.toFixed(2)), won, multiplier, payout }
}
function startChicken({ identifier, stake, serverSeed, clientSeed, nonce, cols }) {
  const key = `${identifier}_chicken`
  if (getActiveGame(key)) return { success: false, error: 'game already active' }
  const gameCols = Math.min(6, Math.max(3, cols || 4))
  setActiveGame(key, { game: 'chicken', stake, hash: serverSeed, nonce, cols: gameCols, currentRow: 0, lastLane: null, revealedHazards: {} })
  return { success: true, cols: gameCols }
}
function stepChicken({ identifier, lane }) {
  const key = `${identifier}_chicken`
  const game = getActiveGame(key)
  if (!game) return { success: false, error: 'no active game' }
  const gameCols = game.cols || 4
  if (lane < 1 || lane > gameCols) return { success: false, error: 'invalid lane' }
  const nextRow = game.currentRow + 1
  const hazardPos = getChickenHazard(game.hash, nextRow, gameCols)
  const hazardType = getHazardType(game.hash, nextRow)
  game.revealedHazards[nextRow] = { pos: hazardPos, type: hazardType }
  if (lane === hazardPos) {
    const field = { ...game.revealedHazards }, stake = game.stake, hash = game.hash, nonce = game.nonce
    deleteActiveGame(key)
    return { success: true, hit: true, row: nextRow, lane, hazardPos, hazardType, field, hash, nonce, stake }
  }
  game.currentRow = nextRow
  game.lastLane = lane
  const multiplier = calcChickenMultiplier(game.currentRow, gameCols)
  setActiveGame(key, game)
  const giftRows = { 4: true, 8: true, 13: true, 19: true, 26: true }
  let gift = null
  if (giftRows[nextRow]) {
    const giftAmount = Math.floor(game.stake * (0.05 + Math.random() * 0.10))
    gift = { type: nextRow % 2 === 0 ? 'homecoin' : 'cash', amount: giftAmount }
  }
  return { success: true, hit: false, row: nextRow, lane, multiplier, gift, hazardType }
}
function cashoutChicken({ identifier }) {
  const key = `${identifier}_chicken`
  const game = getActiveGame(key)
  if (!game) return { success: false, error: 'no active game' }
  const multiplier = calcChickenMultiplier(game.currentRow, game.cols || 4)
  const payout = Math.floor(game.stake * multiplier)
  const out = { success: true, multiplier, payout, field: { ...game.revealedHazards }, hash: game.hash, nonce: game.nonce, stake: game.stake }
  deleteActiveGame(key)
  return out
}
function playPlinko({ identifier, stake, rows, risk }) {
  const validRows = [8, 12, 16], validRisk = ['low', 'medium', 'high']
  const o = seedStore.nextOutcome(identifier)
  const hash = o.hash
  const numRows = validRows.includes(rows) ? rows : 12
  const safeRisk = validRisk.includes(risk) ? risk : 'medium'
  const bucket = getPlinkoBucket(hash, numRows)
  const path = []
  for (let i = 0; i < numRows; i++) path.push(floatFromHash(hash, i + 10) < 0.5 ? 0 : 1)
  const multiplier = (getMultiplierTable(safeRisk, numRows)[bucket]) || 1
  const payout = Math.floor(stake * multiplier)
  return { bucket, multiplier, payout, path, hash, nonce: o.nonce }
}

module.exports = router
module.exports.hasActiveGame = hasActiveGame
module.exports.liveRoundKinds = liveRoundKinds
module.exports.startMines = startMines
module.exports.revealMine = revealMine
module.exports.cashoutMines = cashoutMines
module.exports.playDice = playDice
module.exports.startChicken = startChicken
module.exports.stepChicken = stepChicken
module.exports.cashoutChicken = cashoutChicken
module.exports.playPlinko = playPlinko
module.exports.peekActiveGame = (identifier, kind) => getActiveGame(`${identifier}_${kind}`)
module.exports.calcMinesMultiplier = calcMinesMultiplier
module.exports.calcChickenMultiplier = calcChickenMultiplier
// Web crash (Phase 2b)
module.exports.setWebCrashSettleHandler = setWebCrashSettleHandler
module.exports.getCrashStateFor = getCrashStateFor
module.exports.addCrashWatcher = addCrashWatcher
module.exports.removeCrashWatcher = removeCrashWatcher
module.exports.placeWebCrashBet = placeWebCrashBet
module.exports.tagWebCrashBet = tagWebCrashBet
module.exports.dropWebCrashBet = dropWebCrashBet
module.exports.cashoutWebCrash = cashoutWebCrash
module.exports.peekWebCrashBet = peekWebCrashBet
module.exports.dropExcluded = dropExcluded
module.exports.addExcluded = addExcluded
module.exports.clearAllExcluded = clearAllExcluded
module.exports.refreshExclusions = refreshExclusions

// --- Exclusion status check (for FiveM to query on NUI open) ---
router.get('/exclusion-status/:identifier', (req, res) => {
  const id = req.params.identifier
  if (!excludedSet.has(id)) {
    return res.json({ excluded: false })
  }
  // Fetch full details from DB
  const { getPool } = require('../db')
  const pool = getPool()
  pool.query('SELECT reason, expires_at, created_at FROM hk_casino_exclusions WHERE identifier = ? AND active = 1', [id])
    .then(([rows]) => {
      if (!rows.length) return res.json({ excluded: false })
      const row = rows[0]
      const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null
      const now = Date.now()
      if (expiresAt && expiresAt <= now) {
        excludedSet.delete(id)
        return res.json({ excluded: false })
      }
      res.json({
        excluded: true,
        reason: row.reason,
        expiresAt: expiresAt,
        remainingMs: expiresAt ? expiresAt - now : null,
      })
    })
    .catch(() => res.json({ excluded: false }))
})
