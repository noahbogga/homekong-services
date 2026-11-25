const fs = require('fs')
const path = require('path')

const CACHE_FILE = path.join(__dirname, '../data/odds-cache.json')
const CACHE_TTL = 600 * 1000

let oddsCache = {}

// Load from disk on startup
try {
  if (fs.existsSync(CACHE_FILE)) {
    oddsCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    console.log('[cache] Loaded ' + Object.keys(oddsCache).length + ' sports from disk')
  }
} catch (e) {
  console.error('[cache] Failed to load disk cache:', e.message)
}

function saveToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(oddsCache))
  } catch (e) {}
}

function setCache(sportKey, data) {
  oddsCache[sportKey] = { data, time: Date.now() }
  saveToDisk()
}

function getCache(sportKey) {
  const cached = oddsCache[sportKey]
  if (!cached) return null
  if (Date.now() - cached.time > CACHE_TTL) return null
  return cached.data
}

function getCacheRaw(sportKey) {
  return oddsCache[sportKey]?.data || null
}

// All sport keys currently in cache (incl. legacy seeds not in SHARP_LEAGUE_MAP).
function getCachedSports() {
  return Object.keys(oddsCache)
}

module.exports = { setCache, getCache, getCacheRaw, getCachedSports, CACHE_TTL }
