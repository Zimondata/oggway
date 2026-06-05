#!/usr/bin/env bash
# Install + load the host-side qmd vector-search daemon as a launchd agent.
#
# The agent sandbox cannot run `qmd vsearch`/`qmd query` because node-llama-cpp
# fails Metal init inside it. This daemon runs OUTSIDE the sandbox (full Metal
# access) and exposes qmd search over 127.0.0.1:9223, same pattern as the
# browser daemon and the qmd-embed cron. The sandboxed agent reaches it via the
# always-allowed localhost.
#
# Idempotent: re-running rewrites the plist and reloads the service.
set -euo pipefail

PROJECT_DIR="/Users/pine/my-assistant/claudeclaw/claudeclaw"
LABEL="com.claudeclaw.qmd-vsearch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DAEMON="$PROJECT_DIR/groups/personal/memory/scripts/qmd_vsearch_daemon.py"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>$DAEMON</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR/groups/personal</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/pine</string>
        <key>QMD_VSEARCH_PORT</key>
        <string>9223</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/qmd-vsearch.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/qmd-vsearch.error.log</string>
</dict>
</plist>
PLIST_EOF

echo "Wrote $PLIST"

# Reload (bootout first so re-runs pick up changes; ignore error if not loaded)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Loaded $LABEL"
