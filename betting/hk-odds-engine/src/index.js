const express = require('express')
const path = require('path')
const cron = require('node-cron')
const { initDB } = require('./db')
const { startOddsCron } = require('./crons/odds')
const { startSettlementCron } = require('./crons/settlement')
const { refreshFeatured } = require('./featured')
const oddsRouter = require('./routes/odds')
const betsRouter = require('./routes/bets')
const fairRouter = require('./routes/fair')
const playersRouter = require('./routes/players')
const casinoRouter = require('./routes/casino')
const blackjackRouter = require('./routes/blackjack')
const mahjongRouter = require('./routes/mahjong')
const steakRouter = require('./routes/steak')
const featuredRouter = require('./routes/featured')
const ingestRouter = require('./routes/ingest')
const adminRouter = require('./routes/admin')
const mobileRouter = require('./routes/mobile')

const app = express()
app.use(express.json())

const AUTH_SECRET = process.env.AUTH_SECRET || 'CHANGE_ME'

// ── Casino Admin panel ────────────────────────────────────────────
// Mounted BEFORE the internal x-auth-token gate. Everything the panel needs
// lives under /casino-admin/* — deliberately distinct from the casino GAME
// API at /casino/* (dice/mines/crash, hit by the FiveM resource) so the static
// mount + SPA fallback never shadow those game routes.
//   /casino-admin/api  → admin API (own x-admin-token auth, see routes/admin.js)
//   /casino-admin/*    → browser UI (static assets + SPA shell fallback)
// tx.homekong.cc proxies a single `location ^~ /casino-admin/` block to :4200
// behind the tx-gate cookie auth — no path rewrite (engine base == frontend base).
const ADMIN_UI_DIR = path.join(__dirname, '..', 'admin-ui')

app.use('/casino-admin/api', adminRouter)
app.use('/casino-admin', express.static(ADMIN_UI_DIR))
// SPA fallback: any /casino-admin/* deep link returns the app shell (react-router
// handles routing client-side). Excludes /casino-admin/api (the JSON API) and
// /casino-admin/assets (real static files handled by express.static above).
app.get(/^\/casino-admin(\/(?!api\/).*)?$/, (req, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'))
})

// Back-compat: keep the old /admin API mount alive for any internal caller
// hitting :4200/admin directly with x-admin-token. The old /panel UI mount is
// gone — its assets now live under /casino-admin, so a stale bookmark 404s
// cleanly rather than serving a broken shell.
app.use('/admin', adminRouter)

// ── Mobile / web mirror ───────────────────────────────────────────
// Mounted BEFORE the internal x-auth-token gate: browser sessions authenticate
// with a Bearer session token (see routes/mobile.js), and the relay-facing
// sub-routes there enforce x-auth-token themselves. play.homekong.cc proxies
// /mobile/* (API) + the static web build to :4200.
app.use('/mobile', mobileRouter)

// Static web build (the mobile/PWA mirror of the in-game NUI). Same React app
// as the FiveM resource, built for the web target into ../web-ui. Served under
// /play; SPA deep links fall back to the app shell. play.homekong.cc proxies
// / and /play/* here. Mounted before the x-auth-token gate (browser auth is the
// Bearer session on /mobile/*, not the internal secret).
const WEB_UI_DIR = path.join(__dirname, '..', 'web-ui')
app.use('/play', express.static(WEB_UI_DIR, {
  // Hashed assets (assets/index.<hash>.js|css) are content-addressed -> cache hard.
  // Everything else (index.html, manifest) must revalidate so new deploys land
  // immediately instead of serving a stale shell that points at old bundles.
  setHeaders(res, filePath) {
    if (/[.-][A-Za-z0-9_]{8,}\.(js|css)$/.test(filePath) || filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('Cache-Control', 'no-cache')
    }
  },
}))
app.get(/^\/play(\/.*)?$/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(WEB_UI_DIR, 'index.html'))
})
// Bare domain -> the app. Only the exact root, so internal API callers that hit
// specific paths (/odds, /bets, ...) still fall through to the auth gate below.
app.get('/', (req, res) => res.redirect(302, '/play/'))

app.use((req, res, next) => {
  if (req.path === '/health') return next()
  const token = req.headers['x-auth-token']
  if (token !== AUTH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
})

app.use('/odds', oddsRouter)
app.use('/bets', betsRouter)
app.use('/fair', fairRouter)
app.use('/players', playersRouter)
app.use('/casino', casinoRouter)
app.use('/blackjack', blackjackRouter)
app.use('/mahjong', mahjongRouter)
app.use('/steak', steakRouter)
app.use('/featured', featuredRouter)
app.use('/odds/ingest', ingestRouter)

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }))

const PORT = process.env.PORT || 4200

async function main() {
  await initDB()
  startOddsCron()
  startSettlementCron()

  // Featured matches: full daily re-pick at 06:10, plus a light refresh every 30min so
  // live matches float in/out. Both guarded so a failure never takes down the engine.
  cron.schedule('10 6 * * *', () => { refreshFeatured().catch(e => console.error('[featured] daily:', e.message)) })
  cron.schedule('*/30 * * * *', () => { refreshFeatured().catch(e => console.error('[featured] refresh:', e.message)) })
  // once shortly after startup (after the ZQ ingest has had a chance to populate cache)
  setTimeout(() => { refreshFeatured().catch(e => console.error('[featured] startup:', e.message)) }, 45000)

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[hk-odds-engine] listening on :${PORT}`)
  })
}

main().catch(err => {
  console.error('[hk-odds-engine] Fatal:', err)
  process.exit(1)
})
