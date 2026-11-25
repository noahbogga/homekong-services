const fs = require('fs')
const path = require('path')

const KEYS_FILE = path.join(__dirname, '../data/api-keys.json')

function loadKeys() {
  if (!fs.existsSync(KEYS_FILE)) {
    const defaults = {
      oddsApi: [
        "CHANGE_ME",
        "CHANGE_ME",
        "CHANGE_ME",
        "CHANGE_ME"
      ],
      sharpApi: [
        "CHANGE_ME",
        "CHANGE_ME",
        "CHANGE_ME",
        "CHANGE_ME",
        "CHANGE_ME"
      ],
      footballData: []
    }
    fs.writeFileSync(KEYS_FILE, JSON.stringify(defaults, null, 2))
    return defaults
  }
  return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'))
}

let keyIndex = { oddsApi: 0, sharpApi: 0 }

function getNextKey(provider) {
  const keys = loadKeys()
  const pool = keys[provider] || []
  if (pool.length === 0) return null
  const key = pool[keyIndex[provider] % pool.length]
  keyIndex[provider]++
  return key
}

module.exports = { loadKeys, getNextKey }
