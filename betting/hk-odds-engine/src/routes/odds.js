const express = require('express')
const { getNextKey } = require('../keys')
const { proxyFetch } = require('../proxy')
const { getCache, getCacheRaw, setCache } = require('../oddsCache')
const { fetchOddsForSport, filterUpcoming } = require('../crons/odds')

const router = express.Router()

router.get('/sports/:sportKey', async (req, res) => {
  const { sportKey } = req.params

  // Serve from cache (includes drifted odds)
  const cached = getCacheRaw(sportKey)
  if (cached && cached.length > 0) {
    // Filter out started matches before serving
    const upcoming = filterUpcoming(cached)
    return res.json(upcoming)
  }

  // Cache empty — try one live fetch
  try {
    const events = await fetchOddsForSport(sportKey)
    if (events && events.length > 0) {
      const upcoming = filterUpcoming(events)
      setCache(sportKey, upcoming)
      return res.json(upcoming)
    }
  } catch (err) {
    console.error('[odds] ' + sportKey + ':', err.message)
  }

  res.json([])
})

router.get('/scores/:sportKey', async (req, res) => {
  try {
    const apiKey = getNextKey('oddsApi')
    if (!apiKey) return res.json([])
    const url = 'https://YOUR_ODDS_API_HOST/v4/sports/' + sportKey + '/scores/?apiKey=' + apiKey + '&daysFrom=2'
    const resp = await proxyFetch(url)
    if (!resp.ok) return res.json([])
    const data = await resp.json()
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: 'fetch failed' })
  }
})

module.exports = router
