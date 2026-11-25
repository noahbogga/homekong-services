# betting

The backend for **"Steak"**, the in-game sportsbook and casino (the game-side script is `hk-sportsbetting` in [homekong-fivem](https://github.com/noahbogga/homekong-fivem)). Players could bet in game or from a phone web app.

| Path | What it is |
|---|---|
| `hk-odds-engine/` | The core service (Node). It pulls real sports odds and caches them, derives extra markets, runs an Asian-handicap model, lets an AI model nudge the lines, takes bets, and settles them on a schedule. It also hosts the casino games (dice, mines, crash, blackjack, mahjong), which use provably-fair seeds. `web-ui/` is the player web app (PWA) and `admin-ui/` is the casino admin panel. |
| `stake-odds/` | A Playwright scraper that reads odds from Stake's list and match pages and sends them to the engine. |
| `zq-football/` | A Python (FastAPI) crawler with a scheduler and Redis cache for football leagues, matches and odds. Chinese API docs and a Linux deploy guide are included. |
| `zx-db/` | MariaDB for bets, casino history and VIP data. |

## Setup
- `hk-odds-engine/docker-compose.yml`: database password, auth/admin/cash secrets, two Discord webhooks, and proxy login (all `CHANGE_ME`).
- `hk-odds-engine/data/api-keys.json` (or the defaults in `src/keys.js`): your odds API and SharpAPI keys, and set the API hosts (`YOUR_ODDS_API_HOST`, `YOUR_SHARPAPI_HOST`, `YOUR_FOOTBALL_DATA_HOST`) in `src/`.
- `hk-odds-engine/data/ai-token.txt`, `zq-token.txt`: tokens for the odds AI model and the football API.
- `hk-odds-engine/stake-odds-src/proxy.js`: your proxy provider API URL and key (`YOUR_PROXY_PROVIDER_API`).
- `zq-football/.env`: API keys and proxy login; set the source site (`YOUR_FOOTBALL_SOURCE_HOST`) in `scripts/`. `zx-db/.env`: database passwords.
