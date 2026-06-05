/**
 * ClaudeClaw Service — Background orchestrator entry point.
 * Run by launchd (macOS) or systemd (Linux) as a persistent service.
 *
 * This is the process that polls for messages, spawns agents, and routes responses.
 * Start with: node dist/service.js
 * Dev mode:   npx tsx src/service.ts
 *
 * The working directory IS the instance — all state (store/, groups/, .env)
 * lives in cwd. Multiple instances = multiple directories.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { loadExtensions } from './orchestrator/extension-loader.js';

/**
 * Start the browser daemon (Chromium with CDP) from the parent service process.
 *
 * Why here: agents run inside the srt sandbox, which denies the Mach port
 * bootstrap_check_in that Chromium needs to launch (FATAL ... Permission denied
 * 1100). The daemon must be spawned by the unsandboxed service process so it has
 * full network/OS access; the agent then connects to it over CDP on localhost.
 *
 * scripts/browser-daemon.sh is idempotent (no-op if already running) and exits
 * non-zero with a clear message if no Chromium binary is installed — so calling
 * it unconditionally on startup is safe. Failure never blocks the service.
 */
function startBrowserDaemon(): void {
  try {
    // import.meta.url points to dist/service.js; the repo root is one level up.
    const codeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const script = path.join(codeRoot, 'scripts', 'browser-daemon.sh');
    if (!fs.existsSync(script)) {
      console.warn(`[service] browser daemon script not found at ${script}, skipping autostart`);
      return;
    }
    const child = spawn('bash', [script, 'start'], { cwd: codeRoot });
    child.stdout?.on('data', (d) => process.stdout.write(`[browser-daemon] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`[browser-daemon] ${d}`));
    child.on('error', (err) => {
      console.error('[service] failed to spawn browser daemon:', err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    console.error('[service] browser daemon autostart error:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Auto-watchdog for stale sandbox runners (zombies).
 *
 * Symptom: agent runner processes (`agent/runner/dist/index.js` and the srt /
 * npm-exec wrappers around them) sit idle at 0% CPU long after the orchestrator
 * has logged "Sandbox completed". They hold the GroupQueue slot via state.process
 * and stall user messages.
 *
 * Safety net: any runner-tree process older than 480s with 0% CPU AND no
 * established outbound TCP connection gets its process group SIGKILL'd.
 * The TCP check distinguishes "actually waiting on API" from "truly zombie".
 *
 * NOTE: this watchdog was wiped during a bot self-edit. Restored here.
 */
function startStaleRunnerWatchdog(): void {
  const STALE_THRESHOLD_SECS = 1200; // 20 min — opus runs legitimately take 10-15 min
  const PROC_PATTERN = 'agent/runner/dist/index.js';

  const parseEtime = (s: string): number => {
    const [days, time] = s.includes('-') ? s.split('-') : ['0', s];
    const parts = time.split(':').reverse().map((x) => parseInt(x, 10) || 0);
    return parseInt(days, 10) * 86400 + (parts[2] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[0] || 0);
  };

  const hasActiveTcp = (pid: number): boolean => {
    try {
      const out = execSync(`lsof -p ${pid} -iTCP -nP 2>/dev/null | grep ESTABLISHED || true`, {
        encoding: 'utf-8',
      });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  };

  setInterval(() => {
    try {
      const out = execSync(
        `ps -axo pid,pcpu,etime,command | grep "${PROC_PATTERN}" | grep -v grep || true`,
        { encoding: 'utf-8' },
      );
      const killed: number[] = [];
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d:-]+)\s+/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const cpu = parseFloat(m[2]);
        const ageSec = parseEtime(m[3]);
        if (ageSec < STALE_THRESHOLD_SECS) continue;
        if (cpu > 0.5) continue;
        if (hasActiveTcp(pid)) continue;
        try {
          const pgidRaw = execSync(`ps -o pgid= -p ${pid}`, { encoding: 'utf-8' }).trim();
          const pgid = parseInt(pgidRaw, 10);
          if (pgid > 0) {
            process.kill(-pgid, 'SIGKILL');
            killed.push(pgid);
          }
        } catch {
          // already gone
        }
      }
      if (killed.length > 0) {
        console.warn(
          `[stale-runner-watchdog] SIGKILL'd ${killed.length} stale runner process group(s): ${killed.join(', ')} (older than ${STALE_THRESHOLD_SECS}s, 0% CPU, no active TCP)`,
        );
      }
    } catch {
      // tolerate any ps/kill error — try again next tick
    }
  }, 60_000);
}

const PID_FILE = path.join(process.cwd(), 'store', 'service.pid');
const LOCK_SOCKET = path.join(process.cwd(), 'store', 'service.lock');

/**
 * Acquire an exclusive service lock using a Unix domain socket.
 *
 * Unlike PID-file locks, socket bind() is atomic at the OS level:
 * two processes cannot bind the same path simultaneously.
 * When the process dies (even SIGKILL), the socket becomes stale
 * (connect returns ECONNREFUSED), and the next instance can reclaim it.
 */
async function acquireServiceLock(): Promise<void> {
  try { fs.mkdirSync(path.dirname(LOCK_SOCKET), { recursive: true }); } catch {}

  const tryListen = (): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(LOCK_SOCKET, () => { srv.removeAllListeners('error'); resolve(srv); });
    });

  const isSocketAlive = (): Promise<boolean> =>
    new Promise((resolve) => {
      const probe = net.createConnection({ path: LOCK_SOCKET });
      probe.on('connect', () => { probe.end(); resolve(true); });
      probe.on('error', () => resolve(false));
    });

  let lockServer: net.Server;
  try {
    lockServer = await tryListen();
  } catch (err: any) {
    if (err.code !== 'EADDRINUSE') throw err;
    // Socket file exists - check if another instance is alive
    if (await isSocketAlive()) {
      console.error('[service] another ClaudeClaw instance is running, exiting');
      process.exit(0);
    }
    // Stale socket from dead process - clean up and retry once
    try { fs.unlinkSync(LOCK_SOCKET); } catch {}
    try {
      lockServer = await tryListen();
    } catch {
      console.error('[service] failed to acquire lock after stale cleanup, exiting');
      process.exit(0);
    }
  }

  lockServer!.unref(); // Don't keep process alive just for the lock

  // PID file for monitoring/debugging (not used for locking)
  fs.writeFileSync(PID_FILE, String(process.pid));

  const cleanup = () => {
    try {
      const v = fs.readFileSync(PID_FILE, 'utf-8').trim();
      if (Number(v) === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
    try { fs.unlinkSync(LOCK_SOCKET); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

async function start(): Promise<void> {
  await acquireServiceLock();
  startStaleRunnerWatchdog();
  startBrowserDaemon();
  // Load built-in channels (self-registering on import)
  // Slack, Telegram, WhatsApp are now installable extensions
  try {
    await import('./channels/index.js');
  } catch (err) {
    console.error('[service] failed to load channels:', err instanceof Error ? err.message : String(err));
  }

  // Load built-in extensions (always present in core)
  const builtinExtensions = ['./cost-tracking/index.js', './skill-registry/index.js', './webhook/index.js'];
  for (const ext of builtinExtensions) {
    try {
      await import(ext);
    } catch (err) {
      console.error(`[service] failed to load built-in extension ${ext}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Load installable extensions from extensions/ directory
  try {
    await loadExtensions();
  } catch (err) {
    console.error('[service] failed to load installable extensions:', err instanceof Error ? err.message : String(err));
  }

  // Initialise credential pool (round-robin between API keys when configured)
  const { initCredentialPool } = await import('./orchestrator/credential-pool.js');
  initCredentialPool();

  // Start the orchestrator
  const { main } = await import('./orchestrator/message-loop.js');
  await main();
}

// Prevent silent death from unhandled rejections. Node 15+ exits on these
// by default. Log them loudly so the cause appears in claudeclaw.error.log.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[service] UNHANDLED REJECTION:', reason);
  console.error('[service] Promise:', promise);
  // Don't exit — let the service keep running. The polling loop has its own
  // try/catch and will recover. Exiting here would leave the service down
  // until launchd restarts it (and PID file issues can delay that further).
});

process.on('uncaughtException', (err) => {
  console.error('[service] UNCAUGHT EXCEPTION:', err);
  // For uncaught exceptions, exit after logging — state may be corrupted.
  // launchd KeepAlive will restart us.
  process.exit(1);
});

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
