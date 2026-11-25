# Resolver — Cloud Drive Integration Plan

## Baidu Pan (百度网盘)
**Challenge:** Baidu uses multiple layers of anti-scraping, download speed limits for non-SVIP users, and frequently changes their API.

**Approach (multi-fallback):**
1. **Primary:** Headless browser → navigate share link → enter password → extract file list
2. **Fallback 1:** BaiduPCS-Py API (if session available)
3. **Fallback 2:** aria2 + extracted direct links
4. **Fallback 3:** Show error with manual instructions

**Flow:**
1. User pastes `pan.baidu.com/s/xxx?pwd=xxxx`
2. Resolver detects → shows "Baidu Pan" with loading spinner
3. Headless browser navigates to link, enters password
4. Extracts file/folder tree → shows as file browser UI
5. User selects files/folders
6. If multiple: zip option available
7. Download selected → server downloads via extracted links
8. Speed limit note: non-SVIP Baidu limits to ~100KB/s per file

**GitHub tools to integrate:**
- syhyz1990/baiduyun — browser extension approach (most reliable for link extraction)
- lihaoyun6/ax-baiduyunpan — direct download acceleration
- Balder1840/BaiduPanDownload — .NET download manager logic
- yutaoxie/baiduyun — Python implementation

**Key insight:** Most tools need either:
- A logged-in Baidu account (even free tier works for downloading shared files)
- OR: crack the share link's download URL (changes frequently, breaks often)

**Recommendation:** Create a Baidu account, keep session alive via headless browser, use it for all shared link downloads.

---

## Google Drive
**Approach:** yt-dlp handles public files natively. For folders/multiple files:
1. Detect if link is file or folder
2. File: direct download via yt-dlp or API
3. Folder: list files via Google Drive API (no auth needed for public), show file browser, download selected

**Flow:**
1. Paste `drive.google.com/file/d/xxx` or `drive.google.com/drive/folders/xxx`
2. If file: detect name/size → show download button
3. If folder: list contents → file browser UI → select → download (zip if multiple)

---

## Dropbox
**Approach:** Convert share URL to direct download URL (replace dl=0 with dl=1)
1. Single file: direct download
2. Folder: Dropbox API lists contents → file browser → select → download

---

## Shared UI: Cloud Drive File Browser
All three services need a file/folder selector UI:
- Tree view with folders expandable
- File list with checkboxes
- File size + type shown
- "Download selected" button
- "Download as ZIP" toggle for multiple files
- Show total size estimate before download

---

## Status: PLANNED — needs dedicated session
Priority order:
1. Google Drive (simplest, yt-dlp does most work)
2. Dropbox (URL conversion is trivial)
3. Baidu Pan (most complex, needs Baidu account + headless browser)
