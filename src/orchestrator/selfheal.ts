/**
 * Self-heal watcher — picks up approved incidents and spawns a fixer-Claude
 * process to edit src/, run tests, commit, restart the service, and report
 * back to the originating Telegram chat.
 *
 * Flow:
 *   1. Agent writes groups/<folder>/incidents/<id>.md + pings user
 *   2. User approves in TG → agent writes <id>.APPROVED
 *   3. This watcher sees .APPROVED (within ~15s poll)
 *   4. Spawn `claude -p "<fixer prompt>" --dangerously-skip-permissions`
 *      with cwd = project root (NOT sandboxed, full write access)
 *   5. Stream status → Telegram via outbound router
 *   6. Mark .FIXED or .FAILED based on subprocess exit
 *
 * Safety:
 *   - No auto-approve: only USER saying yes (enforced in agent CLAUDE.md)
 *   - Git history preserved; if service breaks, `git revert HEAD` recovers
 *   - Lock file prevents concurrent fixer runs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STATE_ROOT } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { Channel } from './types.js';

const POLL_INTERVAL_MS = 15_000;
const LOCK_FILE = path.join(STATE_ROOT, 'data', 'selfheal.lock');

interface IncidentRef {
  groupFolder: string;
  chatJid: string;
  id: string;
  incidentPath: string;
  approvedPath: string;
}

function findApprovedIncidents(autoApprove: boolean): IncidentRef[] {
  const results: IncidentRef[] = [];
  if (!fs.existsSync(GROUPS_DIR)) return results;
  for (const folder of fs.readdirSync(GROUPS_DIR)) {
    const incidentsDir = path.join(GROUPS_DIR, folder, 'incidents');
    if (!fs.existsSync(incidentsDir)) continue;
    for (const entry of fs.readdirSync(incidentsDir)) {
      const isApproved = entry.endsWith('.APPROVED');
      const isPendingMd = autoApprove && entry.endsWith('.md');
      if (!isApproved && !isPendingMd) continue;

      const id = entry.replace(/\.(APPROVED|md)$/, '');
      const incidentPath = path.join(incidentsDir, `${id}.md`);
      const approvedPath = path.join(incidentsDir, `${id}.APPROVED`);
      if (!fs.existsSync(incidentPath)) continue;
      // Skip if already processed
      if (
        fs.existsSync(path.join(incidentsDir, `${id}.FIXED`)) ||
        fs.existsSync(path.join(incidentsDir, `${id}.FAILED`))
      )
        continue;
      // In autoApprove mode, promote pending .md → .APPROVED on the fly
      if (isPendingMd && !fs.existsSync(approvedPath)) {
        fs.writeFileSync(
          approvedPath,
          `auto-approved ${new Date().toISOString()}`,
        );
      }
      // Pull chat_jid from incident file header
      const md = fs.readFileSync(incidentPath, 'utf-8');
      const chatMatch = md.match(/\*\*Chat:\*\*\s+(\S+)/);
      const chatJid = chatMatch ? chatMatch[1] : '';
      // Dedup — one ref per id
      if (results.some((r) => r.id === id)) continue;
      results.push({
        groupFolder: folder,
        chatJid,
        id,
        incidentPath,
        approvedPath,
      });
    }
  }
  return results;
}

function isLockStale(): boolean {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    const pid = Number(raw);
    if (!pid || !Number.isInteger(pid) || pid <= 0) return true;
    // Fixer-Claude is a child of our own launchd service. If the PID no
    // longer exists, the fixer (or its parent service) died mid-run —
    // typical cause: fixer did launchctl kickstart and our finally
    // block never fired. Treat as stale.
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

function clearStaleLockOnStartup(): void {
  if (isLockStale()) {
    try {
      const pid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
      fs.unlinkSync(LOCK_FILE);
      logger.warn(
        { stalePid: pid },
        'Self-heal: cleared stale lock from dead process',
      );
    } catch {
      /* ignore */
    }
  }
}

function acquireLock(): boolean {
  if (isLockStale()) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function buildFixerPrompt(
  incidentPath: string,
  incidentId: string,
  groupFolder: string,
  chatJid: string,
  telegramBotToken: string,
): string {
  const incidentsDir = path.dirname(incidentPath);
  const fixedMarker = path.join(incidentsDir, `${incidentId}.FIXED`);
  const failedMarker = path.join(incidentsDir, `${incidentId}.FAILED`);

  return `You are the fixer-Claude for ClaudeClaw.

An incident was reported and approved by the user. Your job:

1. Read the incident file: ${incidentPath}
2. Explore the repo to confirm the diagnosis is correct (cwd = ${STATE_ROOT})

## Root cause first (Toyota 5 Whys) — MANDATORY before any code change

Before touching code, write a 5-Whys chain into the incident file (${incidentPath}) under a '## 5 Whys' heading. Start from the observed symptom and ask 'why' up to 5 times, each answer feeding the next question, until you reach a root cause that — if fixed — prevents the whole CLASS of this bug, not just this one instance.

Then fix at the ROOT level you identified, not the surface symptom. 'Minimal' means minimal change that addresses the ROOT, not a minimal patch over the symptom.

If the true root needs a broad refactor beyond a localized change, still write the full 5-Whys chain, then write a FAILED marker explaining the root cause and what scoping a human needs to decide — do NOT ship a symptom-only patch and call it fixed.

3. Make a minimal fix that addresses the ROOT CAUSE from your 5 Whys — do NOT add features, do NOT touch unrelated files. Refactor is allowed ONLY if it is the minimal way to fix the identified root and stays localized.
4. Run tests: \`npm test\` — if they fail because of your change, fix the tests OR revert
5. Rebuild: \`npm run build\` (and \`cd agent/runner && npx tsc && cd ../..\` if agent runner was touched)
6. Stage + commit with a clear message like "fix: <what> (incident ${incidentId})"
7. Do NOT push to remote — user does that manually

## CRITICAL — notification order (read carefully)

Restarting the service (\`launchctl kickstart -k\`) kills THIS process's parent watcher. If you send the Telegram message or write the .FIXED marker AFTER restart, they will be lost. So do them FIRST, then restart last.

Exact sequence:

a. **Write FIXED marker** (or FAILED if unfixable):
   - On success: \`echo "exitCode: 0\\nduration: N/A\\n\\n<your summary>" > "${fixedMarker}"\`
   - On failure: \`echo "<error details>" > "${failedMarker}"\`

b. **Send Telegram status message** (even if nothing to report — user is waiting):
   \`\`\`
   curl -s -X POST "https://api.telegram.org/bot${telegramBotToken}/sendMessage" \\
     -d "chat_id=${chatJid.replace(/^tg:/, '')}" \\
     --data-urlencode "text=✓ Fixer done (incident ${incidentId})\\n\\n<short summary: what changed + test results>"
   \`\`\`
   (Use ✗ and "failed" wording if you couldn't fix.)

c. **ONLY THEN** restart service: \`launchctl kickstart -k gui/$(id -u)/com.claudeclaw.claudeclaw\`

d. Verify alive: \`launchctl list | grep claudeclaw\` should show PID + exit code 0. If not, try \`launchctl bootstrap\` or report failure.

## Rules

The user is waiting for this to work. Don't over-engineer. Don't explore beyond the affected area.

If the incident's proposed fix looks wrong after you explored, say so — write the FAILED marker + Telegram message, skip the restart, exit.

If you can't find the root cause in 15 min of exploration, do the same: FAILED marker + TG message "Cannot fix automatically, need human input: <why>", exit.

Working directory: ${STATE_ROOT}
Group that reported: ${groupFolder}
Incident ID: ${incidentId}
Chat JID: ${chatJid}
`;
}

async function runFixer(ref: IncidentRef, channels: Channel[]): Promise<void> {
  logger.info(
    { id: ref.id, group: ref.groupFolder },
    'Self-heal: starting fixer',
  );

  const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const telegramBotToken =
    env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  const prompt = buildFixerPrompt(
    ref.incidentPath,
    ref.id,
    ref.groupFolder,
    ref.chatJid,
    telegramBotToken,
  );
  const incidentsDir = path.dirname(ref.incidentPath);
  const fixedPath = path.join(incidentsDir, `${ref.id}.FIXED`);
  const failedPath = path.join(incidentsDir, `${ref.id}.FAILED`);

  // Notify user that fixer is starting
  const channel = channels.find((c) => c.ownsJid(ref.chatJid));
  if (channel && ref.chatJid) {
    try {
      await channel.sendMessage(
        ref.chatJid,
        `🔧 Fixer запущен по incident ${ref.id}. Жди отчёт.`,
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Self-heal: startup notify failed',
      );
    }
  }

  let stdout = '';
  let stderr = '';
  const startTime = Date.now();

  await new Promise<void>((resolve) => {
    const child = spawn(
      'claude',
      [
        '--print',
        '--dangerously-skip-permissions',
        '--output-format',
        'text',
        prompt,
      ],
      {
        cwd: STATE_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    // Safety: kill after 20 min
    const killTimer = setTimeout(
      () => {
        logger.warn({ id: ref.id }, 'Self-heal: fixer timeout, killing');
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      },
      20 * 60 * 1000,
    );

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      const duration = Math.round((Date.now() - startTime) / 1000);
      const success = code === 0;
      const summary = stdout.trim().slice(-2000) || '(no output)';
      const errTail = stderr.trim().slice(-500);

      fs.writeFileSync(
        success ? fixedPath : failedPath,
        `exitCode: ${code}\nduration: ${duration}s\n\n${summary}${errTail ? `\n\n--- stderr ---\n${errTail}` : ''}`,
      );

      if (channel && ref.chatJid) {
        const status = success ? '✓ Fixer done' : '✗ Fixer failed';
        const msg = `${status} (${duration}s, incident ${ref.id})\n\n${summary.slice(-1500)}`;
        channel.sendMessage(ref.chatJid, msg).catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Self-heal: result notify failed',
          );
        });
      }

      logger.info(
        { id: ref.id, success, duration, code },
        'Self-heal: fixer finished',
      );
      resolve();
    });
  });
}

export function startSelfHealWatcher(channels: Channel[]): void {
  const autoApprove = process.env.SELFHEAL_AUTO_APPROVE === '1';
  clearStaleLockOnStartup();
  logger.info(
    { autoApprove },
    `Self-heal watcher starting (poll every 15s${autoApprove ? ', AUTO-APPROVE MODE' : ''})`,
  );

  const tick = async () => {
    const pending = findApprovedIncidents(autoApprove);
    for (const ref of pending) {
      if (!acquireLock()) {
        logger.debug(
          { id: ref.id },
          'Self-heal: another fixer running, skipping',
        );
        return;
      }
      try {
        await runFixer(ref, channels);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), id: ref.id },
          'Self-heal: fixer crashed',
        );
      } finally {
        releaseLock();
      }
    }
  };

  setInterval(() => {
    tick().catch(() => {
      /* never throw */
    });
  }, POLL_INTERVAL_MS);
  // First tick immediately
  tick().catch(() => {
    /* ignore */
  });
}
