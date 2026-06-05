#!/usr/bin/env bash
# Browser daemon — long-running Chromium with CDP enabled.
#
# Lives outside the agent sandbox so it has full network access.
# The agent (running in srt sandbox) connects to it over localhost
# via CDP through the browser MCP server, so the agent itself stays
# network-restricted while the browser can reach any site.
#
# Usage:
#   ./scripts/browser-daemon.sh start    Launch Chromium in background
#   ./scripts/browser-daemon.sh stop     Kill the running daemon
#   ./scripts/browser-daemon.sh status   Show whether it's running
#   ./scripts/browser-daemon.sh foreground  Run in current shell (debug)
#
# Login state, cookies, and extensions live in data/browser-profile/.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_DATA_DIR="$ROOT_DIR/data/browser-profile"
PID_FILE="$ROOT_DIR/data/browser-daemon.pid"
LOG_FILE="$ROOT_DIR/logs/browser-daemon.log"
PORT="${CLAUDECLAW_BROWSER_PORT:-9222}"

mkdir -p "$USER_DATA_DIR" "$ROOT_DIR/logs"

find_chromium() {
  # Prefer Playwright's bundled Chromium (full CDP feature support).
  # Apple Silicon stores it under chrome-mac-arm64/Google Chrome for Testing.app;
  # x86 macOS uses chrome-mac/Chromium.app. System Google Chrome is a last
  # resort because its CDP rejects Browser.setDownloadBehavior, which
  # playwright.connectOverCDP issues on connect.
  local candidate
  for candidate in \
    "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/Google\ Chrome\ for\ Testing.app/Contents/MacOS/Google\ Chrome\ for\ Testing \
    "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium \
    "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium \
    "$ROOT_DIR/node_modules/playwright-core/.local-browsers"/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium \
    "$ROOT_DIR/node_modules/playwright-core/.local-browsers"/chromium-*/chrome-mac-arm64/Google\ Chrome\ for\ Testing.app/Contents/MacOS/Google\ Chrome\ for\ Testing \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE")
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

cmd_status() {
  if is_running; then
    echo "Browser daemon running (pid $(cat "$PID_FILE"), port $PORT)"
    echo "User data dir: $USER_DATA_DIR"
  else
    echo "Browser daemon NOT running"
    return 1
  fi
}

cmd_stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "No PID file — daemon not running"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
    echo "Stopped browser daemon (pid $pid)"
  else
    echo "Daemon was already stopped"
  fi
  rm -f "$PID_FILE"
}

launch_args() {
  printf '%s\n' \
    "--remote-debugging-port=$PORT" \
    "--user-data-dir=$USER_DATA_DIR" \
    "--no-first-run" \
    "--no-default-browser-check" \
    "--disable-blink-features=AutomationControlled" \
    "about:blank"
}

has_cloakbrowser() {
  [ "${CLAUDECLAW_BROWSER_NO_CLOAK:-0}" = "1" ] && return 1
  python3 -c "import cloakbrowser" 2>/dev/null
}

cmd_start() {
  if is_running; then
    echo "Browser daemon already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  if has_cloakbrowser; then
    echo "Starting CloakBrowser daemon (stealth Chromium)"
    CLAUDECLAW_BROWSER_PROFILE="$USER_DATA_DIR" \
    CLAUDECLAW_BROWSER_PORT="$PORT" \
      nohup python3 "$ROOT_DIR/scripts/cloak-browser-daemon.py" \
        >>"$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" >"$PID_FILE"
    sleep 3
    if kill -0 "$pid" 2>/dev/null; then
      echo "CloakBrowser started (pid $pid, CDP on http://localhost:$PORT)"
      echo "Log: $LOG_FILE"
      return 0
    else
      echo "ERROR: CloakBrowser daemon failed to start. See $LOG_FILE" >&2
      rm -f "$PID_FILE"
      return 1
    fi
  fi
  local chromium
  if ! chromium=$(find_chromium); then
    echo "ERROR: no Chromium binary found." >&2
    echo "  Try: npx playwright install chromium" >&2
    echo "  Or: pip3 install cloakbrowser && python3 -m cloakbrowser install" >&2
    return 1
  fi
  echo "Starting browser daemon: $chromium"
  # Detach via nohup so the daemon survives the shell.
  # shellcheck disable=SC2046
  nohup "$chromium" $(launch_args) >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "Daemon started (pid $pid, CDP on http://localhost:$PORT)"
    echo "Log: $LOG_FILE"
    echo "First time? Open Chromium window, log into the sites you want."
    echo "Subsequent runs reuse the cookies in $USER_DATA_DIR."
  else
    echo "ERROR: daemon failed to start. See $LOG_FILE" >&2
    rm -f "$PID_FILE"
    return 1
  fi
}

cmd_foreground() {
  if is_running; then
    echo "Daemon already running in background. Stop it first: $0 stop" >&2
    return 1
  fi
  local chromium
  if ! chromium=$(find_chromium); then
    echo "ERROR: no Chromium binary found." >&2
    return 1
  fi
  echo "Running in foreground. Ctrl-C to stop."
  # shellcheck disable=SC2046
  exec "$chromium" $(launch_args)
}

case "${1:-status}" in
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status "$@" ;;
  foreground|fg) cmd_foreground "$@" ;;
  restart) cmd_stop "$@" || true; cmd_start "$@" ;;
  *)
    echo "Usage: $0 {start|stop|status|restart|foreground}" >&2
    exit 1
    ;;
esac
