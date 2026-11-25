# HOMEKONG Drive Setup — Instructions for Claude CLI

You are setting up SSHFS drive mounts to the HOMEKONG file server on this Windows PC.

## What to do

1. Install WinFsp and SSHFS-Win (if not already installed)
2. Generate an SSH key for this machine
3. Register the key with the file server
4. Mount three drives: W: (fxMain), X: (Media), Y: (fxTest)
5. Add auto-mount to startup

## Connection Details

- **SFTP Server:** direct.homekong.cc
- **Port:** 2022
- **Username:** homekong
- **Password:** CHANGE_ME
- **Web panel:** https://files.homekong.cc (same credentials)

## Step-by-step

### 1. Install WinFsp
Download and install silently:
```
https://github.com/winfsp/winfsp/releases/download/v2.0/winfsp-2.0.23075.msi
```
Check if already installed: `C:\Program Files (x86)\WinFsp\bin\launcher-x64.exe` exists.

### 2. Install SSHFS-Win
Download and install silently:
```
https://github.com/winfsp/sshfs-win/releases/download/v3.7.21011/sshfs-win-3.7.21011-x64.msi
```
Check if already installed: `C:\Program Files\SSHFS-Win\bin\sshfs-win.exe` exists.

### 3. Generate SSH key
Generate an ed25519 key at `%USERPROFILE%\.ssh\homekong_key` (no passphrase).
Then register it with the server API:

```
POST http://direct.homekong.cc:8090/api/v2/user/token
Authorization: Basic <base64 of user:password>
→ returns access_token

PUT http://direct.homekong.cc:8090/api/v2/user/publickeys
Authorization: Bearer <token>
Content-Type: application/json
Body: ["<contents of homekong_key.pub>"]
```

### 4. Mount drives
Run these commands (use the generated key):
```
"C:\Program Files\SSHFS-Win\bin\sshfs-win.exe" cmd "homekong@direct.homekong.cc:/fxMain" "W:" -p 2022 -o IdentityFile="%USERPROFILE%\.ssh\homekong_key" -o StrictHostKeyChecking=no
"C:\Program Files\SSHFS-Win\bin\sshfs-win.exe" cmd "homekong@direct.homekong.cc:/Media" "X:" -p 2022 -o IdentityFile="%USERPROFILE%\.ssh\homekong_key" -o StrictHostKeyChecking=no
"C:\Program Files\SSHFS-Win\bin\sshfs-win.exe" cmd "homekong@direct.homekong.cc:/fxTest" "Y:" -p 2022 -o IdentityFile="%USERPROFILE%\.ssh\homekong_key" -o StrictHostKeyChecking=no
```

### 5. Auto-mount on startup
Create a batch file in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\homekong-drives.bat` with:
```batch
@echo off
timeout /t 10 /nobreak >nul
"C:\Program Files\SSHFS-Win\bin\sshfs-win.exe" cmd "homekong@direct.homekong.cc:/fxMain" "W:" -p 2022 -o IdentityFile="%USERPROFILE%\.ssh\homekong_key" -o StrictHostKeyChecking=no
"C:\Program Files\SSHFS-Win\bin\sshfs-win.exe" cmd "homekong@direct.homekong.cc:/Media" "X:" -p 2022 -o IdentityFile="%USERPROFILE%\.ssh\homekong_key" -o StrictHostKeyChecking=no
"C:\Program Files\SSHFS-Win\bin\sshfs-win.exe" cmd "homekong@direct.homekong.cc:/fxTest" "Y:" -p 2022 -o IdentityFile="%USERPROFILE%\.ssh\homekong_key" -o StrictHostKeyChecking=no
```

## Verification
After mounting, confirm:
- `W:\` shows: backup.sh, restore.sh, server, server-data, start.sh, txData
- `X:\` shows: image files and a "files" folder
- `Y:\` shows: backup.sh, restore.sh, server, server-data, start.sh (no txData)

## Notes
- Requires admin (elevated) PowerShell to install MSIs
- If W:/X:/Y: are already in use, pick different letters
- The web panel at https://files.homekong.cc works from any browser with the same credentials
- If direct.homekong.cc times out, the server may be restarting — wait a few minutes
