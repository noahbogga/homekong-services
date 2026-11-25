# HOMEKONG Drive Setup — macOS (Claude Prompt)

You are setting up WebDAV network drives to the HOMEKONG file server on this Mac. No extra software needed — macOS has native WebDAV support.

## Connection Details

- **WebDAV Server:** `http://192.168.50.247:8443`
- **Username:** homekong
- **Password:** CHANGE_ME
- **Shares:** fxMain, Media, fxTest
- **Web panel:** https://media.homekong.cc (same credentials)

## What to do

### 1. Mount all three drives via AppleScript (most reliable)

```bash
osascript -e 'tell application "Finder"
    mount volume "http://192.168.50.247:8443/fxMain" as user name "homekong" with password "CHANGE_ME"
    mount volume "http://192.168.50.247:8443/Media" as user name "homekong" with password "CHANGE_ME"
    mount volume "http://192.168.50.247:8443/fxTest" as user name "homekong" with password "CHANGE_ME"
end tell'
```

They'll appear in Finder sidebar under Locations.

### 2. Auto-mount on login

Create `~/Library/LaunchAgents/cc.homekong.drives.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>cc.homekong.drives</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/osascript</string>
        <string>-e</string>
        <string>
tell application "Finder"
    delay 10
    try
        mount volume "http://192.168.50.247:8443/fxMain" as user name "homekong" with password "CHANGE_ME"
    end try
    try
        mount volume "http://192.168.50.247:8443/Media" as user name "homekong" with password "CHANGE_ME"
    end try
    try
        mount volume "http://192.168.50.247:8443/fxTest" as user name "homekong" with password "CHANGE_ME"
    end try
end tell
        </string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/homekong-drives.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/homekong-drives.log</string>
</dict>
</plist>
```

Then load it:
```bash
launchctl load ~/Library/LaunchAgents/cc.homekong.drives.plist
```

### 3. Verify

- `/Volumes/fxMain` should show: txData, server, server-data, start.sh, backup.sh
- `/Volumes/Media` should show: files folder, image files
- `/Volumes/fxTest` should show: server, server-data, start.sh, backup.sh

## Manual mount (alternative)

Finder > Go > Connect to Server (⌘K), then enter:
- `http://192.168.50.247:8443/fxMain`
- `http://192.168.50.247:8443/Media`
- `http://192.168.50.247:8443/fxTest`

Enter credentials when prompted: homekong / CHANGE_ME

## Troubleshooting

- **"Connection failed"** → Mac must be on the same LAN (192.168.50.x network)
- **Drives disappear after sleep** → the LaunchAgent re-mounts on login; for sleep recovery, run the osascript command again
- **Slow transfers** → normal for WebDAV over WiFi; wired connection gives full speed
- **"Volume already mounted"** → eject first (right-click in Finder > Eject), then remount

## To unmount

Right-click the volume in Finder sidebar > Eject, or:
```bash
umount /Volumes/fxMain /Volumes/Media /Volumes/fxTest
```

## Notes

- No macFUSE, sshfs, or Homebrew packages required
- Works with any macOS version (10.13+)
- Full Finder integration: drag-and-drop, copy-paste, Quick Look all work
- These are LAN-only mounts (won't work outside the home network)
