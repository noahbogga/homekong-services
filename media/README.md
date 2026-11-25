# media

A shared file manager for the community, built around [filebrowser](https://github.com/filebrowser/filebrowser) with a custom web UI and several helper services. All of them use the same storage folder, so a file uploaded or downloaded anywhere shows up in the file manager straight away.

| Path | What it is |
|---|---|
| `media-app/` (UI) | The file manager front end: upload, preview, edit, drag & drop, and a link-resolver panel. |
| `media-app/upload-server.js` | Large-file uploads. Files bigger than Cloudflare's 200 MB request limit are sent in 64 MB chunks and reassembled. Logins reuse filebrowser's own session. |
| `media-app/direct-upload.js` | An upload endpoint that skips Cloudflare, for trusted users only. |
| `media-app/resolver-server.js`, `resolver.js`, `gallery-dl.conf` | The link resolver: paste a YouTube, Instagram or website link, pick a format, and it downloads the media into your files with gallery-dl or yt-dlp. Instagram downloads go through a residential proxy and rotate between logged-in accounts. |
| `media-app/browser-server.js` | A headless Chrome (Playwright) service the resolver uses for Instagram pages, plus web search through the Brave API. |
| `media-app/search-server.js`, `search-service/` | Search: an instant file-name index (rebuilt every minute) and content search, plus AI image generation and editing jobs. |
| `media-app/cfg-editor.js` | A direct editor for `.cfg` files, working around a filebrowser restriction. |
| `share-service/` | Public share links: view a file inline, or add `?dl=1` to download. |
| `phone-upload/` | Lets the in-game phone camera save photos: it takes the image as base64 (FiveM's HTTP can't send raw binary) and re-uploads it to [Zipline](https://github.com/diced/zipline). |
| `filebrowser/` | filebrowser settings and HOMEKONG branding (CSS, logos, login page). |
| `sftpgo/` | Where [SFTPGo](https://github.com/drakkan/sftpgo)'s host keys and WebDAV certificate go, for SFTP and WebDAV access to the same files. |

## Setup
- `media-app/cookies/`: export your own Instagram session cookies (Netscape format) and list the accounts in `accounts.json`; put your proxy in `proxy_url.txt`.
- `media-app/browser-server.js`, `resolver-server.js`, `gallery-dl.conf`: your residential proxy (`PROXY_HOST`, user, password), search API host and key (`YOUR_SEARCH_API_HOST`), and Cloudflare AI Search details.
- `media-app/search-server.js`, `search-service/server.js`: an OpenAI-compatible API host (`YOUR_AI_API_HOST`) and key for AI image and chat jobs.
- `sftpgo/`: SFTPGo creates host keys on first start (delete the placeholders); add your WebDAV certificate.
- The root `docker-compose.yml`: `CORE_SECRET` and the Zipline database password.
