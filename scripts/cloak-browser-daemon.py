#!/usr/bin/env python3
"""CloakBrowser daemon — launches stealth Chromium with CDP enabled.

Wraps cloakbrowser.launch_persistent_context with --remote-debugging-port so
the same MCP browser tools that talk to plain Chromium via CDP get a
stealth-patched browser instead. Stays alive until SIGTERM/SIGINT.
"""
import os
import signal
import sys
import time

from cloakbrowser import launch_persistent_context

USER_DATA_DIR = os.environ.get("CLAUDECLAW_BROWSER_PROFILE")
PORT = os.environ.get("CLAUDECLAW_BROWSER_PORT", "9222")
HEADLESS = os.environ.get("CLAUDECLAW_BROWSER_HEADLESS", "0") == "1"

if not USER_DATA_DIR:
    print("CLAUDECLAW_BROWSER_PROFILE env var required", file=sys.stderr)
    sys.exit(1)

print(f"CloakBrowser daemon: profile={USER_DATA_DIR} port={PORT} headless={HEADLESS}", flush=True)

ctx = launch_persistent_context(
    user_data_dir=USER_DATA_DIR,
    headless=HEADLESS,
    args=[
        f"--remote-debugging-port={PORT}",
        "--no-first-run",
        "--no-default-browser-check",
    ],
    stealth_args=True,
)

print(f"CloakBrowser ready on http://localhost:{PORT}", flush=True)

stop = False


def handle_signal(signum, frame):
    global stop
    print(f"Got signal {signum}, shutting down", flush=True)
    stop = True


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

while not stop:
    time.sleep(1)

try:
    ctx.close()
except Exception as e:
    print(f"close error: {e}", flush=True)
