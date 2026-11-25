// proxy.js — optional outbound proxy for engine API calls (enrich, AI, etc.)
// If PROXY_HOST is not set, falls back to direct fetch — no proxy needed for
// the football data API or the internal AI endpoint on .209.

const PROXY_HOST = process.env.PROXY_HOST
const PROXY_PORT = process.env.PROXY_PORT
const PROXY_USER = process.env.PROXY_USER
const PROXY_PASS = process.env.PROXY_PASS

let agent = null
if (PROXY_HOST && PROXY_PORT) {
  const { HttpsProxyAgent } = require('https-proxy-agent')
  const auth = PROXY_USER ? `${PROXY_USER}:${PROXY_PASS}@` : ''
  agent = new HttpsProxyAgent(`http://${auth}${PROXY_HOST}:${PROXY_PORT}`)
  console.log(`[proxy] using outbound proxy ${PROXY_HOST}:${PROXY_PORT}`)
} else {
  console.log('[proxy] no PROXY_HOST set — using direct fetch')
}

async function proxyFetch(url, opts = {}) {
  const fetch = (await import('node-fetch')).default
  return agent ? fetch(url, { ...opts, agent }) : fetch(url, opts)
}

module.exports = { proxyFetch }
