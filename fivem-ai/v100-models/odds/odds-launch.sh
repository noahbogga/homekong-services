#!/bin/bash
# Launch llama-server for the odds model, reading all settings from config.json.
# Invoked by aether-odds.service. Keeps launch flags in one managed place so the
# control API can change model/ctx/etc by editing config.json + restarting.
set -euo pipefail
CFG=/home/dockeradmin/services/odds/config.json
BIN=/home/dockeradmin/llama.cpp/build/bin/llama-server

get() { python3 -c "import json,sys; print(json.load(open('$CFG'))$1)"; }

MODEL=$(get "['model_path']")
HOST=$(get "['host']")
PORT=$(get "['port']")
CTX=$(get "['ctx_size']")
NGL=$(get "['gpu_layers']")
TEMP=$(get "['defaults']['temperature']")
TOPP=$(get "['defaults']['top_p']")
FA=$(get "['flash_attn']")
SLOTS=$(get "['parallel_slots']")
PROPS=$(get "['enable_props']")

ARGS=(-m "$MODEL" --host "$HOST" --port "$PORT" -c "$CTX" -ngl "$NGL"
      --temp "$TEMP" --top-p "$TOPP" --parallel "$SLOTS" --cont-batching)
[ "$FA" = "True" ] && ARGS+=(-fa 1)
[ "$PROPS" = "True" ] && ARGS+=(--props)

echo "[odds-launch] $BIN ${ARGS[*]}"
exec "$BIN" "${ARGS[@]}"
