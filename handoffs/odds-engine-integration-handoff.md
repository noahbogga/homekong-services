# hk-odds-engine ⇄ AI Odds Model — Integration Complete (Build Handoff)

**Date:** 2026-07-25
**By:** Claude (main host session)
**Status:** ✅ Built, deployed, verified end-to-end. Live but dormant until form/injury data is added (by design).

This documents the AI-odds integration into **hk-odds-engine on .247**, every file changed, and
**where the original build spec did NOT match reality** (several places — read §2).

---

## 1. TL;DR — what now happens

- New module `src/aiAdjust.js` calls the local AI model on **.209:8091**, one match per request.
- New cron `ai-adjust@:15/:45` (every 30 min, offset from validate) loops cached matches, and for
  any match **that carries form/injury evidence**, gets a probability-shift judgment and reprices
  its h2h + totals markets.
- Adjusted matches are **anchored** so the existing 5-min drift engine mean-reverts toward the AI
  price, not the raw seed — otherwise drift would erase the AI change within minutes.
- **Right now it makes ZERO model calls**, because cached events contain only odds (no form/injury).
  It is a safe no-op until an evidence source is wired in (§6). This is intended.

---

## 2. WHERE THE SPEC DID NOT MATCH REALITY (plan deviations)

The original handoff pseudocode assumed the-odds-api's raw shape. The live engine normalizes
everything into its own shape. Key corrections made:

| Spec assumed | Reality | What I did |
|---|---|---|
| `match.home_team`, `match.bookmakers[0].markets[]` | `ev.homeTeam`, `ev.markets.{h2h,totals,spreads}` (object keyed by market, camelCase) | Rewrote formatting + math for the real shape |
| `oddsCache.getAll()/setAll()/persistToDisk()` | `getCacheRaw(sportKey)` / `setCache(sportKey, events)` (setCache already persists) | Orchestrator uses the real API |
| Re-apply **fixed 4% overround** | Real markets have their **own** overround (measured −1.3% to +6%; some are <1.0) | Preserve each market's **original** overround. A 0-shift match round-trips unchanged. Fixed 4% would have shifted every AI-touched price ~5% with a systematic bias. |
| `node-fetch` + could go via proxy | Node 20 → global `fetch`; proxy is for **external** APIs only | Direct `fetch` to .209, **not** through the residential proxy |
| Adjust the cache only | A **drift engine** mean-reverts to `baseOdds` every 5 min | Added an `aiAnchor` layer; drift now targets anchor-if-present. **This was the biggest gap** — without it the feature silently wouldn't stick. |
| Batch all matches | Batching flips signs / truncates (proven earlier) | One match per request, 200ms apart |

---

## 3. FILES CHANGED (all on .247, `/home/dockeradmin/services/hk-odds-engine/`)

### NEW: `src/aiAdjust.js`
Self-contained module. Exports `runAiAdjust`, `adjustEvent`, `applyJudgment`, `repriceMarket`,
`formatMatchText`, `hasEvidence`, `fetchJudgment`.
- `hasEvidence(ev)` — true only if `ev.form` / `ev.injuries` / `ev.notes` present. Gates the GPU call.
- `formatMatchText(ev)` — builds the model input string from real markets + form/injuries/notes.
- `fetchJudgment(ev)` — POST `{input}` to .209:8091 with Bearer token, 20s timeout, parses the
  grammar-locked JSON. Reads token from `data/ai-token.txt` or `AI_ODDS_TOKEN`.
- `repriceMarket(outcomes, shiftFor)` — the math: 1/price → strip original overround → add shift →
  clamp ≥0.005 → renormalize → **restore original overround** → back to decimal (3 dp, ≥1.01).
- `applyJudgment(ev, j)` — gates (confidence ≥0.4, |home_shift| ≥0.015, |totals_shift| ≥0.015),
  maps model home/draw/away onto real outcome names (handles 2-way & 3-way), tags `_aiAdjusted`,
  `_aiConfidence`, `_aiTags`, `_aiAt`.
- `runAiAdjust({sports,getCacheRaw,setCache,onAdjusted})` — orchestrates; calls `onAdjusted` per
  changed sport so the cron can re-anchor.

### CHANGED: `src/crons/odds.js`  (backup saved: `src/crons/odds.js.bak.20260725-004209`)
1. `+ require('../aiAdjust')`
2. Added `aiAnchor{}` + `storeAiAnchor` / `clearAiAnchor` / `driftBaseFor` after `storeBaseOdds`.
3. `applyDrift` now drifts toward `driftBaseFor()` = **AI anchor if set, else seed**.
4. `clearAiAnchor(sport)` on both re-seed paths (daily seed + validate) — fresh market data resets AI.
5. Added `aiAdjustAll()` (with a re-entrancy guard) + `cron.schedule('15,45 * * * *', aiAdjustAll)`.

### NEW: `data/ai-token.txt`  (chmod 600, in mounted volume → survives rebuilds)
Contains the Bearer token for .209:8091. Not in code.

---

## 4. HOW THE DRIFT ANCHOR WORKS (the important bit)

```
seed (baseOdds)  ──drift pulls toward──►  original market price
      │
      │ AI adjusts a match
      ▼
aiAnchor[sport][id]  ──drift now pulls toward──►  AI-adjusted price
      │
      │ daily seed OR validate re-seed brings fresh market data
      ▼
clearAiAnchor(sport) → drift falls back to seed again
```

Verified in-container: after AI moved Arsenal 1.90→1.728, 10 drift cycles held it at **1.728**.
Without the anchor it would have crept back to ~1.81 toward the 1.90 seed. Anchor confirmed working.

## 5. VERIFICATION DONE (all passed)

- **Price math unit tests** (local Node): zero-shift is idempotent; overround preserved to 4dp;
  favored side shortens, other side lengthens; below-threshold confidence = no-op.
- **End-to-end in container → live .209 model**: synthetic Arsenal-v-Chelsea (form + injury) →
  model returned conf 0.75, tags `[home_form_strong, away_key_injury]`; Arsenal 1.90→1.793,
  Chelsea 4.20→4.84; overround 1.0501 preserved. No-evidence event correctly skipped (no call).
- **Drift-anchor interaction**: confirmed drift reverts to anchor, not seed.
- **Syntax** checked on Node 20 (container version) for both files.
- **Cleanup**: test files removed; live cache verified pure (115 real events, no synthetic ids,
  no stray `_aiAdjusted`); container healthy (`/health` ok); new schedule line present in logs.

## 6. WHAT'S LEFT TO MAKE IT ACTUALLY DO SOMETHING

The engine is wired and safe but **dormant** — it needs evidence on events. To activate, populate
any of these on cached events (then the cron picks them up automatically, no code change):

- `ev.form = { home: "WWWDW", away: "LDWLL" }`
- `ev.injuries = { home: [...], away: ["key striker out"] }`  *(or a flat `["..."]` array)*
- `ev.notes = "any free-text context"`

Sources you could feed from: SharpAPI/the-odds-api extended fields (if available), a scraper, or the
future Chinese vendor data mentioned in the original brief. Whatever writes it just needs to attach
these fields to events in the cache before `:15/:45`. Everything downstream already works.

**Tuning knobs** (top of `src/aiAdjust.js`): `MIN_CONFIDENCE` (0.4), `MIN_H2H_SHIFT` (0.015),
`MIN_TOTALS_SHIFT` (0.015), `REQ_TIMEOUT_MS` (20s). Model-side settings (prompt, temp, model swap)
are managed via the .209 control API — see `Desktop/ODDS_MODEL_HANDOFF.md`.

## 7. LIMITATIONS / NOTES

- **Spreads not adjusted.** The model outputs h2h + totals shifts only; `spreads`/`h2h_lay` markets
  are left untouched. Adding spreads would need a handicap-aware shift from the model.
- **Totals shift is conservative** (model often returns 0 unless strong over/under signal) — expected.
- **Shared GPU coupling.** hk-odds-engine now depends on the Aether .209 box being up. If .209 is
  down, `fetchJudgment` throws per match, the run logs errors and skips — **cached odds are left
  unchanged** (fail-safe, not fail-broken). Drift/validate keep working regardless.
- **Rollback:** restore `src/crons/odds.js.bak.20260725-004209`, delete `src/aiAdjust.js`,
  `docker compose build && docker compose up -d`.

## 8. QUICK COMMANDS

```bash
ssh -i ~/.ssh/dockerhost_key dockeradmin@192.168.50.247
cd /home/dockeradmin/services/hk-odds-engine

docker logs hk-odds-engine 2>&1 | grep '\[ai\]'      # watch AI runs (after :15/:45)
docker exec hk-odds-engine wget -qO- http://192.168.50.209:8091/health   # model reachable?
docker compose build && docker compose up -d          # after any code change
```

