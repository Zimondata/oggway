/**
 * Sandbox runtime for ClaudeClaw.
 *
 * Uses OS-level sandboxing (Seatbelt on macOS, bubblewrap on Linux) via
 * @anthropic-ai/sandbox-runtime for near-zero-overhead agent execution.
 *
 * Key differences from container-runner.ts:
 * - No container daemon dependency — spawns a sandboxed node process directly
 * - Near-zero overhead (<10ms cold start vs seconds for containers)
 * - Real credentials passed directly + network restricted to allowedDomains
 * - Orphan cleanup via PID files in data/sandbox-pids/
 * - Agent runner pre-compiled on host at agent/runner/dist/index.js
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../orchestrator/env.js';
import {
  getNextKey,
  isPoolConfigured,
} from '../orchestrator/credential-pool.js';
import {
  CODE_ROOT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from '../orchestrator/config.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../orchestrator/group-folder.js';
import { logger } from '../orchestrator/logger.js';
import { validateAdditionalMounts } from '../orchestrator/mount-security.js';
import { RegisteredGroup } from '../orchestrator/types.js';
import {
  getExtensionAllowedDomains,
  getExtensionDeclaredEnvKeys,
} from '../orchestrator/extension-loader.js';
import { getExtensionContainerEnvKeys } from '../orchestrator/extensions.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

const SANDBOX_PID_DIR = path.join(DATA_DIR, 'sandbox-pids');

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

export interface SandboxSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

interface SandboxMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  deny?: boolean;
}

// ---------------------------------------------------------------------------
// Health check & cleanup
// ---------------------------------------------------------------------------

/**
 * Verify that sandbox-runtime is available.
 */
export function ensureSandboxRuntimeAvailable(): void {
  try {
    execFileSync('npx', ['@anthropic-ai/sandbox-runtime', '--version'], {
      stdio: 'pipe',
      timeout: 30000,
    });
    logger.debug('sandbox-runtime is available');
  } catch (err) {
    logger.error({ err }, 'sandbox-runtime not found');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: sandbox-runtime not found                              ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Install: npm install @anthropic-ai/sandbox-runtime            ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('sandbox-runtime is required but not installed');
  }
}

/**
 * Kill orphaned sandbox processes from a previous run using PID files.
 */
export function cleanupSandboxOrphans(): void {
  if (!fs.existsSync(SANDBOX_PID_DIR)) return;

  const pidFiles = fs
    .readdirSync(SANDBOX_PID_DIR)
    .filter((f) => f.endsWith('.pid'));
  const killed: string[] = [];

  for (const file of pidFiles) {
    const pidPath = path.join(SANDBOX_PID_DIR, file);
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (isNaN(pid)) {
        fs.unlinkSync(pidPath);
        continue;
      }
      try {
        process.kill(pid, 0); // existence check
        process.kill(pid, 'SIGTERM');
        killed.push(file.replace('.pid', ''));
      } catch {
        // Process already dead
      }
      fs.unlinkSync(pidPath);
    } catch {
      try {
        fs.unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (killed.length > 0) {
    logger.info(
      { count: killed.length, names: killed },
      'Stopped orphaned sandbox processes',
    );
  }
}

// ---------------------------------------------------------------------------
// Mount building (mirrors container-runner.ts buildVolumeMounts)
// ---------------------------------------------------------------------------

function buildSandboxMounts(
  group: RegisteredGroup,
  isMain: boolean,
): SandboxMount[] {
  const mounts: SandboxMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets project root read-only
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env — deny read/write access to secrets
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: envFile,
        containerPath: '/workspace/project/.env',
        readonly: true,
        deny: true,
      });
    }

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Ensure settings.json exists
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from agent/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'agent', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sandbox needs Claude home dir to be accessible
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const vm of validatedMounts) {
      mounts.push({
        hostPath: vm.hostPath,
        containerPath: vm.containerPath,
        readonly: vm.readonly,
      });
    }
  }

  // Claude Code SDK persists conversation transcripts to
  // $HOME/.claude/projects/<cwd-hash>/<session-id>.jsonl on the host.
  // Without write access the file never lands, and the next turn's
  // `resume: sessionId` fails with "No conversation found", forcing the
  // stale-session retry path and breaking cross-turn context. We also
  // allow read so the SDK can enumerate sessions for picker-style resume.
  const hostHome = os.homedir();
  const claudeProjectsDir = path.join(hostHome, '.claude', 'projects');
  fs.mkdirSync(claudeProjectsDir, { recursive: true });
  mounts.push({
    hostPath: claudeProjectsDir,
    containerPath: 'claude-projects',
    readonly: false,
  });

  // Claude Code's Bash tool writes per-session env files to
  // $HOME/.claude/session-env/<session-uuid>/. Without write access every
  // Bash tool call fails immediately with EPERM on mkdir before the command
  // even runs, making the agent completely non-functional.
  const claudeSessionEnvDir = path.join(hostHome, '.claude', 'session-env');
  fs.mkdirSync(claudeSessionEnvDir, { recursive: true });
  mounts.push({
    hostPath: claudeSessionEnvDir,
    containerPath: 'claude-session-env',
    readonly: false,
  });

  // Claude Code's Bash tool writes per-task output files to
  // /private/tmp/claude-<uid>/<cwd-encoded>/<session-uuid>/tasks/<taskid>.output
  // before returning stdout/stderr to the agent. Without write access every
  // Bash call fails with EPERM on the .output file, making the agent completely
  // non-functional (sqlite3, ls, everything blocked identically).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const claudeTmpDir = `/private/tmp/claude-${uid}`;
  fs.mkdirSync(claudeTmpDir, { recursive: true });
  mounts.push({
    hostPath: claudeTmpDir,
    containerPath: 'claude-tmp',
    readonly: false,
  });

  return mounts;
}

// ---------------------------------------------------------------------------
// Settings & args builders
// ---------------------------------------------------------------------------

/**
 * Build sandbox settings from mounts and optional extra allowed domains.
 *
 * Network domains are layered:
 *   1. Base (always): api.anthropic.com, *.anthropic.com, localhost, 127.0.0.1
 *   2. Extra: from agentConfig.allowedDomains (per-group) and extension manifests
 *
 * Duplicates are removed automatically.
 */
export function buildSandboxSettings(
  mounts: SandboxMount[],
  extraAllowedDomains: string[] = [],
  extraAllowedWritePaths: string[] = [],
): SandboxSettings {
  const denyRead: string[] = [];
  const allowRead: string[] = [];
  const allowWrite: string[] = [];
  const denyWrite: string[] = [];

  for (const mount of mounts) {
    if (mount.deny) {
      denyRead.push(mount.hostPath);
      denyWrite.push(mount.hostPath);
    } else if (mount.readonly) {
      allowRead.push(mount.hostPath);
    } else {
      // read-write
      allowWrite.push(mount.hostPath);
    }
  }

  // Per-group extra write paths (e.g. backup dirs outside the workspace).
  // Deduplicate against mount-derived allowWrite entries.
  for (const p of extraAllowedWritePaths) {
    if (!allowWrite.includes(p)) allowWrite.push(p);
  }

  // Merge base + extra domains, deduplicate
  const baseDomains = [
    'api.anthropic.com',
    '*.anthropic.com',
    'localhost',
    '127.0.0.1',
    // Third-party APIs reachable through built-in MCP tools / scripts.
    'api.brightdata.com',
    'api.twitter.com',
    'api.x.com',
  ];
  const allDomains = [...new Set([...baseDomains, ...extraAllowedDomains])];

  return {
    network: {
      allowedDomains: allDomains,
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
    },
  };
}

export function buildSandboxArgs(settingsPath: string): string[] {
  // Sandbox runs the pre-compiled agent-runner directly on the host.
  // Build with: cd agent/runner && npx tsc
  // Agent runner lives in the CODE root, not the data/state root.
  const agentRunnerPath = path.join(
    CODE_ROOT,
    'agent',
    'runner',
    'dist',
    'index.js',
  );

  return [
    'npx',
    '@anthropic-ai/sandbox-runtime',
    '--settings',
    settingsPath,
    '--',
    'node',
    agentRunnerPath,
  ];
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runSandboxAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `claudeclaw-sandbox-${safeName}-${Date.now()}`;

  // Build mounts and srt settings
  const mounts = buildSandboxMounts(group, input.isMain);
  const settingsDir = path.join(DATA_DIR, 'sandbox-settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, `${processName}.json`);
  // Merge domains: extension manifests + per-group agentConfig
  const extensionDomains = getExtensionAllowedDomains();
  const groupDomains = group.agentConfig?.allowedDomains ?? [];
  const extraDomains = [...extensionDomains, ...groupDomains];
  const extraWritePaths = group.agentConfig?.allowedWritePaths ?? [];
  const settings = buildSandboxSettings(mounts, extraDomains, extraWritePaths);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const sandboxArgs = buildSandboxArgs(settingsPath);

  logger.info(
    {
      group: group.name,
      processName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning sandbox agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve_) => {
    // Guard against double-resolve: both 'close' and 'error' can fire.
    let resolved = false;
    const resolve = (value: ContainerOutput) => {
      if (resolved) return;
      resolved = true;
      resolve_(value);
    };
    // Map container paths to host paths via env vars
    const pathEnv: Record<string, string> = {};
    for (const mount of mounts) {
      if (mount.containerPath === '/workspace/group')
        pathEnv.CLAUDECLAW_GROUP_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/ipc')
        pathEnv.CLAUDECLAW_IPC_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/project' && !mount.deny)
        pathEnv.CLAUDECLAW_PROJECT_DIR = mount.hostPath;
      else if (mount.containerPath === '/workspace/global')
        pathEnv.CLAUDECLAW_GLOBAL_DIR = mount.hostPath;
      else if (mount.containerPath?.startsWith('/workspace/extra'))
        pathEnv.CLAUDECLAW_EXTRA_DIR = mount.hostPath;
    }

    // Sandbox: real credentials + restricted network (no proxy needed)
    const secrets = readEnvFile([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ]);

    // Credential pool: if multiple ANTHROPIC keys are configured, pick one
    // round-robin (with sticky window) and use it instead of the single env.
    // Falls through to single-key/oauth behaviour when pool is empty.
    let pooledKey: { value: string; label: string } | null = null;
    if (isPoolConfigured()) {
      pooledKey = getNextKey();
      if (pooledKey) {
        secrets.ANTHROPIC_API_KEY = pooledKey.value;
      }
    }

    // If no auth is set in .env, fall back to macOS Keychain (where `claude
    // setup-token` / login stores the OAuth access token). Setting an empty
    // CLAUDE_CODE_OAUTH_TOKEN=''  here overrides the CLI's own keychain
    // lookup and produces a 401.
    //
    // Keychain tokens expire (typically every 8h). Inside the sandbox,
    // `claude` CLI can't refresh (it reads keychain and here it's locked
    // by Seatbelt). So if the token is stale or close to it, we trigger
    // a refresh in the parent by making any Claude API call, which forces
    // the CLI to rotate the token in keychain. Then we pass the fresh one.
    let keychainToken: string | undefined;
    if (
      !secrets.ANTHROPIC_API_KEY &&
      !secrets.CLAUDE_CODE_OAUTH_TOKEN &&
      !secrets.ANTHROPIC_AUTH_TOKEN
    ) {
      const readKeychain = (): { token?: string; expiresAt?: number } => {
        try {
          const raw = execFileSync(
            'security',
            ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
            { encoding: 'utf-8' },
          ).trim();
          const parsed = JSON.parse(raw);
          return {
            token: parsed?.claudeAiOauth?.accessToken,
            expiresAt: parsed?.claudeAiOauth?.expiresAt,
          };
        } catch {
          return {};
        }
      };

      let { token, expiresAt } = readKeychain();
      const bufferMs = 5 * 60 * 1000; // refresh if <5 min remaining
      if (token && expiresAt && expiresAt - Date.now() < bufferMs) {
        logger.info(
          { expiresIn: Math.round((expiresAt - Date.now()) / 1000) },
          'Claude OAuth token expiring soon, forcing refresh',
        );
        try {
          execFileSync(
            'claude',
            ['-p', 'ok', '--output-format', 'text', '--max-turns', '1'],
            {
              stdio: 'pipe',
              timeout: 20000,
            },
          );
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Token refresh attempt failed',
          );
        }
        const refreshed = readKeychain();
        token = refreshed.token ?? token;
      }
      keychainToken = token;
    }

    const authEnv: Record<string, string> = secrets.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY }
      : secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN
        ? {
            CLAUDE_CODE_OAUTH_TOKEN:
              secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN!,
          }
        : keychainToken
          ? { CLAUDE_CODE_OAUTH_TOKEN: keychainToken }
          : {};

    // Build minimal env — only what the sandbox process actually needs.
    // Spreading process.env would leak HOME, SSH_AUTH_SOCK, AWS keys, etc.
    const safeEnvKeys = [
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'LANG',
      'LC_ALL',
      'TERM',
      'NODE_PATH',
      'NODE_OPTIONS',
      'NPM_CONFIG_PREFIX',
      'TMPDIR',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME',
      // Third-party API credentials passed through to the agent so MCP tools
      // (web_unlock, twitter_*) and helper scripts can use them.
      'TWITTER_API_KEY',
      'TWITTER_API_SECRET',
      'TWITTER_ACCESS_TOKEN',
      'TWITTER_ACCESS_TOKEN_SECRET',
      'TWITTER_BEARER_TOKEN',
      'BRIGHTDATA_API_TOKEN',
      'BRIGHTDATA_ZONE',
      // Wiki tools - Karpathy LLM Wiki pattern, vault root for wiki_read/search/index MCP
      'VAULT_ROOT',
      'OBSIDIAN_VAULT',
      // Extension-declared env keys: code-registered (registerExtension) and
      // manifest-declared (provides.envKeys, for prompt-only extensions).
      ...getExtensionContainerEnvKeys(),
      ...getExtensionDeclaredEnvKeys(),
    ];
    const filteredEnv: Record<string, string> = {};
    for (const key of safeEnvKeys) {
      if (process.env[key]) filteredEnv[key] = process.env[key]!;
    }

    // detached: true puts the child in its own process group. This lets the
    // watchdog SIGKILL the entire group (-pgid) when it trips, instead of just
    // the npm wrapper while srt + runner orphan.
    const child = spawn(sandboxArgs[0], sandboxArgs.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...filteredEnv,
        TZ: TIMEZONE,
        ...authEnv,
        ...pathEnv,
      },
    });

    // Write PID file for orphan cleanup
    fs.mkdirSync(SANDBOX_PID_DIR, { recursive: true });
    const pidFile = path.join(SANDBOX_PID_DIR, `${processName}.pid`);
    if (child.pid) {
      fs.writeFileSync(pidFile, String(child.pid));
    }

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let hadStreamingOutput = false;
    let newSessionId: string | undefined;

    try {
      child.stdin!.write(JSON.stringify(input));
      child.stdin!.end();
    } catch (err) {
      logger.error(
        { err, group: group.name },
        'Failed to write to sandbox stdin',
      );
      return resolve({
        status: 'error',
        result: null,
        error: `Failed to write input to sandbox process: ${err}`,
      });
    }

    // Timeout handling — declared before event handlers so closures can reference them
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Sandbox timeout, killing',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Streaming output parsing
    let parseBuffer = '';
    let outputChain = Promise.resolve();

    child.stdout!.on('data', (data) => {
      const chunk = data.toString();

      // Accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Sandbox stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.warn(
                  { err, group: group.name },
                  'onOutput handler threw during streaming',
                );
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse sandbox output chunk',
            );
          }
        }
      }
    });

    child.stderr!.on('data', (data) => {
      const chunk = data.toString();
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ sandbox: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Sandbox stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      // Clean up PID and settings files
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* ignore */
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Sandbox timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        logger.error(
          { group: group.name, processName, duration, code },
          'Sandbox timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Sandbox timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr },
          'Sandbox exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Sandbox exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        outputChain.then(() => {
          // Silent-death detection: process exited cleanly (code 0) but never
          // emitted a streaming output. Treat as error so the orchestrator
          // rolls back the cursor and retries instead of marking success.
          if (!hadStreamingOutput) {
            logger.error(
              {
                group: group.name,
                duration,
                code,
                processName,
                stderrTail: stderr.slice(-500),
              },
              'Sandbox exited with code 0 but produced no output (silent death)',
            );
            resolve({
              status: 'error',
              result: null,
              error: `Sandbox exited code=0 with no output. stderr tail: ${stderr.slice(-300)}`,
            });
            return;
          }
          logger.info(
            { group: group.name, duration, newSessionId },
            'Sandbox completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        resolve(JSON.parse(jsonLine));
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse sandbox output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(settingsPath);
      } catch {
        /* ignore */
      }
      resolve({
        status: 'error',
        result: null,
        error: `Sandbox spawn error: ${err.message}`,
      });
    });
  });
}
