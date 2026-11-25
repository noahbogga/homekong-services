// server.js — Express server for stake-odds container
const express = require('express')
const { startPollers, triggerSport, fixtureCache } = require('./poller')
const { SPORTS } = require('./sports')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 4201

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), fixtures: fixtureCache.size })
})

app.get('/status', (req, res) => {
  const bySport = {}
  for (const [href, ev] of fixtureCache) {
    const s = ev.sportKey || 'unknown'
    bySport[s] = (bySport[s] || 0) + 1
  }
  res.json({ fixtures: fixtureCache.size, bySport, sports: Object.keys(SPORTS) })
})

// Manual trigger: force a scrape of one sport right now
app.post('/trigger/:sport', async (req, res) => {
  const { sport } = req.params
  if (!SPORTS[sport]) return res.status(404).json({ error: 'unknown sport: ' + sport })
  try {
    const events = await triggerSport(sport)
    res.json({ ok: true, sport, fixtures: events.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[stake-odds] listening on :${PORT}`)
  startPollers()
})
