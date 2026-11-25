# FXServer Linux Migration — Claude Handoff Prompt

> **STATUS: COMPLETED (historical record).** The Windows `fxServer` VM described below was replaced by a Linux VM, now named **hk-fxmain** (192.168.50.235, Ubuntu). "fxServer" references in this doc mean that old, now-decommissioned Windows box. Current VM names: **hk-fxmain** (prod), **hk-fxtest** (debug), **hk-services** (web).

Copy everything below the line into a new Claude Code session on this machine.

---

## Task

I want to migrate my main FiveM (FXServer + txAdmin) production server from Windows Server 2025 (Hyper-V VM) to a Linux VM, matching what I already have running on my debug server. The goal is better performance and stability.

## Current Infrastructure

**Host machine:** Windows Server 2025, Xeon E5-2696 v4 (22 cores), 64GB RAM, IP `192.168.50.56`
- Hyper-V manages all VMs
- SSH key for Linux VMs: `~/.ssh/dockerhost_key`

**Current RAM/Core allocation:**

| VM | Cores | RAM | State |
|----|-------|-----|-------|
| fxServer (Windows, being replaced) | 22 | 32 GB | Running |
| hk-fxtest (Linux debug) | 4 | 16 GB | Running |
| hk-services | 4 | 12 GB | Running |
| BLUESTACK1 | 6 | 8 GB | Off |
| BLUESTACK2 | 6 | 8 GB | Off |

**Production server (fxServer VM — WINDOWS, what we're replacing):**
- IP: `192.168.50.235`
- OS: Windows Server 2025 Standard (22 vCPUs, 64GB RAM)
- FiveM path: `C:\FiveM\HOMEKONG\`
  - `server\` — FXServer binaries (build 30811)
  - `server-data\` — resources, configs, database
  - `txData\` — txAdmin profiles + logs
- Startup: Scheduled Task runs `start_txadmin.bat` → `FXServer.exe +set serverProfile default`
- Game port: 30120, txAdmin port: 40120
- Game build: `3258`
- SMB share: `\\192.168.50.235\FiveM` mounted as `Z:` on host

**Debug server (hk-fxtest VM — LINUX, the reference):**
- IP: `192.168.50.236`
- OS: Ubuntu 22.04 LTS (4 vCPUs, 3.5GB RAM)
- SSH: `ssh -i ~/.ssh/dockerhost_key root@192.168.50.236` (hk-fxtest)
- FiveM path: `/opt/fxserver/`
  - `server/` — Linux FXServer binaries (alpine build)
  - `server-data/` — resources, configs
  - `start.sh` → runs `./run.sh +set serverProfile debug_server +set txAdminPort 40121`
- Systemd service: `/etc/systemd/system/fxserver.service`
- Game port: 30121, txAdmin port: 40121
- Game build: `3570`
- MariaDB local: `mysql://fivem:CHANGE_ME@localhost/homekong_debug`

## What I Need Help With

1. **Create a new Linux VM** (Ubuntu 22.04) on the Hyper-V host to replace the Windows fxServer VM
   - Allocate 22 cores, 32GB RAM
   - Network: static IP on the same subnet (192.168.50.x), pick an available one
   - Install dependencies: MariaDB, needed libs

2. **Copy the production server-data** from the Windows VM (via Z: drive SMB share) to the new Linux VM
   - Resources folder, configs, txData
   - Database: export from Windows VM's MySQL and import to new Linux MariaDB

3. **Set up FXServer on Linux** using the same pattern as hk-fxtest:
   - Download Linux FXServer artifacts (build 30811 or latest compatible)
   - Create systemd service
   - Create `start.sh` with correct args: `+set serverProfile default +set txAdminPort 40120`
   - Keep same ports (30120/40120) so the Cloudflare tunnel and status service don't need changes

4. **Migrate the database** — the production server uses MySQL. Check `server.cfg` on the Windows VM for the connection string.

5. **Test** — start the Linux server, verify txAdmin comes up on :40120, game port responds on :30120

6. **Cutover plan** — once verified, shut down the Windows fxServer VM and update any references to point to the new Linux VM IP

7. **After Linux is working — convert debug server (hk-fxtest) to match**
   - The debug Linux server at `192.168.50.236` should also get SMB share mounts like the Windows host has:
     - `Z:` equivalent → mount the new Linux hk-fxmain's FiveM data (resources, txData, logs) via NFS or SSHFS
     - `Y:` equivalent → mount the debug server's own data for host access
   - On the Windows host, set up network drives so the status service and log tailing still work:
     - `Z:` → new Linux hk-fxmain (e.g. via SSHFS/WinFsp or Samba export from the Linux VM)
     - `Y:` → debug Linux hk-fxtest
   - Update `tx-status/server.js` LOG_DIR to use the new mount path
   - This keeps the same workflow: host reads logs via mapped drives, status service tails them

## Important Notes

- The status monitoring service on the host (`C:\Users\Administrator\services\tx-status\server.js`) checks ports on `192.168.50.235` — this will need updating after migration
- txAdmin logs are read via SMB at `Z:\HOMEKONG\txData\default\logs\` — will need a new share or different approach on Linux
- The Cloudflare tunnel on the host proxies to `192.168.50.235:40120` — update after cutover
- Credentials: VM admin password is `CHANGE_ME` (used for Hyper-V Invoke-Command)

## Is Linux Actually Better?

Yes, for FiveM specifically:
- **Lower overhead** — no Windows GUI/services eating RAM and CPU cycles
- **Better I/O** — ext4/XFS outperforms NTFS for the many small file reads FXServer does
- **Stable under load** — Linux scheduler handles game server tick loops more predictably
- **Less memory fragmentation** — no Windows memory compression fighting the server
- **Easier automation** — systemd, cron, and shell scripts vs scheduled tasks and PowerShell remoting
- The debug server already proves this works with your resource stack

Start by examining the debug server setup (`ssh -i ~/.ssh/dockerhost_key root@192.168.50.236`) as the reference template, then plan the migration step by step.
