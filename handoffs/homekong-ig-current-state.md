# IG Resolver — Current State & Next Steps

## What Works Now
- **Highlights via API** (proxy + fresh cookies) — selenagomez, nike confirmed
- **gallery-dl with proxy** — highlights listing works, posts/feed returns 400 (account too new)
- **Headless browser WITHOUT proxy** — can load IG pages, login, grab cookies from home IP
- **Cookie rotation** — picks random from account_brian.txt / account_kenneth.txt (both SUSPENDED though)

## What's Broken
- **zh.pro proxy IP is burned for IG page loads** — Instagram returns empty HTML
- **zh.pro IG accounts (brian/kenneth) are SUSPENDED** — new accounts get instant-banned
- **alt0ut2i** — rate-limited on API but still alive on mobile
- **Posts/feed API** — returns 400 from new accounts (need aged account)

## Architecture Decision (for next session)

### Option A: Cookie from Phone (quickest)
1. Export cookies from alt0ut2i on your phone
2. Use those cookies with the proxy for API calls (this DID work)
3. Gallery-dl + proxy + aged cookies = full access

### Option B: Different Proxy Provider
- zh.pro's "dedicated" IP is pre-burned for IG automation
- Need a provider with truly clean residential IPs (BrightData, Oxylabs, SmartProxy)
- More expensive ($50-100/month) but actually clean

### Option C: Stealth Playwright
- Use `playwright-extra` + `puppeteer-extra-plugin-stealth`
- Patches headless detection (navigator.webdriver, chrome.runtime, etc.)
- Still needs clean IP (home IP or better proxy)

### Recommended: Option A now, Option C later
- Get fresh cookies from phone → immediate fix
- Build stealth browser for long-term cookie refresh automation

## Files Modified This Session
- `/home/dockeradmin/services/media-app/browser-server.js` — proxy config (reverted to no-proxy-at-launch), /ig-scrape endpoint added
- `/home/dockeradmin/services/media-app/resolver-server.js` — cookie rotation, proxy API calls, browser fallback
- `/home/dockeradmin/services/media-app/gallery-dl.conf` — proxy under instagram section
- `/home/dockeradmin/services/docker-compose.yml` — volumes for cookies + gallery-dl.conf + browser-server.js
- `/home/dockeradmin/services/media-app/Dockerfile.resolver` — gallery-dl + https-proxy-agent

## Proxy Details (still valid for API/gallery-dl, just not for page loads)
- `http://USER:CHANGE_ME@PROXY_HOST:63030`
- `http://USER:CHANGE_ME@PROXY_HOST:63031`
