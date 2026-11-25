#!/bin/bash
# ExecStartPost guard: confirm the NPC model claimed VRAM (>1GB). POLLS for up to
# ~50s because a larger model / bigger ctx can take >12s to finish claiming VRAM
# off disk (the 2026-08-26 Qwen-swap false-negative). If it never claims GPU it
# fell back to CPU on the tight shared V100 — kill it so systemd relaunches.
set -uo pipefail
PORT=8092
PID=""
for i in $(seq 1 25); do
  PID=$(pgrep -f "port ${PORT}" | head -1)
  [ -n "$PID" ] && break
  sleep 2
done
if [ -z "$PID" ]; then echo "[healthcheck] no llama-server on :${PORT}"; exit 1; fi
VRAM=0
for i in $(seq 1 25); do
  LINE=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits | grep -E "^\s*${PID}\s*,")
  VRAM=$(echo "$LINE" | grep -oE "[0-9]+" | tail -1); VRAM=${VRAM:-0}
  [ "$VRAM" -gt 1000 ] && break
  sleep 2
done
echo "[healthcheck] pid=$PID vram=${VRAM}MiB"
if [ "$VRAM" -gt 1000 ]; then echo "[healthcheck] OK on GPU"; exit 0
else echo "[healthcheck] CPU-fallback (vram=${VRAM}), killing pid $PID"; kill "$PID"; exit 1; fi
