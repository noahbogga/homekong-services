# HK NPC Gateway — HTTP Contract (for the fxmain Lua writer)

This is the **stable interface** between FiveM (hk-fxmain, .235) and the NPC AI.
Code the Lua side against THIS. Do not touch gateway internals or the .209 model.
If you need a new NPC personality, new action/mood, or new canned lines, edit
`config.json` on .247 and `POST /reload` — never change `server.js`.

## Where it lives
- Gateway: **http://192.168.50.247:3089** (container `hk-npc-gateway` on hk-services)
- Auth: header `Authorization: Bearer hk-npc-2026`
- fxmain reaches .247 directly over the LAN (verified ~0.3ms).

## POST /npc  — get an NPC's reaction to a player line
Request JSON:
```json
{
  "persona": "drugdealer_01",        // optional, key into config.personas; omit = "default"
  "message": "yo you holding?",      // REQUIRED — what the player said/did
  "context": ""                       // optional short situational note (e.g. "cops nearby").
}                                       //   NOTE: when context is set, semantic cache is skipped.
```

Response JSON (always HTTP 200 on a handled request; schema is GRAMMAR-guaranteed):
```json
{
  "dialog": "Depends who's askin'. Cash up front.",
  "action": "deal",         // one of config.enums.action
  "price_mult": 1.0,        // float 0..>1, multiply your base price by this
  "mood": "greedy",         // one of config.enums.mood
  "source": "live"          // "cache" | "live" | "fallback"  (informational)
}
```

### `source` meanings (Lua can ignore, but useful)
- `cache`  — semantically-similar line answered before, instant.
- `live`   — fresh model call on .209.
- `fallback` — model was busy/slow/errored; you got a safe canned line from
  the persona's `fallback` list. Response is STILL schema-valid. Field
  `reason` = `queue` (too many in flight) or `infer` (model error/timeout).

### Current enums (from config.json)
- action: `greet, deal, refuse, haggle, flee, threaten, smalltalk`
- mood:   `calm, nervous, hostile, greedy, friendly`

The Lua side owns what each `action` DOES in-game (give item, play anim, call
cops, walk away). The gateway only decides which action fires. This is the
brain/body split: the model makes the human-timescale decision, Lua runs the
per-tick mechanics.

## GET /health
`{ "status":"ok", "inflight":N, "queued":N, "personas":[...] }` — no auth.

## GET /stats
`{ req, cache_hit, live, fallback, queue_reject }` — no auth. Watch cache_hit
climb; that's what keeps the V100 under its live-call budget.

## POST /reload  (auth)
Re-reads config.json (personas / enums / fallback / thresholds) and rebuilds the
grammar. Use after editing config so you don't rebuild the container.

## Latency budget (measured on V100, grammar-constrained)
- 1 concurrent ~0.7s, 4 ~1.6s, 8 ~3.1s, 16 ~5.7s, 30-burst ~7.6s p95.
- The cache + `queue.max_inflight=4` keep typical live calls in the 1–2s band.
- `inference.timeout_ms=2500` — if the model can't answer in time you get a
  fallback line instead of a hung NPC. Tune in config.

## Design rules the Lua side must respect
1. **Never call the .209 model directly.** Always go through this gateway
   (grammar, cache, queue, fallback all live here).
2. **One call per human-timescale beat** (player speaks, player offers a deal),
   never per game tick.
3. `message` is capped at 500 chars, `context` at 400. Keep them short.
4. Treat `dialog` as untrusted display text — it's model output. Escape before
   putting it in any HTML/chat formatting.
