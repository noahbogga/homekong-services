# HOMEKONG Storage & Backup Plan
## Status: PENDING (waiting for hardware upgrade)

## Hardware (planned)
- NVMe (current) — Host Windows Server boot + VM .vhdx files
- 480GB Intel MLC SSD — hk-services OS + containers + cache
- 1.6TB Intel MLC SSD — Active filebrowser data (all roots + personal)
- 800GB Intel MLC SSD (existing) — Backup Tier 1 (fast local snapshots)
- 2x 6TB HDD — Backup Tier 2 (full archives + mirror)

## Disk Allocation

### NVMe (Host)
- Windows Server 2025 boot
- All VM .vhdx files
- Hyper-V checkpoints

### 480GB MLC (hk-services /dev/sda)
- hk-services Ubuntu OS
- Docker images + containers
- Search index, databases
- Resolver temp downloads

### 1.6TB MLC (Active data /dev/sdb)
- /Media root
- /fxMain root
- /fxTest root
- /.userdata (personal storage, all users)
- All filebrowser live data

### 800GB MLC (Backup Tier 1 /dev/sdc)
- Nightly incremental tar.zst of each root
- Weekly VM checkpoint exports
- Quick restore source
- Keep: 7 daily + 4 weekly

### 6TB HDD #1 (Backup Tier 2)
- Monthly full tar.zst of all roots
- Monthly VM .vhdx full copies
- Historical versions (keep 6 months)
- Cold media archive
- **FILE ACCESS / COLD STORAGE ONLY — never run programs or active workloads from HDD**

### 6TB HDD #2 (Mirror)
- Weekly rsync mirror of HDD #1
- Swappable for offsite disaster recovery
- **FILE ACCESS / COLD STORAGE ONLY — never run programs or active workloads from HDD**

## Backup Schedule
- Hourly: Hyper-V checkpoint (auto-rotate, keep 24)
- Nightly: tar.zst incremental per root → 800GB SSD
- Weekly: Full VM export → 6TB HDD #1
- Monthly: Full tar.zst all roots → 6TB HDD #1
- Weekly: Sync HDD #1 → HDD #2

## Format Choice
- File backups: tar.zst (fast, compressed, preserves permissions)
- VM backups: Native Hyper-V export (.vhdx + config)
- NOT ISO (slow, uncompressed, no random file access)

## SSD Cache Strategy (future)
- bcache or dm-cache
- 480GB SSD backs the 6TB HDD for transparent read caching
- Hot files auto-promoted to SSD, cold files stay on HDD

## Notes
- Dynamic VHDX for VMs (grows on demand, don't pre-allocate)
- Personal storage currently on 100GB VHDX at D:\VMs\Storage\personal-storage.vhdx
- Will migrate to 1.6TB SSD when hardware arrives
