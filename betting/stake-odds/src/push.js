// push.js — POST events to hk-odds-engine /odds/ingest
const ENGINE_URL = process.env.ENGINE_URL || 'http://hk-odds-engine:4200'
const AUTH_TOKEN = process.env.AUTH_SECRET || 'CHANGE_ME'

async function pushIngest({ sportKey, events, mode = 'replace', source = 'stake' }) {
  if (!events || !events.length) return { ok: true, ingested: 0, note: 'empty' }

  const res = await fetch(`${ENGINE_URL}/odds/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-auth-token': AUTH_TOKEN,
    },
    body: JSON.stringify({ sportKey, events, mode, source }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`engine ingest HTTP ${res.status}: ${text.slice(0, 120)}`)
  }

  return res.json()
}

// Fetch the current featured/hot match list from the engine.
// Returns array of { eventId, sportKey, home, away, startTime }.
async function fetchHotMatches() {
  const res = await fetch(`${ENGINE_URL}/featured/matches`, {
    headers: { 'x-auth-token': AUTH_TOKEN },
  })
  if (!res.ok) return []
  const data = await res.json().catch(() => [])
  return Array.isArray(data) ? data : []
}

module.exports = { pushIngest, fetchHotMatches }
