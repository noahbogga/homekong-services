# hk-handling — session handoff

## Current state
All planned rebuild work is DONE and in-game. Playtest is ~95% complete.

---

## What was built (this arc)

### Three-mode gearbox rebuild
`Config.Gearbox.Mode = 'easy' | 'normal' | 'expert'`

- **easy** — simple box, no RPM writes, no ratio/jim/expert cal. Types 3/4/5 clamped to 2.
- **normal** — full box + background open-loop 0-100 learner (default, focus mode).
- **expert** — legacy SpeedCal / /setspeed / /accelcal / autocal system, gated.

All mode helpers (`isEasy/isNormal/isExpert`) live in every file that needs them.

### Normal learner (open-loop, stable)
- Phase A: first clean stock WOT pull suspends box (native capture), server writes `N:60,T;100,T;` baseline.
- Phase B: subsequent pulls run with box, server computes `f = fApplied * T_ours / T_native` (never compounds), blends into `speedCalC` scalar.
- Client sends telemetry only. Server computes trim. Rate-limited + bounds-clamped.
- `N:` prefix distinguishes native baselines from old expert rows.
- Files: `client/normallearner.lua`, `server/gearbox.lua` (`normalLearnSample` event).

### syncModels live-refresh
When learner writes a new trim, `syncModels` handler refreshes `gbSpeedCal` on the current car without re-entry.

### `/nlstatus` admin command
`/nlstatus` (current vehicle) or `/nlstatus <hash>` — prints baseline, current scalar, blend candidates. Server + client roundtrip via `requestNlStatus` / `nlStatusReply`.

### Jim upgrade live-swap fix
Applying a jim mechanic upgrade while seated was starting the new mode in neutral (drive force 0 → car stuck). Fixed via `gbLiveUpgrade` flag in `onActivate` that forces `enteredMoving = true` on re-enable, so the car engages a gear instead of starting in neutral.

### isEasy nil-reference fix
Mode helpers were declared after `vl_setRpmRaw` used `isEasy()`. Moved helpers above the wrapper (line ~64).

---

## Files changed
- `config.lua` — `Mode = 'normal'` + full `NormalLearn` block
- `client/gearbox.lua` — mode helpers, easy gates, normal/expert SpeedCal split, expert-only AccelMatch, `HK.normalLearnerSetNativeSuspend`, syncModels live-refresh, `gbLiveUpgrade` fix, `/nlstatus` client handler
- `client/normallearner.lua` — new file, Phase A/B learner
- `client/autocal.lua` — expert-only gates
- `client/acceltimer.lua` — pure stopwatch + top-speed capture
- `server/gearbox.lua` — `normalLearnSample` event, `/nlstatus` command, server command gating, `speedCal`/`speedCalC` preservation
- `fxmanifest.lua` — `normallearner.lua` added

---

## Pending
- **Playtest** — normal learner Phase B convergence needs more real runs to confirm scalar lands correctly per model.
- **`speedcaldata.lua`** — bulk-cal data built from Grok's inconsistent 0-160 figures. Expert-mode only concern. Needs a GPT re-query for clean 7-field real-life data then regenerate the file.

---

## Key constants / design decisions (don't re-litigate)
- `TrimMin/Max` = 0.94/1.08 (server clamp on learned scalar)
- `MinPlausibleT100` = 1.2s (devel22 is 1.8s 0-100)
- Single scalar into `gbSpeedCal {s,s,s,s}` — NOT two-band
- `N:` marker guards against old expert DB rows being read as baselines
- `normalLearnSample` deliberately does NOT reuse `setSpeedModel` (line 316 wipe trap)
- `gbLiveUpgrade` cleared immediately after `enteredMoving` is set in Enable — no leak

---

## Reference
- `~/.claude/knowledge/gta-handling/handling-fields.json` — handling field metadata
- `C:\Users\Administrator\Desktop\gptread.md` — GPT-5.5 design responses land here
- GPT-5.5 in Cherry Studio: temp 0.25, reasoning_effort high
