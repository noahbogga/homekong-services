# Homgkong Server Plan

> **STATUS: HISTORICAL (original build plan).** The "fxServer (Windows)" VM in this doc was later migrated to Linux and is now **hk-fxmain** (192.168.50.235). Current VM names: **hk-fxmain** (prod FiveM), **hk-fxtest** (debug), **hk-services** (.247, web/Docker). References to "fxServer" below describe the original Windows design, kept for history.

**Box:** Xeon E5-2696 v4 (22c/44t), 128 GB RAM, C: 953GB (334 free) + D: 1.49TB (949 free). More than enough.
**Domains:** homekong.cc (infra) + homekong.online (public)  |  **Public IP:** 116.49.242.148 (HK)  |  **Tailscale:** active (homekong-host)

---

## Architecture (chosen: Option A — Consolidate)

```
                          Internet
                             |
         Cloudflare (homgkong.gg)  ── DDoS shield, hides home IP for WEB
                             |  (Cloudflare Tunnel, no open router ports)
   ┌─────────────────────────────────────────────────────┐
   │  WINDOWS HOST (this machine)                          │
   │   Docker:                                             │
   │     • Picsur        -> image.homekong.cc                │
   │     • Uptime Kuma   -> status.homekong.cc               │
   │     • cloudflared   (the tunnel)                        │
   │                                                       │
   │   Hyper-V internal switch (host <-> VM private lane)  │
   │   ┌───────────────────────────────────────────────┐  │
   │   │  VM "fxServer" (Windows)                        │  │
   │   │    • fxserver (FiveM)                           │  │
   │   │    • MariaDB  (same VM = localhost-fast queries)│  │
   │   │    • SMB share -> shows on host as Z:\          │  │
   │   └───────────────────────────────────────────────┘  │
   └─────────────────────────────────────────────────────┘
```

**Why this shape:** FiveM<->SQL stay on one VM = fastest queries (the #1 perf rule). Game is isolated + snapshottable. Picsur/Kuma already isolated by Docker, no VM needed. One VM to maintain, not five.

---

## Network truth (important)
- Both LAN cables go to ONE router (192.168.50.1) = ONE internet line. Two NICs ≠ two networks.
- Fix: 2500M (Intel I226) = host's single uplink. Realtek 1Gb = disabled/unused. VMs reach internet via host through an internal Hyper-V switch.

---

## IP hiding — two SEPARATE problems
- **Picsur / web (HTTP):** ✅ fully hidden via Cloudflare Tunnel. Players see only Cloudflare. FREE.
- **FiveM game (UDP 30120):** ❌ NOT hidden by free Cloudflare. Home IP currently visible to connected players.
  - Fix later = cheap VPS ($4-6/mo) as UDP proxy, OR a FiveM DDoS-proxy service. Separate mini-project.

---

## PHASE 1 — Stabilize base (host-side, I do it)
- [ ] Confirm/disable Realtek 1Gb so only 2500M is the host uplink
- [ ] Verify single default gateway, no NIC flip-flop
- [ ] Confirm Docker set to start on boot (so Picsur/Kuma survive reboot)

## PHASE 2 — Expose Picsur via homgkong.gg (you + me)
- [ ] YOU: make free Cloudflare account, add homgkong.gg, switch nameservers at registrar (I give exact steps)
- [ ] ME: install cloudflared in Docker, create tunnel
- [ ] ME: route image.homekong.cc -> Picsur(8081), status.homekong.cc -> Kuma(3001)
- [ ] TEST: image.homekong.cc loads over HTTPS, home IP not exposed
- [ ] Point FiveM scripts / qb-phone uploads at image.homekong.cc

## PHASE 3 — Game VM (you give creds, I do the rest via PowerShell Direct)
- [ ] Create internal Hyper-V switch (host<->VM lane)
- [ ] Start/configure fxServer VM, assign CPU/RAM
- [ ] Install MariaDB inside VM
- [ ] COPY (not move) fxserver folder from host into VM — host copy kept as backup
- [ ] Set up SMB share -> mounts on host as Z:\ for live file access
- [ ] Migrate DB, point fxserver at local MariaDB, test players connect

## PHASE 4 — Hide FiveM IP (optional, later)
- [ ] Decide: cheap VPS UDP proxy vs FiveM DDoS-proxy service
- [ ] Set up, repoint server, players connect via proxy IP

---

## What I need from you
1. Cloudflare account + nameserver change for homgkong.gg (Phase 2) — guided
2. The fxServer VM's Windows username + password (Phase 3) — so I can configure inside it
3. Go/no-go at each phase
