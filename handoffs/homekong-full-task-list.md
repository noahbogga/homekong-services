# HOMEKONG — Full Task List (All Pending + New)
## Updated: 2026-06-26

---

## 🔴 HIGH PRIORITY (Do Now)

### Quick Wins
- [x] Arrow key (←/→) navigation in media viewer (photo/video) ✅ Fixed + added position counter
- [x] Swipe left/right on mobile for media viewer navigation ✅ Already existed, verified working
- [x] Loading spinners/animations across all loading states (resolver, search, file list, Aether) ✅ CSS spinner + replaced text
- [x] Highlight tab: grid view with round thumbnails + title below (Instagram-style circles) ✅ Gradient ring + hover scale
- [x] Highlight tab: load ALL highlights at once (Layer 1 is instant via API anyway) ✅ Already loading all
- [x] Highlight items view: split top (photos) / bottom (videos) layout ✅ _igRenderHighlightSplit
- [x] Preview + select on all IG tabs (click = preview overlay, checkbox = select) ✅ Checkbox in corner
- [x] homekong.online 403 fix (origin returning 403) ✅ Stale www A records → CNAME to tunnel

---

## 🟡 MEDIUM PRIORITY (This Week)

### Resolver/Fetch
- [ ] Two-layer split for Posts (Layer 1 = thumbnails, Layer 2 = fetch on select)
- [ ] Two-layer split for Reels (same pattern)
- [ ] Download limits: 10 posts max, 3 reels max, all stories, 10 per highlight batch
- [ ] Download progress bar per item (% + error codes)
- [ ] Progressive thumbnail loading (low-res first, then full quality)
- [ ] Folder naming: ig_username_type_date/ structure
- [ ] Stories: detect photo vs video correctly
- [ ] Auto-detect still image with IG music overlay (give option to save as image)
- [ ] Post grouping: show carousel count badge, click to expand carousel items
- [ ] Batch mode: "Fetch all same settings" should show progress per link

### File Manager UI
- [x] Glass/acrylic style on ALL modals ✅ Already done (backdrop-blur-xl + rgba bg)
- [x] Mobile drag-drop support ✅ Long-press enters multi-select, touch drag implemented
- [x] Lasso select on long-hold (space key hold on desktop) ✅ Desktop lasso + mobile long-press both done
- [x] Video player: resolution selector, playback speed control ✅ Plyr.io (0.5x-2x, keyboard shortcuts)
- [x] Video player: simple clip function (start → end → export) ✅ ffmpeg stream-copy, no re-encode
- [x] Better media player (video.js or plyr.io) ✅ Plyr.io integrated with gold theme
- [x] Right-click menu: add "Resize/Convert" option ✅ Modal with format/resize/quality
- [x] Right-click menu as dedicated button on mobile action bar ✅ "⋯ More" button added
- [x] Status bar: across sidebar (full width) ✅ DONE

### Search
- [ ] AI search: Haiku analyzes intent before searching
- [x] VS Code-style "Find in folder" with line-by-line results ✅ /grep endpoint + grouped results
- [x] Chinese character search improvement (in-text grep encoding) ✅ grep -F + LC_ALL=C.UTF-8

---

## 🟢 PLANNED (Future Sessions)

### File Conversion/Resize Service
- [x] Docker container: ffmpeg + ImageMagick + zip ✅ ffmpeg in resolver, CF edge for images
- [x] Resize images (width/height/percentage) ✅ Convert modal + CF Image Transforms
- [x] Compress file size (quality slider) ✅ Quality slider in convert modal
- [x] Change video format (mp4/webm/mkv/avi) ✅ ffmpeg backend
- [x] Change image format (png/jpg/webp/avif) ✅ CF edge + ffmpeg fallback
- [x] Change audio format (mp3/wav/flac/ogg/m4a) ✅ ffmpeg backend
- [x] Pack into zip ✅ Right-click "Pack as ZIP" via filebrowser API
- [x] Right-click "Convert/Resize" menu option ✅ Done
- [ ] Resolver post-download conversion

### VirusTotal Integration
- [x] Right-click "Scan for viruses" ✅ Context menu option
- [x] Upload file hash to VirusTotal API ✅ SHA-256 computed client-side, sent to /virustotal endpoint
- [x] Show results popup (clean/threats) ✅ Color-coded results with engine details
- [ ] Add VT_API_KEY env var to resolver for live lookups (currently shows permalink only)

### VPS Service Mode / Failover
- [x] Backend on VPS (103.231.59.28) ✅ nginx:8084 with maintenance page
- [x] Custom error page when hk-services is down ✅ Branded page with auto-reload
- [x] Cloudflare routes to VPS on failure ✅ Cron every 30s, DNS swap via CF API

### Terminal Admin Panel (terminal.homekong.cc)
- [ ] Claude Opus chat interface
- [ ] Server control (VM, Docker, services)
- [ ] Multi-tab interface
- [ ] Zero Trust auth via Cloudflare Access
- [ ] File system access with confirmation gates

### Headless Browser IG Approach
- [ ] Mimic real scroll/click behavior
- [ ] More generic than API (survives changes)
- [ ] Can verify counts by observing page
- [ ] Human-like delays built in
- [ ] 2captcha integration for challenges

### Instagram Advanced
- [ ] Multi-account cookie rotation
- [ ] Cookie auto-refresh via headless browser
- [ ] Profile info: bio, follower/following count, post count, links
- [ ] Previous aliases/usernames detection
- [ ] Auto-post random content to keep account active (via proxy only)
- [ ] Sort: newest/oldest for all categories

### Aether AI
- [ ] File edit with confirmation prompts
- [ ] Knowledge base auto-update system
- [ ] Settings panel for knowledge import
- [ ] Image mode from within chat (generate/edit)
- [ ] Context-aware: knows what file you're viewing

### Storage/Backup
- [ ] Execute after hardware upgrade arrives
- [ ] See: Desktop\HOMEKONG_Storage_Backup_Plan.md
- [ ] NVMe + 3x SSD + 2x HDD layout
- [ ] bcache SSD caching for HDD
- [ ] Automated backup schedule

### Domains/Infrastructure
- [ ] fivem.ahr.ccwu.cc — game launcher CDN/auth
- [ ] cdn.ahr.ccwu.cc — asset delivery
- [ ] Aether public interface on aether.xxx
- [ ] R2 bucket setup for CDN storage
- [ ] Cloudflare Images setup for thumbnail proxy

---

## ✅ COMPLETED (This Session)
- [x] Instagram cookies working (phone export)
- [x] Cloudflare Worker proxy (fetch-proxy) deployed
- [x] All domains migrated to Business CF account
- [x] New tunnel created and working
- [x] Headless browser service deployed
- [x] Two-layer highlights (Layer 1 = API instant list, Layer 2 = gallery-dl fetch)
- [x] URL cleaning (strip tracking params)
- [x] gallery-dl human-like delays configured
- [x] Cache busting on all JS files
- [x] Personal storage on separate 100GB disk
- [x] Sidebar: Personal folder at top
- [x] Status bar click to refresh
- [x] Cut items show transparent (like Windows Explorer)
- [x] Path copy on right-click/double-click breadcrumb
- [x] Custom right-click context menu
- [x] Resolver: batch mode, audio formats, quality presets
- [x] Aether: streaming chat, file search, deep think mode
- [x] Image editor: AI generation (Aether/GPT)
- [x] Search: Spotlight-style, AI mode, in-text, Chinese support
