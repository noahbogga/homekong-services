# Odds AI Model — Handoff to hk-odds-engine (.247 / FiveM side)

The local AI odds model is live on **AetherMem (.209)**, GPU-backed (Tesla V100). It runs as
its own service, isolated from Aether's other services. You control it two ways: **inference**
(get odds judgments) and **management** (change its settings). Both are HTTP, on the LAN.

---

## 1. INFERENCE — two ways to call

### Option A (recommended): via the control API proxy — prompt + schema auto-injected
- **URL:** `http://192.168.50.209:8091/v1/chat/completions`
- **Auth:** `Authorization: Bearer <TOKEN>` (see §3)
- You send **just the match text**; the server injects the tuned system prompt, the JSON
  schema (grammar-locked), and the default sampling (temp 0.1, seed 42). Simplest for you.

```bash
curl -s http://192.168.50.209:8091/v1/chat/completions \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"input":"Arsenal(home) v Chelsea EPL. h2h 1.90/3.5/4.2 OU2.5 1.87/1.95. Form Arsenal WWWDW, Chelsea LDWLL. Chelsea striker OUT."}'
```

### Option B: hit llama-server directly (no auth, you supply prompt+schema yourself)
- **URL:** `http://192.168.50.209:8081/v1/chat/completions`  (OpenAI-compatible)
- **Model field:** anything (single model loaded) — or omit it
- **Auth:** none (LAN only — do NOT expose off-LAN)
- Use this if you want full control of the request. Set `response_format` with a
  `json_schema` for guaranteed-parseable output.

---

## 2. THE OUTPUT CONTRACT — read this, it changed from your original spec

**IMPORTANT:** After testing, the model does **NOT** return final prices. It returns a
**judgment** (which side the evidence favors + how strongly). *You* do the price math in
hk-odds-engine. Reason: a 7B makes small arithmetic/consistency errors on odds↔probability
conversion; letting it decide direction+magnitude (which it's reliable at) and doing the exact
vig-strip/reprice in code is far more accurate. Verified deterministic at temp 0.1.

Output JSON (one object per match, grammar-locked so it always parses):
```json
{"matches":[{
  "home":"Arsenal",
  "home_shift": 0.05,     // prob mass to move toward home win (+) or away (-)
  "draw_shift": 0.0,
  "away_shift": -0.05,    // ALWAYS == -home_shift (conservation enforced)
  "totals_shift": 0.0,    // + = lean Over, - = lean Under
  "confidence": 0.8,      // 0..1
  "adjustments": ["home_form_strong","away_key_injury"]  // <=3 tags, logging only
}]}
```
**Magnitude scale** (conservative, markets are efficient): 0 = no evidence; 0.01–0.02 weak;
0.03–0.05 clear single signal; 0.06–0.08 multiple aligned; 0.10 max (rare). Most matches 0–0.04.

**How to apply in hk-odds-engine (the math YOU do):**
1. current decimal odds → implied prob (1/odds each), normalise to strip the vig
2. new_home_prob = home_prob + home_shift; new_away_prob = away_prob + away_shift; draw same
3. renormalise to sum 1.0, re-apply your target margin, convert back to decimal odds
4. same idea for totals using totals_shift on the over/under split

### ⚠️ Batching: ONE MATCH PER REQUEST
Testing showed multi-match batches truncate and flip signs. Send matches **individually**
(loop). Each call ≈1.4s on the V100; 15 matches ≈ 21s sequential (fine for your 30-min cycle).
The `matches` array exists so a single call is uniform — but put one match in it.

---

## 3. AUTH TOKEN
Bearer token file on .209: `/home/dockeradmin/services/odds/token`
Current value:
```
CHANGE_ME
```
Store it in hk-odds-engine config/env (not in code). Only needed for the :8091 control API;
:8081 direct inference needs no auth. If rotated, re-read that file.

---

## 4. MANAGEMENT — control the model's settings (all on :8091, all Bearer-authed)

| Method & path | What it does |
|---|---|
| `GET  /health` | liveness of control API (no auth) |
| `GET  /status` | is model up? which model? VRAM? systemd state? |
| `GET  /config` | full current settings (prompt, schema, defaults) |
| `POST /config/params` | change default sampling: `{"temperature":0.1,"top_p":0.9,"seed":42,"max_tokens":300,"top_k","min_p","repeat_penalty"}` |
| `POST /config/prompt` | change system prompt: `{"system_prompt":"..."}` — applied LIVE (no restart) + persisted |
| `POST /config/grammar`| replace output schema: `{"schema":{...json-schema...}}` |
| `GET  /models` | list allowlisted models + which is loaded |
| `POST /model` | swap model: `{"model":"<name-from-/models>"}` → rewrites config + restarts |
| `POST /restart` | restart ONLY the odds model |

Examples:
```bash
# tune determinism
curl -s -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  http://192.168.50.209:8091/config/params -d '{"temperature":0.15}'

# rewrite the analyst instructions live
curl -s -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  http://192.168.50.209:8091/config/prompt -d '{"system_prompt":"You are a football odds analyst..."}'

# restart the model
curl -s -H "Authorization: Bearer <TOKEN>" -X POST http://192.168.50.209:8091/restart
```

**Adding a new model to swap to:** download a GGUF onto .209, add a `name → path` entry under
`allowed_models` in `/home/dockeradmin/services/odds/config.json`, then `POST /model`. The API
refuses any name not in that allowlist and any path that doesn't exist on disk.

---

## 5. WHAT IS RUNNING (for reference)
- **Model:** Qwen2.5-7B-Instruct (Q4_K_M GGUF) — chosen for numeric reasoning + structured output
- **Server:** llama.cpp `llama-server`, GPU (V100), ctx 8192, 2 parallel slots, `--props` on
- **Services (systemd, auto-start on boot, GPU-wait + VRAM-claim guard):**
  - `aether-odds.service` → llama-server on :8081
  - `aether-odds-control.service` → control API on :8091
- **Isolation:** this touches ONLY the odds model. Aether's verifier (:8080), Qdrant, and
  embedder share the box but are never affected by these services or the control API.

## 6. LIMITS / GOTCHAS
- **Not <2s for a 15-match batch** — that was physically impossible locally (token gen floor).
  One match ≈1.4s; loop them. Your cadence (30 min / daily) has plenty of headroom.
- **LAN only.** No auth on :8081. Don't port-forward or tunnel either port off the LAN.
- **Shared GPU.** If Aether ever loads a big image-gen job on the V100, VRAM could contend.
  Current use: verifier 17.7G + embedder 0.4G + odds 5.1G = ~23/32G, ~9G free. Fine today.
- **Reboot:** both services come back automatically; the guard waits for the GPU driver first.
