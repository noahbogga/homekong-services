# HOMEKONG Services

The web and backend services behind **HOMEKONG**, a Hong Kong-themed GTA V roleplay server on FiveM. Everything outside the game itself lived here: the public website, a shared file manager, admin dashboards, an in-game sportsbook and casino with real odds, and the AI that powered NPC conversations.

The server has shut down and this code is no longer maintained. It's shared as-is so anyone can learn from it, reuse parts of it, or build on it. The in-game scripts that talk to these services are in [**homekong-fivem**](https://github.com/noahbogga/homekong-fivem).

> ⚠️ **All credentials have been removed.** API keys, passwords, tokens, private keys and logins were replaced with placeholders (`CHANGE_ME`, `PROXY_HOST`, empty files). Nothing will run until you add your own. That's on purpose.

## What's inside

### 🌐 Websites (`sites/`)
- **The main HOMEKONG site:** a static brand site with a photo gallery of in-game locations.
- **A FiveM landing page:** a simple "join the server" page.

### 📁 Media file manager (`media/`)
A shared file manager for the community, built around [filebrowser](https://github.com/filebrowser/filebrowser), with extras:
- **Big uploads:** files over Cloudflare's 200 MB limit are sent in chunks and put back together.
- **Link resolver:** paste a YouTube, Instagram or website link and it downloads the media into your files, using gallery-dl / yt-dlp and a headless browser.
- **Search:** instant file-name search, content search, and AI image generation and editing.
- **Share links**, **SFTP/WebDAV** access through SFTPGo, and an upload relay that lets the in-game phone camera save photos to [Zipline](https://github.com/diced/zipline).

### 🔐 Admin tools (`admin/`)
- **tx-gate:** a login page with two-factor auth (TOTP) that protects the server panels, shows server status and can restart services.
- **Remote desktop in the browser:** [Apache Guacamole](https://guacamole.apache.org/) behind its own login and 2FA gate, with a dashboard.
- Branded pages in front of FiveM's txAdmin panel.

### 🎲 Sportsbook & casino (`betting/`)
The backend for **"Steak"**, the in-game betting app:
- **Odds engine (Node):** pulls real sports odds, derives extra markets, uses an AI model to adjust lines, takes bets and settles them automatically.
- **Casino games:** dice, mines, crash, blackjack and mahjong, all "provably fair".
- A player web app (PWA) and an admin panel.
- **Odds collectors:** a scraper that reads odds from Stake, and a Python crawler for football data.
- A MariaDB database for bets and game history.

### 🤖 AI for the game (`fivem-ai/`)
- **NPC dialog gateway:** NPCs in the game get AI-written lines. The gateway caches answers, queues requests, forces valid JSON with a grammar, and falls back to canned lines when the model is busy.
- A small AI API the game scripts call for answers.
- The setup for the two local language models (odds adjustment and NPC dialog) that ran on a separate GPU machine.

### 🚪 Edge (`edge/`)
How it was reached from the internet: a Cloudflare tunnel, nginx in front of everything, a dynamic-DNS script, and a CDN sync script.

### 📝 Build notes (`handoffs/`)
The planning and handoff documents written while building all of this (odds AI, file manager, Instagram downloader, proxy and drive setup, and more). Useful if you want to know *why* something was built the way it was.

## Running it yourself
You'll need Docker and Docker Compose on a Linux machine. Roughly:
1. Fill in your own credentials. Find every placeholder with `grep -rn "CHANGE_ME\|PROXY_HOST\|YOUR_" .` and see the **Setup** section in each folder's README.
2. Start the database (`betting/zx-db`), then the main stack (`docker compose up -d` in the root), then Guacamole (`admin/guacamole`), then the odds engine (`betting/hk-odds-engine`) and the football crawler (`betting/zq-football`).
3. Replace the original server's hostnames and internal addresses in the configs with your own.

This was built for one specific server, so expect to adapt things rather than run it unchanged.

## Built with
Node.js, Python (FastAPI), Docker Compose, nginx, MariaDB, Postgres, Redis, Playwright, [filebrowser](https://github.com/filebrowser/filebrowser), [Zipline](https://github.com/diced/zipline), [SFTPGo](https://github.com/drakkan/sftpgo), [Apache Guacamole](https://guacamole.apache.org/), [Uptime Kuma](https://github.com/louislam/uptime-kuma), [gallery-dl](https://github.com/mikf/gallery-dl), [llama.cpp](https://github.com/ggml-org/llama.cpp).

## Licence
Copyright (C) 2026 [**noahbogga**](https://github.com/noahbogga). Licensed under the **GNU General Public License v3.0**; see [`LICENSE`](LICENSE).

You're free to use, change and share this, including commercially, as long as you **credit noahbogga**, keep the licence notice, and release your changed versions under GPL-3.0 with their source. The third-party tools listed above keep their own licences.

## Security
This repository contains no real credentials. If you spot one, please open an issue.
