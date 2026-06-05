/**
 * Dreaming - background memory consolidation and skill optimization.
 *
 * Three cron tasks per registered group:
 *   - DREAM-LIGHT  every 6 hours: dedupe today's daily log
 *   - DREAM-NIGHT  3:00 daily:    consolidate yesterday into topics
 *   - DREAM-WEEKLY 04:00 Sunday:  archive old topics, queue weak skills for rewrite
 *
 * Plus one cost-watchdog heartbeat task per group:
 *   - COST-WATCH   09:00 daily:   query agent_runs and warn if dreaming > $0.50/week
 *
 * Tasks are seeded idempotently at service startup (seedSystemTasks).
 * The task-scheduler detects the [DREAM-*]/[COST-WATCH] prompt prefixes and
 * dispatches them through dispatchSystemTask() with hard cost caps + a
 * lightweight model + serialization through GroupQueue.
 */

import { CronExpressionParser } from 'cron-parser';

import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME, DEFAULT_RUNTIME, TIMEZONE } from './config.js';
import { logAgentRun } from '../cost-tracking/index.js';
import {
  ContainerOutput,
  runContainerAgent,
} from '../runtimes/container-runner.js';
import { runSandboxAgent } from '../runtimes/sandbox-runner.js';
import { createTask, getTaskById, logTaskRun, updateTaskAfterRun } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { interceptRateLimit } from './rate-limit-state.js';
import { AgentConfig, MessageRouter, RegisteredGroup, ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const DREAM_LIGHT_PROMPT = `[DREAM-LIGHT] Compute today's date (YYYY-MM-DD). Call memory_get with file="memory/daily/<today>.md". \
If the result is empty OR has fewer than 3 entries, reply exactly "nothing to dedupe" and STOP — do not call other tools. \
Otherwise: identify entries that are clear duplicates (same content within the last 6 hours), and use the Bash tool to overwrite the daily file with the deduped version (use 'cat > path' or sed). Reply with a one-line summary like "removed N duplicates" and stop. \
Do not message the user. Wrap any narration in <internal></internal>.`;

export const DREAM_NIGHT_PROMPT = `[DREAM-NIGHT] Compute yesterday's date (YYYY-MM-DD). Call memory_get with file="memory/daily/<yesterday>.md". \
If the result is empty, reply exactly "nothing to consolidate" and STOP. \
Otherwise: extract 1-3 recurring themes/events/facts. For each, call memory_save with category=topic, topic=<short-name>, content=<one-paragraph consolidation>. \
After consolidating, use Bash to overwrite the yesterday daily file with a 5-line summary. \
Reply with a one-line summary like "consolidated N themes" and stop. \
Do not message the user. Wrap narration in <internal></internal>.`;

export const DREAM_WEEKLY_PROMPT = `[DREAM-WEEKLY] Two phases. \
(1) Memory archival: Use Bash 'ls -la --time-style=long-iso groups/$CLAUDECLAW_GROUP_FOLDER/memory/topics/' to find topic files older than 30 days. \
For each, use Bash 'mkdir -p memory/archive/$(date +%Y-%m) && mv memory/topics/<name>.md memory/archive/$(date +%Y-%m)/'. \
If no eligible files, skip phase 1. \
(2) Skill review: Call skill_list. Identify any skill whose failure_count > 2*success_count. \
For each, call skill_save with the same name and an updated approach incorporating lessons (merge will bump version). If none, skip phase 2. \
Reply with one-line summary like "archived N topics, refreshed M skills" and stop. \
Do not message the user. Wrap narration in <internal></internal>.`;

export const GRIP_SWEEP_PROMPT = `[GRIP-SWEEP] Weekly confidence decay for long-term memory. \
Read the file groups/$CLAUDECLAW_GROUP_FOLDER/memory/topics/grip-index.md using memory_get with file="memory/topics/grip-index.md". \
If the file is empty or doesn't exist, reply "no grip index yet" and STOP. \
Otherwise, for each data line (format: "grip | last-confirmed | fact | section"): \
- Compute days since last-confirmed (today minus the date). \
- If days >= 14 AND grip > 1: decrement grip by 1, update the line. \
- If grip <= 0: remove the line entirely. \
After processing, use Bash to overwrite the grip-index.md with the updated content. \
If any facts dropped to grip 1 or were removed, call send_message with a summary like: \
"Grip Sweep: N facts rusted (grip-1), M facts dropped (grip 0). Review grip-index.md" \
If nothing changed or all facts are healthy, reply "grip sweep: all solid" and stop. \
Do not message the user unless facts need attention. Wrap narration in <internal></internal>.`;

export const COST_WATCH_PROMPT = `[COST-WATCH] Run Bash: \
sqlite3 store/messages.db "SELECT trigger_type, ROUND(SUM(estimated_cost_usd), 4) AS cost, COUNT(*) AS runs FROM agent_runs WHERE run_at > date('now', '-7 days') GROUP BY trigger_type" \
Parse the output. If dreaming cost > 0.50 OR reflection cost > 1.00 OR total > 5.00, call send_message with a one-line WARN summary including the breakdown. \
Otherwise reply exactly "ok" and stop. Wrap narration in <internal></internal>.`;

export const SOUL_EVOLVE_PROMPT = `[SOUL-EVOLVE] Read SOUL.md, then scan memory/daily/ files from the last 7 days \
and memory/conversations/ from the same period. Look for 1-3 patterns in your communication with the user that are \
NOT explicitly described in SOUL.md (tone shifts, recurring reactions, taboos, inside jokes, recurring frustrations). \
For each pattern, write a proposal in this exact format:

PROPOSAL <N>:
section: <existing section name in SOUL.md OR "new section: <Name>">
addition:
> <1-3 line proposal text>
evidence:
- "<short quote>" (date)
- "<short quote>" (date)

Save the proposals to groups/<group_folder>/soul-proposals/<YYYY-MM-DD-HHMM>.md (use Bash with date +%Y-%m-%d-%H%M). \
Then send_message with a brief intro plus all proposals. End with: "Reply 'soul approve <N>' or 'soul reject <N>' for each." \
Do NOT modify SOUL.md directly — only proposals. If you find no genuinely new patterns, reply exactly \
"<internal>no soul evolution needed</internal>" and stop without messaging.`;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const DREAM_PREFIX_PATTERN = /^\[(DREAM-(LIGHT|NIGHT|WEEKLY)|COST-WATCH|REFLECT|SOUL-EVOLVE|GRIP-SWEEP|CONTINUATION)/i;

export type SystemTaskKind = 'dream-light' | 'dream-night' | 'dream-weekly' | 'cost-watch' | 'reflect' | 'soul-evolve' | 'grip-sweep' | 'continuation';

export function detectSystemTaskKind(prompt: string): SystemTaskKind | null {
  // Defensive: prompt may arrive as a Buffer if a sqlite row was written as
  // BLOB instead of TEXT (data corruption from older migration paths).
  // Buffer has no .match() → TypeError → loops forever without advancing next_run.
  const text = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  const m = text.match(DREAM_PREFIX_PATTERN);
  if (!m) return null;
  const tag = m[1].toUpperCase();
  if (tag === 'DREAM-LIGHT') return 'dream-light';
  if (tag === 'DREAM-NIGHT') return 'dream-night';
  if (tag === 'DREAM-WEEKLY') return 'dream-weekly';
  if (tag === 'COST-WATCH') return 'cost-watch';
  if (tag === 'REFLECT') return 'reflect';
  if (tag === 'SOUL-EVOLVE') return 'soul-evolve';
  if (tag === 'GRIP-SWEEP') return 'grip-sweep';
  if (tag === 'CONTINUATION') return 'continuation';
  return null;
}

interface SystemTaskProfile {
  triggerType: 'dreaming' | 'reflection';
  agentConfig: AgentConfig;
  /** Sandbox/container timeout in ms. */
  timeoutMs: number;
  /** When true, the result is forwarded to the user. When false, output stays internal. */
  forwardResult: boolean;
}

// Per user 2026-05-08: opus for everything, no cost limits.
const PROFILES: Record<SystemTaskKind, SystemTaskProfile> = {
  'dream-light': {
    triggerType: 'dreaming',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 10 },
    timeoutMs: 5 * 60 * 1000,
    forwardResult: false,
  },
  'dream-night': {
    triggerType: 'dreaming',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 20 },
    timeoutMs: 10 * 60 * 1000,
    forwardResult: false,
  },
  'dream-weekly': {
    triggerType: 'dreaming',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 30 },
    timeoutMs: 15 * 60 * 1000,
    forwardResult: false,
  },
  'cost-watch': {
    triggerType: 'dreaming',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 10 },
    timeoutMs: 5 * 60 * 1000,
    forwardResult: true,
  },
  reflect: {
    triggerType: 'reflection',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 8 },
    timeoutMs: 5 * 60 * 1000,
    forwardResult: false,
  },
  'soul-evolve': {
    triggerType: 'dreaming',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 15 },
    timeoutMs: 10 * 60 * 1000,
    forwardResult: true,
  },
  'grip-sweep': {
    triggerType: 'dreaming',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 15 },
    timeoutMs: 10 * 60 * 1000,
    forwardResult: true,
  },
  continuation: {
    triggerType: 'reflection',
    agentConfig: { model: 'claude-opus-4-8', maxTurns: 50 },
    timeoutMs: 15 * 60 * 1000,
    forwardResult: true,
  },
};

export function profileForKind(kind: SystemTaskKind): SystemTaskProfile {
  return PROFILES[kind];
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface SeedSpec {
  idSuffix: string;
  cron: string;
  prompt: string;
}

const SYSTEM_SEED_SPECS: SeedSpec[] = [
  { idSuffix: 'dream-light', cron: '0 */6 * * *', prompt: DREAM_LIGHT_PROMPT },
  { idSuffix: 'dream-night', cron: '0 3 * * *', prompt: DREAM_NIGHT_PROMPT },
  { idSuffix: 'dream-weekly', cron: '0 4 * * 0', prompt: DREAM_WEEKLY_PROMPT },
  { idSuffix: 'cost-watch', cron: '0 9 * * *', prompt: COST_WATCH_PROMPT },
  { idSuffix: 'soul-evolve', cron: '0 5 * * 0', prompt: SOUL_EVOLVE_PROMPT },
  { idSuffix: 'grip-sweep', cron: '0 4 * * 3', prompt: GRIP_SWEEP_PROMPT },
];

/**
 * Seed scheduled_tasks with system dreaming + cost-watch tasks for the given group.
 * Idempotent: skips inserts when a task with the same id already exists.
 *
 * `chatJid` is the JID where forwarded results (cost-watch warnings) should be routed.
 * For the main group it's the main control chat; for others it's the group's own JID.
 */
export function seedSystemTasks(jid: string, group: RegisteredGroup): void {
  for (const spec of SYSTEM_SEED_SPECS) {
    const id = `system-${spec.idSuffix}-${group.folder}`;
    if (getTaskById(id)) continue;

    let nextRun: string | null;
    try {
      const interval = CronExpressionParser.parse(spec.cron, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } catch (err) {
      logger.error(
        { err, cron: spec.cron, group: group.folder },
        'Failed to parse system cron, skipping seed',
      );
      continue;
    }

    createTask({
      id,
      group_folder: group.folder,
      chat_jid: jid,
      prompt: spec.prompt,
      schedule_type: 'cron',
      schedule_value: spec.cron,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info(
      { id, group: group.folder, cron: spec.cron },
      'Seeded system task',
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchDeps {
  queue: GroupQueue;
  router: MessageRouter;
  sessions: () => Record<string, string>;
  onProcess: (
    chatJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
}

/**
 * Run a system task (dreaming/reflection) with hard caps.
 * Honours group.runtime so sandbox installs don't silently fall back to container.
 * Output is suppressed for non-forwarding kinds (dream-*, reflect).
 */
export async function dispatchSystemTask(
  task: ScheduledTask,
  group: RegisteredGroup,
  kind: SystemTaskKind,
  deps: DispatchDeps,
): Promise<void> {
  const profile = profileForKind(kind);
  const startTime = Date.now();
  const runtime = group.runtime || DEFAULT_RUNTIME;

  const mergedAgentConfig: AgentConfig = {
    ...group.agentConfig,
    ...profile.agentConfig,
  };
  const groupForRun: RegisteredGroup = {
    ...group,
    agentConfig: mergedAgentConfig,
  };

  const sessionId = task.context_mode === 'group'
    ? deps.sessions()[group.folder]
    : undefined;

  let result: string | null = null;
  let error: string | null = null;
  let lastTurns: number | undefined;
  let lastUsage: ContainerOutput['usage'] | undefined;
  let activeProc: ChildProcess | null = null;

  // System tasks share the cron queue lane so they don't block interactive
  // user messages. Agent itself still sees the real chat_jid so send_message
  // routes to the user's real chat.
  const queueKey = `${task.chat_jid}#cron`;

  // System tasks are one-shot. Once the agent emits a result, give it a brief
  // grace period for any final MCP calls, then close stdin so it can exit.
  const TASK_CLOSE_DELAY_MS = 10_000;
  let closeScheduled = false;
  const scheduleClose = () => {
    if (closeScheduled) return;
    closeScheduled = true;
    setTimeout(() => {
      try {
        deps.queue.closeStdin(queueKey);
      } catch { /* queue may not have a tracked process */ }
    }, TASK_CLOSE_DELAY_MS);
  };

  const onStreamed = async (output: ContainerOutput) => {
    if (output.usage) lastUsage = output.usage;
    if (output.turns !== undefined) lastTurns = output.turns;
    if (output.result) {
      const intercepted = await interceptRateLimit(
        output.result,
        deps.router,
        task.chat_jid,
        group.folder,
      );
      if (intercepted) {
        result = '[rate-limited]';
        error = 'Rate limit hit';
        scheduleClose();
        return;
      }
      result = output.result;
      if (profile.forwardResult) {
        await deps.router.route({
          chatJid: task.chat_jid,
          text: output.result,
          triggerType: 'task-result',
          groupFolder: group.folder,
        });
      }
      scheduleClose();
    }
    if (output.status === 'success') {
      deps.queue.notifyIdle(queueKey);
      scheduleClose();
    }
    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    }
  };

  const onProcessCb = (proc: ChildProcess, name: string) => {
    activeProc = proc;
    deps.onProcess(queueKey, proc, name, group.folder);
  };

  const agentInput = {
    prompt: task.prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid: task.chat_jid,
    isMain: group.isMain === true,
    isScheduledTask: true,
    assistantName: ASSISTANT_NAME,
    agentConfig: mergedAgentConfig,
  };

  // Hard timeout — graceful close first, SIGKILL after grace period.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.warn(
      { taskId: task.id, kind, timeoutMs: profile.timeoutMs },
      'System task timeout — closing and killing sandbox',
    );
    try {
      deps.queue.closeStdin(queueKey);
    } catch { /* queue may not have a tracked process */ }
    setTimeout(() => {
      if (activeProc && !activeProc.killed) {
        try { activeProc.kill('SIGKILL'); } catch { /* already exited */ }
      }
    }, 5_000);
  }, profile.timeoutMs);

  try {
    const output = runtime === 'sandbox'
      ? await runSandboxAgent(groupForRun, agentInput, onProcessCb, onStreamed)
      : await runContainerAgent(groupForRun, agentInput, onProcessCb, onStreamed);
    if (output.status === 'error') {
      error = error ?? output.error ?? 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutHandle);
    if (timedOut && !error) {
      error = `System task timed out after ${profile.timeoutMs}ms`;
    }
  }

  const durationMs = Date.now() - startTime;

  logAgentRun({
    groupFolder: group.folder,
    chatJid: task.chat_jid,
    triggerType: profile.triggerType,
    inputTokens: lastUsage?.inputTokens || 0,
    outputTokens: lastUsage?.outputTokens || 0,
    cacheCreationTokens: lastUsage?.cacheCreationInputTokens || 0,
    cacheReadTokens: lastUsage?.cacheReadInputTokens || 0,
    durationMs,
    turns: lastTurns || 0,
    model: mergedAgentConfig.model,
    status: error ? 'error' : 'success',
  });

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result: profile.forwardResult ? result : null,
    error,
  });

  // Compute next_run inline to avoid a circular import on task-scheduler.
  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } catch {
      nextRun = null;
    }
  }
  const summary = error ? `Error: ${error}` : 'Completed';
  updateTaskAfterRun(task.id, nextRun, summary);

  logger.info(
    {
      taskId: task.id,
      kind,
      group: group.folder,
      durationMs,
      turns: lastTurns,
      status: error ? 'error' : 'success',
    },
    'System task completed',
  );
}
