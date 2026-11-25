const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { hasActiveGame } = require('./casino')

const router = express.Router()
const SEEDS_FILE = path.join(__dirname, '../../data/seeds.json')

function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) {
    fs.writeFileSync(SEEDS_FILE, JSON.stringify({}))
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf-8'))
  } catch (e) {
    console.error('[fair] seeds.json corrupted, resetting:', e.message)
    fs.writeFileSync(SEEDS_FILE, JSON.stringify({}))
    return {}
  }
}

function saveSeeds(seeds) {
  fs.writeFileSync(SEEDS_FILE, JSON.stringify(seeds, null, 2))
}

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex')
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

function generateGameHash(serverSeed, game, nonce) {
  return crypto.createHmac('sha256', serverSeed).update(`${game}:${nonce}`).digest('hex')
}

// Get or create player seed pair
router.get('/seed/:identifier', (req, res) => {
  const { identifier } = req.params
  const seeds = loadSeeds()

  if (!seeds[identifier]) {
    const serverSeed = generateServerSeed()
    seeds[identifier] = {
      serverSeed,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed: crypto.randomBytes(8).toString('hex'),
      nonce: 0,
      previousSeeds: [],
    }
    saveSeeds(seeds)
  }

  // history = revealed previous seeds (mirrors resource getFairness history list)
  const history = (seeds[identifier].previousSeeds || []).slice().reverse().map(p => ({
    server_seed: p.serverSeed,
    server_seed_hash: p.serverSeedHash,
    client_seed: p.clientSeed || seeds[identifier].clientSeed,
    nonce: p.nonce,
    revealed_at: p.rotatedAt,
  }))
  res.json({
    serverSeedHash: seeds[identifier].serverSeedHash,
    clientSeed: seeds[identifier].clientSeed,
    nonce: seeds[identifier].nonce,
    history,
  })
})

// Generate game hash for a specific round
router.post('/hash', (req, res) => {
  const { identifier, game } = req.body
  const seeds = loadSeeds()

  if (!seeds[identifier]) {
    return res.status(404).json({ error: 'no seed found' })
  }

  seeds[identifier].nonce++
  const hash = generateGameHash(seeds[identifier].serverSeed, game, seeds[identifier].nonce)
  saveSeeds(seeds)

  res.json({ hash, nonce: seeds[identifier].nonce })
})

// Generate one game outcome (replaces resource fair.lua GenerateGameOutcomeSync).
// Returns {hash, nonce, serverSeedHash, clientSeed} where hash uses the
// clientSeed:nonce formula that casino.js floatFromHash expects. Auto-creates the
// seed pair on first use. This is what every casino game round calls.
router.post('/outcome/:identifier', (req, res) => {
  const { identifier } = req.params
  const seeds = loadSeeds()
  if (!seeds[identifier]) {
    const serverSeed = generateServerSeed()
    seeds[identifier] = {
      serverSeed,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed: crypto.randomBytes(8).toString('hex'),
      nonce: 0,
      previousSeeds: [],
    }
  }
  const s = seeds[identifier]
  s.nonce++
  // HMAC(serverSeed, "clientSeed:nonce:0") — matches casino.js generateGameHash/floatFromHash
  const hash = crypto.createHmac('sha256', s.serverSeed)
    .update(`${s.clientSeed}:${s.nonce}:0`).digest('hex')
  saveSeeds(seeds)
  res.json({ hash, nonce: s.nonce, serverSeedHash: s.serverSeedHash, clientSeed: s.clientSeed })
})

// Rotate server seed (reveals old one)
router.post('/rotate/:identifier', (req, res) => {
  const { identifier } = req.params
  const seeds = loadSeeds()

  // Block rotation while player has an active game (prevents predicting outcomes)
  if (hasActiveGame(identifier)) {
    return res.status(400).json({ error: 'cannot rotate while game is active' })
  }

  if (!seeds[identifier]) {
    // auto-create then there is nothing to reveal
    const ss = generateServerSeed()
    seeds[identifier] = { serverSeed: ss, serverSeedHash: hashSeed(ss),
      clientSeed: crypto.randomBytes(8).toString('hex'), nonce: 0, previousSeeds: [] }
    saveSeeds(seeds)
    return res.json({ revealedSeed: null, revealedHash: null, newHash: seeds[identifier].serverSeedHash })
  }

  const oldSeed = seeds[identifier].serverSeed
  const oldHash = seeds[identifier].serverSeedHash
  const oldNonce = seeds[identifier].nonce

  const newServerSeed = generateServerSeed()
  seeds[identifier].previousSeeds = seeds[identifier].previousSeeds || []
  seeds[identifier].previousSeeds.push({
    serverSeed: oldSeed,
    serverSeedHash: oldHash,
    nonce: oldNonce,
    rotatedAt: new Date().toISOString(),
  })

  if (seeds[identifier].previousSeeds.length > 10) {
    seeds[identifier].previousSeeds = seeds[identifier].previousSeeds.slice(-10)
  }

  seeds[identifier].serverSeed = newServerSeed
  seeds[identifier].serverSeedHash = hashSeed(newServerSeed)
  seeds[identifier].nonce = 0
  saveSeeds(seeds)

  res.json({
    revealedSeed: oldSeed,
    revealedHash: oldHash,
    newHash: seeds[identifier].serverSeedHash,
  })
})

// Set client seed — also ROTATES the server seed (reveals old) for security,
// mirroring the resource's SetClientSeed. Auto-creates on first use.
router.post('/client-seed/:identifier', (req, res) => {
  const { identifier } = req.params
  let { clientSeed } = req.body
  clientSeed = String(clientSeed || '').slice(0, 64)
  if (clientSeed.length < 1) clientSeed = 'default'

  const seeds = loadSeeds()
  if (hasActiveGame(identifier)) {
    return res.status(400).json({ error: 'cannot change seed while game is active' })
  }

  let revealedSeed = null
  if (seeds[identifier]) {
    revealedSeed = seeds[identifier].serverSeed
    seeds[identifier].previousSeeds = seeds[identifier].previousSeeds || []
    seeds[identifier].previousSeeds.push({
      serverSeed: seeds[identifier].serverSeed,
      serverSeedHash: seeds[identifier].serverSeedHash,
      clientSeed: seeds[identifier].clientSeed,
      nonce: seeds[identifier].nonce,
      rotatedAt: new Date().toISOString(),
    })
    if (seeds[identifier].previousSeeds.length > 10) {
      seeds[identifier].previousSeeds = seeds[identifier].previousSeeds.slice(-10)
    }
  } else {
    seeds[identifier] = { previousSeeds: [] }
  }

  const newServerSeed = generateServerSeed()
  seeds[identifier].serverSeed = newServerSeed
  seeds[identifier].serverSeedHash = hashSeed(newServerSeed)
  seeds[identifier].clientSeed = clientSeed
  seeds[identifier].nonce = 0
  saveSeeds(seeds)

  res.json({ revealedSeed, newServerSeedHash: seeds[identifier].serverSeedHash, clientSeed })
})

module.exports = router
