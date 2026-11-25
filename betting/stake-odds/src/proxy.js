// proxy.js — Thordata residential proxy gateway
// Rotating session: no sessid = fresh residential IP per browser launch (CF bypass)
// Docs: (proxy provider docs)

const THORDATA_HOST = process.env.THORDATA_HOST
const THORDATA_USER = process.env.THORDATA_USER
const THORDATA_PASS = process.env.THORDATA_PASS

if (!THORDATA_HOST || !THORDATA_USER || !THORDATA_PASS) {
  throw new Error('[proxy] THORDATA_HOST, THORDATA_USER and THORDATA_PASS must be set')
}

// Returns { server, username, password } for Playwright's proxy option.
// No sessid = rotating: each browser launch gets a fresh residential IP.
async function freshProxyConfig() {
  return {
    server:   `http://${THORDATA_HOST}:9999`,
    username: THORDATA_USER,
    password: THORDATA_PASS,
  }
}

module.exports = { freshProxyConfig }
