// seeds.js — shared provably-fair seed store (data/seeds.json), used by both
// routes/fair.js (player-facing seed mgmt) and routes/casino.js (per-round outcome
// generation). Extracting this lets casino games generate their own outcome hash
// server-side in ONE request, instead of the resource pre-fetching a hash via a
// separate /fair/outcome HTTP round-trip per bet (the plinko rapid-fire bottleneck).
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SEEDS_FILE = path.join(__dirname, '../data/seeds.json')

function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) {
    fs.writeFileSync(SEEDS_FILE, JSON.stringify({}))
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf-8'))
  } catch (e) {
    console.error('[seeds] seeds.json corrupted, resetting:', e.message)
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

// per-round outcome hash: HMAC(serverSeed, "clientSeed:nonce:cursor") — the exact
// formula casino.js floatFromHash / getPlinkoBucket expect (cursor 0).
function gameHash(serverSeed, clientSeed, nonce) {
  return crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:0`).digest('hex')
}

// Ensure a seed pair exists for a player (auto-create with a client seed).
function ensureSeed(seeds, identifier) {
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
  return seeds[identifier]
}

// Advance nonce + return one outcome. Persists. This is the single-call primitive
// casino games use: { hash, nonce, serverSeedHash, clientSeed }.
function nextOutcome(identifier) {
  const seeds = loadSeeds()
  const s = ensureSeed(seeds, identifier)
  s.nonce++
  const hash = gameHash(s.serverSeed, s.clientSeed, s.nonce)
  saveSeeds(seeds)
  return { hash, nonce: s.nonce, serverSeedHash: s.serverSeedHash, clientSeed: s.clientSeed }
}

module.exports = {
  SEEDS_FILE, loadSeeds, saveSeeds, generateServerSeed, hashSeed, gameHash,
  ensureSeed, nextOutcome,
}
