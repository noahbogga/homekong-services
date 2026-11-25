#!/bin/bash
# ExecStartPost guard for aether-odds: confirm the model actually claimed VRAM.
# If it silently fell back to CPU (VRAM ~0), kill it so systemd Restart relaunches.
# Robust: no awk quoting games; uses grep against the pid.
set -uo pipefail
PORT=8081
sleep 12
PID=$(pgrep -f "port ${PORT}" | head -1)
if [ -z "$PID" ]; then
  echo "[healthcheck] no llama-server on :${PORT}"; exit 1
fi
# nvidia-smi line format: "<pid>, <mib>"
LINE=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits | grep -E "^\s*${PID}\s*,")
VRAM=$(echo "$LINE" | grep -oE "[0-9]+" | tail -1)
VRAM=${VRAM:-0}
echo "[healthcheck] pid=$PID vram=${VRAM}MiB"
if [ "$VRAM" -gt 1000 ]; then
  echo "[healthcheck] OK on GPU"; exit 0
else
  echo "[healthcheck] CPU-fallback (vram=${VRAM}), killing pid $PID"; kill "$PID"; exit 1
fi
