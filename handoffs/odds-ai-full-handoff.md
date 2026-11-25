# AI Odds System — Full Handoff (Model + Integration)

**Date:** 2026-07-25
**Scope:** The complete local-AI odds pipeline — the model service on **AetherMem .209** and its
consumer, **hk-odds-engine on .247**. This is the single source of truth; supersedes the two
separate handoffs (`ODDS_MODEL_HANDOFF.md`, `HK_ODDS_AI_INTEGRATION_HANDOFF.md`).

**Status:** ✅ Both sides built, deployed, verified end-to-end. Live but **dormant** until events
carry form/injury data (by design — see §6).

---

## 0. THE WHOLE PIPELINE IN ONE PICTURE

```
hk-odds-engine (.247, HOMEKONG)                    AetherMem .209 (Aether, Tesla V100)
┌──────────────────────────────┐                  ┌────────────────────────────────────┐
│ cron ai-adjust @ :15/:45      │                  │ aether-odds-control  :8091 (Bearer)  │
│  for each cached match with   │  POST {input}    │   ├─ injects prompt + JSON schema    │
│  form/injury evidence ────────┼─────────────────►│   └─ proxies to ▼                    │
│                               │  Bearer token    │ aether-odds  :8081 (llama-server)    │
│  ◄── shift judgment (JSON) ───┼──────────────────┤   Qwen2.5-7B, GPU, grammar-locked    │
│  apply shift to h2h/totals    │                  └────────────────────────────────────┘
│  (preserve overround)         │
│  anchor it so drift keeps it  │   Other Aether services on .209 (UNTOUCHED):
│  write back to cache          │   aether-verifier :8080, qdrant, embedder :8090
└──────────────────────────────┘
```

Model returns **direction + magnitude of a probability shift**, NOT final prices. The .247 side
does the exact price math. This split is deliberate: a 7B is reliable at judgment, not arithmetic.

---

## 1. MODEL SIDE — what runs on .209

- **Model:** Qwen2.5-7B-Instruct (Q4_K_M GGUF). Chosen over Llama-3.1-8B for numeric reasoning +
  structured output. ~1.4s/match, deterministic at temp 0.1.
- **Server:** llama.cpp `llama-server`, GPU (V100), ctx 8192, 2 parallel slots, `--props` on.
- **Two systemd services** (auto-start on boot, GPU-wait + VRAM-claim guard so they never silently
  fall back to CPU):
  - `aether-odds.service` → llama-server on **:8081** (OpenAI-compatible, no auth, LAN only)
  - `aether-odds-control.service` → scoped control API on **:8091** (Bearer-authed)
- **Files:** `/home/dockeradmin/services/odds/` (config.json, system_prompt.txt, schema.json,
  control_api.py, odds-launch.sh, odds-healthcheck.sh, token)
- **Isolation:** touches ONLY the odds model. Aether's verifier/Qdrant/embedder share the box but
  are never affected. VRAM: verifier 17.7G + embedder 0.4G + odds 5.1G = ~23/32G (~9G free).
  Note: isolation is enforced in the control-API **code** (software boundary), not the OS.

## 2. ENDPOINTS & AUTH

- **Inference (recommended):** `POST http://192.168.50.208.../v1/chat/completions` → actually
  **`http://192.168.50.209:8091/v1/chat/completions`** (control API proxy — auto-injects the tuned
  prompt, the grammar-locked schema, and defaults temp 0.1 / seed 42). Send just `{"input":"<match text>"}`.
- **Inference (raw):** `http://192.168.50.209:8081/v1/chat/completions` (no auth; you supply prompt
  + `response_format` yourself).
- **Auth (for :8091 only):** `Authorization: Bearer CHANGE_ME`
  Stored on .247 at `data/ai-token.txt` (chmod 600, in mounted volume). Also readable on .209 at
  `/home/dockeradmin/services/odds/token`.

## 3. MODEL CONTROL API (:8091, all Bearer-authed except /health)

The .247 side (or you) can manage the whole 7B over HTTP — no SSH needed:

| Method & path | What it does |
|---|---|
| `GET  /health` | liveness (no auth) |
| `GET  /status` | model up? which model? VRAM? systemd state? |
| `GET  /config` | full settings (prompt, schema, defaults) |
| `POST /config/params` | change sampling: `{"temperature":0.1,"top_p":0.9,"seed":42,"max_tokens":300,...}` |
| `POST /config/prompt` | change system prompt (applied LIVE via /props + persisted) |
| `POST /config/grammar`| replace output schema: `{"schema":{...}}` |
| `GET  /models` / `POST /model` | list / swap allowlisted model (rewrites config + restart) |
| `POST /restart` | restart ONLY the odds model |
| `POST /v1/chat/completions` | inference proxy (prompt+schema+defaults injected) |

To add a swappable model: download a GGUF onto .209, add `name→path` under `allowed_models` in
`/home/dockeradmin/services/odds/config.json`, then `POST /model`. API refuses non-allowlisted names
and missing files.

## 4. OUTPUT CONTRACT (grammar-locked JSON, always parseable)

```json
{"matches":[{
  "home":"Arsenal",
  "home_shift": 0.05,     // prob mass toward home win (+) / away (-)
  "draw_shift": 0.0,
  "away_shift": -0.05,    // ALWAYS == -home_shift (conservation enforced)
  "totals_shift": 0.0,    // + = lean Over, - = lean Under
  "confidence": 0.8,      // 0..1
  "adjustments": ["home_form_strong","away_key_injury"]  // <=3 tags, logging only
}]}
```
**Magnitude scale:** 0 = none; 0.01–0.02 weak; 0.03–0.05 clear single signal; 0.06–0.08 multiple
aligned; 0.10 max (rare). Most matches 0–0.04. **ONE match per request** (batches truncate/flip signs).

---

## 5. INTEGRATION SIDE — files on .247 (`/home/dockeradmin/services/hk-odds-engine/`)

### NEW: `src/aiAdjust.js`
- `hasEvidence(ev)` — true only if `ev.form`/`ev.injuries`/`ev.notes` present. **Gates the GPU call.**
- `formatMatchText(ev)` — builds model input from real markets + form/injuries/notes.
- `fetchJudgment(ev)` — POST to :8091 with Bearer, 20s timeout, parses grammar-locked JSON.
- `repriceMarket(outcomes, shiftFor)` — 1/price → strip **original** overround → add shift → clamp
  ≥0.005 → renormalize → **restore original overround** → decimal (3dp, ≥1.01).
- `applyJudgment(ev,j)` — gates (conf ≥0.4, |home_shift| ≥0.015, |totals_shift| ≥0.015), maps
  home/draw/away onto real outcome names (2-way & 3-way), tags `_aiAdjusted/_aiConfidence/_aiTags/_aiAt`.
- `runAiAdjust({sports,getCacheRaw,setCache,onAdjusted})` — orchestrates; `onAdjusted` lets cron re-anchor.

### CHANGED: `src/crons/odds.js`  (backup: `src/crons/odds.js.bak.20260725-004209`)
1. `+ require('../aiAdjust')`
2. Added `aiAnchor{}` + `storeAiAnchor`/`clearAiAnchor`/`driftBaseFor` after `storeBaseOdds`.
3. `applyDrift` drifts toward `driftBaseFor()` = **AI anchor if set, else seed**.
4. `clearAiAnchor(sport)` on both re-seed paths (daily + validate) → fresh market data resets AI.
5. Added `aiAdjustAll()` (re-entrancy guarded) + `cron.schedule('15,45 * * * *', aiAdjustAll)`.

### NEW: `data/ai-token.txt` — bearer token, chmod 600, in mounted volume (survives rebuilds).

## 5b. WHERE THE ORIGINAL SPEC DID NOT MATCH REALITY (deviations)

| Spec assumed | Reality | Fix |
|---|---|---|
| `match.home_team`, `bookmakers[0].markets[]` | `ev.homeTeam`, `ev.markets.{h2h,totals,spreads}` (camelCase, keyed object) | Rewrote format + math |
| `getAll/setAll/persistToDisk` | `getCacheRaw(sportKey)`/`setCache(sportKey,events)` (setCache persists) | Real API |
| Re-apply **fixed 4% overround** | Markets carry own overround (−1.3% to +6%; some <1.0) | Preserve **original** overround; 0-shift round-trips unchanged |
| node-fetch, maybe via proxy | Node 20 global `fetch`; proxy is external-only | Direct fetch, no proxy |
| Adjust cache only | 5-min **drift engine** reverts to seed | Added `aiAnchor`; drift targets it. **Biggest gap** — else AI change erased in minutes |
| Batch matches | Batching flips signs | One/req, 200ms apart |

## 6. IT'S LIVE BUT DORMANT — how to activate

Makes **zero model calls** right now: cached events hold only odds, no evidence. To switch on,
attach any of these to events before :15/:45 (cron picks them up, no code change):
- `ev.form = { home:"WWWDW", away:"LDWLL" }`
- `ev.injuries = { home:[...], away:["key striker out"] }`  *(or flat `["..."]`)*
- `ev.notes = "free-text context"`

Source options: extended SharpAPI/the-odds-api fields, a scraper, or the future Chinese vendor data.

## 7. VERIFIED (all passed)

- Price math (local): idempotent zero-shift; overround preserved to 4dp; favored side shortens;
  low-confidence = no-op.
- E2E in container → live .209: Arsenal 1.90→1.793, Chelsea 4.20→4.84, conf 0.75, overround 1.0501
  preserved; no-evidence event skipped.
- Drift-anchor: after AI moved 1.90→1.728, 10 drift cycles held 1.728 (vs 1.81 creep-back without anchor).
- Syntax checked on Node 20; test files cleaned; live cache pure (115 events, no leakage); container healthy.

## 8. LIMITATIONS / OPS

- **Spreads not adjusted** (model gives h2h+totals only; `spreads`/`h2h_lay` untouched — needs
  handicap-aware shift to add).
- **Totals shift conservative** (often 0 unless strong O/U signal) — expected.
- **Coupling:** .247 now depends on .209 being up. If .209 is down, runs log errors and **leave odds
  unchanged** (fail-safe). Drift/validate keep working. (Crosses HOMEKONG↔Aether by design — GPU lives
  on Aether.)
- **Tuning knobs** (top of `aiAdjust.js`): `MIN_CONFIDENCE`, `MIN_H2H_SHIFT`, `MIN_TOTALS_SHIFT`,
  `REQ_TIMEOUT_MS`. Model prompt/temp/swap via the :8091 control API.
- **Rollback:** restore `odds.js.bak.20260725-004209`, delete `aiAdjust.js`, rebuild.

## 9. QUICK COMMANDS

```bash
# --- .247 (integration) ---
ssh -i ~/.ssh/dockerhost_key dockeradmin@192.168.50.247
cd /home/dockeradmin/services/hk-odds-engine
docker logs hk-odds-engine 2>&1 | grep '\[ai\]'                       # watch AI runs (after :15/:45)
docker exec hk-odds-engine wget -qO- http://192.168.50.209:8091/health # model reachable from container?
docker compose build && docker compose up -d                           # after code change

# --- model reachability / control (from anywhere on LAN) ---
TOKEN=CHANGE_ME
curl -s http://192.168.50.209:8091/status -H "Authorization: Bearer $TOKEN"
curl -s http://192.168.50.209:8091/v1/chat/completions -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"Arsenal(home) v Chelsea EPL. h2h 1.90/3.5/4.2 OU2.5 1.87/1.95. Form Arsenal WWWDW, Chelsea LDWLL. Chelsea striker OUT."}'

# --- .209 (model host) ---
ssh -i ~/.ssh/dockerhost_key dockeradmin@192.168.50.209
systemctl status aether-odds aether-odds-control --no-pager
```

---
*Related memory: `odds-ai-model.md`. Server-side copies of docs live at
`.209:/home/dockeradmin/services/odds/HANDOFF_TO_FIVEM.md` and `.247:~/ODDS_MODEL_HANDOFF.md`.*

