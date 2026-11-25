# HOMEKONG — Residential Proxy Setup & Usage

## Proxy Details
- **Host:** PROXY_HOST
- **Port 1:** 63030 | **Port 2:** 63031
- **User:** CHANGE_ME | **Pass:** CHANGE_ME
- **Type:** Dedicated IPv4, US residential, 1 year (from 2026-06-26)
- **Format:** `http://USER:CHANGE_ME@PROXY_HOST:63030`

## Currently Wired Into
- ✅ gallery-dl (all IG fetches) — `/home/dockeradmin/services/media-app/gallery-dl.conf`
- ✅ Resolver server direct API calls (highlights tray, profile info) — `getProxyAgent()` in resolver-server.js
- ✅ Cookie rotation between 3 accounts (brian/kenneth/alt0ut2i)

## TODO — Wire Into
- [ ] Headless browser (Playwright `--proxy-server` launch arg in browser-server.js)
- [ ] yt-dlp downloads (add `--proxy` to resolver YouTube path)
- [ ] Aether web search if added later

## Other Uses for US Residential Proxy
- US-only content/geo-locked pages
- YouTube US-restricted videos (yt-dlp `--proxy`)
- Google search with US results (for AI/Aether)
- Price comparison (US pricing)
- Any social scraping (TikTok, Twitter, Reddit via gallery-dl)
- AI API access if HK gets geo-restricted

## FiveM Server — What Proxy Could Help With
Honestly not much for FiveM specifically. The proxy is overkill for cfx.re APIs.

### Better FiveM Protection (no proxy needed):
- **DDoS protection** — already handled by Cloudflare tunnel + WireGuard VPS relay hiding home IP
- **Anti-cheat** — server-side resource protection (encrypted scripts, server-only logic)
- **IP hiding from players** — VPS relay already does this (players connect to 103.231.59.28, not home IP)
- **Brute force on txAdmin** — rate limiting on tx.homekong.cc (nginx config)
- **Resource leak prevention** — escrow/obfuscate paid scripts, keep logic server-side
- **Player data protection** — MariaDB on hk-fxmain VM only, not exposed externally
- **Backup automation** — scheduled snapshots of hk-fxmain VM + DB dumps

### If you wanted proxy for FiveM:
- Could route txAdmin web panel through proxy as extra layer (overkill)
- Could use for anonymous cfx.re forum/API interactions (unlikely needed)

## IG Account Credentials (for cookie refresh)
| Account | Password | 2FA Secret |
|---------|----------|------------|
| BrianClark0465814 | AO309DbabFfVC | Y2LI2VJL55J4AIJRYN6LS2UBGB6XBYLG |
| KennethKing4323243 | 6ngHhBXvX | IA45GGND2LF2MTH6BILYZ2BRAVXP7AJ5 |
| alt0ut2i | 25493787ookk | (no 2FA, burned) |

## Cookie Refresh Procedure
1. Create browser session: `POST /session` to browser-service:3004
2. Navigate to `https://www.instagram.com/accounts/login/`
3. Dismiss cookie banner via JS evaluate
4. Fill `input[name=email]` + `input[name=pass]` via native setter
5. Submit, wait for 2FA page
6. Generate TOTP from secret, fill `input[type=text]`, submit
7. Wait for onetap page (success), skip "Save Login"
8. GET `/cookies/:sessionId` → convert to Netscape format → save to `/app/cookies/account_*.txt`
