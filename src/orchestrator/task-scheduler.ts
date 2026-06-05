import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  DEFAULT_RUNTIME,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';

/**
 * Scheduled tasks (cron + system dreaming) run in their own GroupQueue lane
 * so they never block interactive user messages. Queue is keyed by
 * "<chatJid>#cron"; the agent itself still sees the real chatJid (so
 * send_message routes correctly to the user's real chat).
 */
function cronQueueKey(chatJid: string): string {
  return `${chatJid}#cron`;
}

export { cronQueueKey };
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from '../runtimes/container-runner.js';
import { runSandboxAgent } from '../runtimes/sandbox-runner.js';
import { selectModel } from './model-router.js';
import { evaluateTask } from './task-optimizer.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { detectSystemTaskKind, dispatchSystemTask } from './dreaming.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  getRateLimitedUntil,
  interceptRateLimit,
  isRateLimited,
} from './rate-limit-state.js';
import { MessageRouter, RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  router: MessageRouter;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Rate-limit gate: while the guard is active every run is guaranteed
  // to come back as "hit your limit", so we skip and shift next_run past
  // reset. Applies to system + user tasks alike.
  if (isRateLimited()) {
    const until = getRateLimitedUntil();
    const newNext = until
      ? new Date(until.getTime() + 30_000).toISOString()
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();
    updateTaskAfterRun(task.id, newNext, '[skipped: rate-limited]');
    logger.info(
      { taskId: task.id, until: until?.toISOString(), newNext },
      'Skipping task: rate-limited',
    );
    return;
  }

  // System tasks (dreaming, cost-watch, reflection) get their own dispatcher
  // with hard cost caps + lightweight model + runtime-aware execution.
  // Wrap in try/catch so a throw here can never bypass updateTaskAfterRun
  // and leave next_run stale (would cause the task to fire every poll forever).
  try {
    const systemKind = detectSystemTaskKind(task.prompt);
    if (systemKind) {
      await dispatchSystemTask(task, group, systemKind, {
        queue: deps.queue,
        router: deps.router,
        sessions: deps.getSessions,
        onProcess: deps.onProcess,
      });
      return;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { taskId: task.id, err: errMsg },
      'System task dispatch failed, advancing next_run to break runaway loop',
    );
    const safeNext = computeNextRun(task);
    updateTaskAfterRun(task.id, safeNext, `[system task error] ${errMsg}`);
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: errMsg,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // Use a dedicated queue lane for cron/system tasks so they don't block
  // interactive user messages on the same group.
  const queueKey = cronQueueKey(task.chat_jid);

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(queueKey);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const runtime = group.runtime || DEFAULT_RUNTIME;
    // Route model: per-task override > per-group override > classify prompt
    const routedModel = selectModel(
      task.prompt,
      { groupFolder: task.group_folder, taskId: task.id },
      task.model || group.agentConfig?.model,
    );
    const agentInput = {
      prompt: task.prompt,
      sessionId,
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      isMain,
      isScheduledTask: true,
      assistantName: ASSISTANT_NAME,
      agentConfig: { ...group.agentConfig, model: routedModel },
    };
    const onProcessCb = (proc: any, containerName: string) =>
      deps.onProcess(queueKey, proc, containerName, task.group_folder);
    // Silent result convention: if agent output matches these patterns,
    // record it in DB but don't route to user chat. Prevents heartbeat
    // and other monitoring tasks from spamming the conversation.
    const isSilentResult = (text: string): boolean => {
      // Explicit silent markers at start
      if (/^(\[SILENT\]|no skill\b)/i.test(text)) return true;
      // HEARTBEAT_OK anywhere (agents sometimes prefix status text before it,
      // or wrap it in <internal>HEARTBEAT_OK</internal>)
      if (/HEARTBEAT_OK/i.test(text)) return true;
      // <internal>...</internal> wrapper convention - agents wrap non-user-facing
      // status output in these tags (e.g. after sending content via send_message)
      if (/^<internal>[\s\S]*<\/internal>\s*$/i.test(text)) return true;
      // Internal confirmation logs from agents that already sent content
      // via send_message (check-in sent, content delivered, etc.)
      if (
        /^(check-?in sent|content (scout |delivered|sent)|done\.\s|отправлен|отправила|отправил|\(no action needed)/i.test(
          text,
        )
      )
        return true;
      return false;
    };

    const onOutputCb = async (streamedOutput: ContainerOutput) => {
      if (streamedOutput.result) {
        const intercepted = await interceptRateLimit(
          streamedOutput.result,
          deps.router,
          task.chat_jid,
          task.group_folder,
        );
        if (intercepted) {
          result = '[rate-limited]';
          error = 'Rate limit hit';
          scheduleClose();
          return;
        }

        const trimmed = streamedOutput.result.trim();
        if (isSilentResult(trimmed)) {
          result = trimmed;
          logger.debug(
            { taskId: task.id, result: trimmed.slice(0, 80) },
            'Silent task result, skipping chat routing',
          );
          scheduleClose();
          return;
        }

        result = streamedOutput.result;
        await deps.router.route({
          chatJid: task.chat_jid,
          text: streamedOutput.result,
          triggerType: 'task-result',
          groupFolder: task.group_folder,
        });
        scheduleClose();
      }
      if (streamedOutput.status === 'success') {
        deps.queue.notifyIdle(queueKey);
        scheduleClose();
      }
      if (streamedOutput.status === 'error') {
        error = streamedOutput.error || 'Unknown error';
      }
    };

    const runFn = runtime === 'sandbox' ? runSandboxAgent : runContainerAgent;
    const output = await runFn(group, agentInput, onProcessCb, onOutputCb);

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // Auto-optimizer: evaluate task efficiency after each run
  try {
    evaluateTask(task.id);
  } catch (err) {
    logger.warn({ taskId: task.id, err }, 'Task optimizer evaluation failed');
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          cronQueueKey(currentTask.chat_jid),
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
