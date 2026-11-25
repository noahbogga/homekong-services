# HOMEKONG — IG Resolver Rewrite Plan (Headless Browser Scraping)

## Problem
- zh.pro accounts get instantly suspended (mass-created, flagged)
- gallery-dl feed API returns 400 for new accounts
- Need a login-free approach for public profiles

## Solution: Headless Browser + Proxy (No Login)
Scrape public IG profiles via headless browser routed through residential proxy. No accounts needed.

## Architecture

### Browser Service Changes
- Add proxy support: `chromium.launch({ proxy: { server: 'http://PROXY_HOST:63030', username: 'PROXY_USER', password: 'CHANGE_ME' } })`
- Multiple isolated contexts (already supported — each session is a separate BrowserContext)
- Session hash naming with logs
- Auto-cleanup after timeout

### New IG Scraping Endpoints (in resolver-server.js)

#### `POST /ig-list` (rewrite)
Instead of gallery-dl:
1. Create browser session with proxy
2. Navigate to `instagram.com/<username>/`
3. Extract `window.__additionalData` or intercept GraphQL responses
4. For posts: scroll to load thumbnails, extract from DOM
5. For highlights: extract from `__NEXT_DATA__` or tray visible in DOM
6. Return structured JSON same format as before

### Data Extraction Methods

**Profile + Posts (public):**
```
page.goto('https://instagram.com/nike/')
page.evaluate(() => {
  // Posts are in <article> elements with img tags
  // Or intercept: page.route('**/graphql/query*', ...)
})
```

**Highlights (public):**
- Visible in profile page DOM as circular thumbnails
- Click each → stories viewer opens → extract media URLs from DOM

**Stories (public figures only):**
- Navigate to stories URL → media visible in DOM

### Session Management
- Hash-named sessions: `ig_<sha256(username+timestamp)[:8]>`
- Log file per session: `/app/logs/ig_<hash>.log`
- Max concurrent: 5 browser contexts
- Auto-close after 60s idle
- Each request gets fresh context (no cookie contamination)

### Proxy Integration
- All browser contexts launch with residential proxy
- Rotate between port 63030 and 63031
- No cookies/login needed for public profiles

### Fallback Chain
1. Try headless browser scraping (no login)
2. If private profile → return error "Profile is private"
3. Never use gallery-dl or API with login (burned approach)

## Files to Modify
- `/home/dockeradmin/services/media-app/browser-server.js` — add proxy to launch, add IG-specific scraping endpoints
- `/home/dockeradmin/services/media-app/resolver-server.js` — replace gallery-dl ig-list with calls to browser service
- `/home/dockeradmin/services/media-app/Dockerfile.browser` — no changes needed

## Proxy Details
- Host: PROXY_HOST
- Port 1: 63030 | Port 2: 63031  
- User: PROXY_USER | Pass: CHANGE_ME

## Current Account Status (all burned)
- BrianClark0465814 — SUSPENDED
- KennethKing4323243 — SUSPENDED
- alt0ut2i — rate-limited/burned
