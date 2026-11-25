# fivem-ai

The AI services the game called, and the setup for the local language models behind them.

| Path | What it is |
|---|---|
| `hk-npc-gateway/` | The **NPC dialog gateway**. Game scripts send `POST /npc` and get back a line for the NPC to say. In front of the model it adds a semantic cache, a bounded request queue, canned fallback lines, and a GBNF grammar on every call so replies are always valid JSON. Personalities and moods are set in `config.json` and reload without a restart. `CONTRACT.md` describes the API. |
| `fivem-ai-api/` | A small API the `hk-ai` game script uses to answer player questions with a small local model. |
| `v100-models/odds/` | The odds-adjustment model ([llama.cpp](https://github.com/ggml-org/llama.cpp), Qwen2.5-7B): a launcher that reads `config.json`, a control API that can change settings and restart only this model, and the prompt and JSON schema that make it return a judgment instead of prices. `HANDOFF_TO_FIVEM.md` explains how the game uses it. |
| `v100-models/npc/` | The NPC dialog model, set up the same way. |
| `v100-models/infra/` | systemd units for both models. |
| `v100-models/tests/` | Calibration, determinism and speed tests for the odds model, and a load test for NPC dialog. |

These models ran on a separate GPU machine; point the configs at yours.

## Setup
- `fivem-ai-api/server.js`: `API_KEY` (must match the `hk-ai` game script).
- `hk-npc-gateway/config.json`: `api_key` (must match `hk-drugsell` in the game scripts), and the model and embedder hosts.
- `v100-models/odds/token`: the token for the odds model's control API.
