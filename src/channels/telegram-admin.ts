/**
 * Telegram admin commands handled directly by the orchestrator.
 *
 * These run in the service process (outside the sandbox) and deliberately
 * bypass the agent. They exist for the case where the agent itself is
 * unhealthy — auth broken, sandbox hung, etc. — so the user can still
 * restart, inspect logs, or roll back from inside Telegram.
 *
 * Access control: ADMIN_TELEGRAM_USER_ID env var (numeric Telegram user
 * id). Only messages from that user are executed. If unset, admin is
 * disabled.
 *
 * Commands:
 *   /status         — service PID, uptime, pending retries, session id
 *   /logs [N]       — last N log lines (default 30)
 *   /restart        — launchctl kickstart (macOS) / systemctl restart (linux)
 *   /revert         — git revert HEAD + rebuild + restart (undo last fixer)
 *   /push           — git push origin main (user must have gh auth)
 *   /clear-session  — DELETE FROM sessions (forces fresh session next turn)
 *   /shell <cmd>    — run arbitrary shell (DANGER — logs the command)
 *   /help           — list commands
 */
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from '../orchestrator/env.js';
import { LOG_DIR, STATE_ROOT, STORE_DIR } from '../orchestrator/config.js';
import { logger } from '../orchestrator/logger.js';

const execFileAsync = promisify(execFile);

const ADMIN_USER_ID = (() => {
  const env = readEnvFile(['ADMIN_TELEGRAM_USER_ID']);
  const id = env.ADMIN_TELEGRAM_USER_ID || process.env.ADMIN_TELEGRAM_USER_ID;
  return id ? String(id).trim() : '';
})();

export function isAdminCommand(text: string): boolean {
  return text.startsWith('/') && /^\/(status|logs|restart|revert|push|clear-session|shell|help)\b/i.test(text);
}

export function isAdminSender(senderId: string): boolean {
  return ADMIN_USER_ID !== '' && senderId === ADMIN_USER_ID;
}

async function runCmd(bin: string, args: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || err.message || String(err),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

function getServiceLabel(): string {
  const dirName = path.basename(STATE_ROOT).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `com.claudeclaw.${dirName}`;
}

async function cmdStatus(): Promise<string> {
  const label = getServiceLabel();
  const lines: string[] = [];

  if (process.platform === 'darwin') {
    const { stdout } = await runCmd('launchctl', ['list'], 5000);
    const line = stdout.split('\n').find((l) => l.includes(label));
    lines.push(line ? `service: ${line.trim()}` : `service: NOT LOADED (${label})`);
  } else {
    const { stdout } = await runCmd('systemctl', ['--user', 'is-active', `claudeclaw-${path.basename(STATE_ROOT)}`], 5000);
    lines.push(`service: ${stdout.trim()}`);
  }

  lines.push(`uptime (service PID): ${process.pid}, started ${new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()}`);

  // DB stats
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(STORE_DIR, 'messages.db'), { readonly: true });
    const sessions = db.prepare('SELECT group_folder, session_id FROM sessions').all() as Array<{ group_folder: string; session_id: string }>;
    const groups = db.prepare('SELECT COUNT(*) as n FROM registered_groups').get() as { n: number };
    const tasks = db.prepare("SELECT COUNT(*) as n FROM scheduled_tasks WHERE status='active'").get() as { n: number };
    const recentRuns = db.prepare("SELECT COUNT(*) as n FROM agent_runs WHERE run_at > datetime('now', '-1 day')").get() as { n: number };
    db.close();
    lines.push(`groups: ${groups.n}, active tasks: ${tasks.n}, runs last 24h: ${recentRuns.n}`);
    for (const s of sessions) {
      lines.push(`session ${s.group_folder}: ${s.session_id.slice(0, 8)}…`);
    }
  } catch (err) {
    lines.push(`db: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Git state
  try {
    const { stdout: branch } = await runCmd('git', ['-C', STATE_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], 5000);
    const { stdout: head } = await runCmd('git', ['-C', STATE_ROOT, 'log', '-1', '--oneline'], 5000);
    const { stdout: dirty } = await runCmd('git', ['-C', STATE_ROOT, 'status', '--porcelain'], 5000);
    lines.push(`git ${branch.trim()}: ${head.trim()}${dirty.trim() ? ' [dirty]' : ''}`);
  } catch {
    /* not a git repo */
  }

  return lines.join('\n');
}

async function cmdLogs(nStr: string): Promise<string> {
  const n = Math.max(1, Math.min(500, parseInt(nStr || '30', 10) || 30));
  const logFile = path.join(LOG_DIR, 'claudeclaw.log');
  if (!fs.existsSync(logFile)) return 'no log file';
  const { stdout } = await runCmd('tail', ['-n', String(n), logFile], 10000);
  // strip ANSI escapes and pino color codes for clean Telegram render
  const clean = stdout.replace(/\u001B\[[0-9;]*m/g, '');
  return clean.length > 3500 ? clean.slice(-3500) + '\n[...truncated...]' : clean;
}

async function cmdRestart(): Promise<string> {
  if (process.platform === 'darwin') {
    const { stdout, stderr, code } = await runCmd('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() || 501}/${getServiceLabel()}`], 15000);
    return code === 0 ? `restart triggered: ${getServiceLabel()}` : `restart failed (${code}): ${stderr || stdout}`;
  }
  const unit = `claudeclaw-${path.basename(STATE_ROOT)}`;
  const { stdout, stderr, code } = await runCmd('systemctl', ['--user', 'restart', unit], 15000);
  return code === 0 ? `restart triggered: ${unit}` : `restart failed (${code}): ${stderr || stdout}`;
}

async function cmdRevert(): Promise<string> {
  const { stdout: head, code: codeHead } = await runCmd('git', ['-C', STATE_ROOT, 'log', '-1', '--oneline'], 5000);
  if (codeHead !== 0) return 'not a git repo';
  const { stdout: out, stderr: err, code } = await runCmd('git', ['-C', STATE_ROOT, 'revert', '--no-edit', 'HEAD'], 15000);
  if (code !== 0) return `revert failed (${code}):\n${err || out}`;
  const { code: buildCode, stderr: buildErr } = await runCmd('npm', ['--prefix', STATE_ROOT, 'run', 'build'], 120000);
  if (buildCode !== 0) return `revert ok but build failed:\n${buildErr.slice(-500)}\n\nrun /restart manually once fixed`;
  const restartMsg = await cmdRestart();
  return `reverted "${head.trim()}"\nbuild ok\n${restartMsg}`;
}

async function cmdPush(): Promise<string> {
  const { stdout, stderr, code } = await runCmd('git', ['-C', STATE_ROOT, 'push', 'origin', 'main'], 45000);
  if (code === 0) return `pushed to origin/main\n${stdout.trim() || stderr.trim()}`;
  return `push failed (${code}):\n${stderr || stdout}`.slice(0, 1500);
}

async function cmdClearSession(): Promise<string> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(STORE_DIR, 'messages.db'));
    const res = db.prepare('DELETE FROM sessions').run();
    db.close();
    return `cleared ${res.changes} session(s). next agent turn starts fresh.`;
  } catch (err) {
    return `clear failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function cmdShell(cmd: string): Promise<string> {
  if (!cmd.trim()) return 'usage: /shell <command>';
  logger.warn({ cmd, admin: true }, '[ADMIN] executing shell command');
  const { stdout, stderr, code } = await runCmd('/bin/bash', ['-c', cmd], 60000);
  const out = (stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '')).trim();
  const head = `exit ${code}\n\n`;
  return (head + out).slice(0, 3500);
}

const HELP_TEXT = `Admin commands (orchestrator-level, работают даже если агент мёртв):

/status                — сервис / БД / git / сессии
/logs [N=30]           — последние N строк лога
/restart               — kickstart сервиса
/revert                — git revert HEAD + rebuild + restart (откатить последний фикс)
/push                  — git push origin main
/clear-session         — DELETE FROM sessions (свежая сессия следующему turn)
/shell <cmd>           — запустить bash команду
/help                  — этот список

Требует ADMIN_TELEGRAM_USER_ID=<your_tg_id> в .env.`;

export async function handleAdminCommand(text: string): Promise<string> {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = trimmed.slice(parts[0].length).trim();
  try {
    if (cmd === '/status') return await cmdStatus();
    if (cmd === '/logs') return await cmdLogs(rest);
    if (cmd === '/restart') return await cmdRestart();
    if (cmd === '/revert') return await cmdRevert();
    if (cmd === '/push') return await cmdPush();
    if (cmd === '/clear-session') return await cmdClearSession();
    if (cmd === '/shell') return await cmdShell(rest);
    if (cmd === '/help') return HELP_TEXT;
    return `unknown command: ${cmd}\n\n${HELP_TEXT}`;
  } catch (err) {
    return `command crashed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function isAdminConfigured(): boolean {
  return ADMIN_USER_ID !== '';
}

export function getAdminUserId(): string {
  return ADMIN_USER_ID;
}
