/**
 * Group Queue — concurrency control for agent execution.
 *
 * Manages concurrent agent containers per group. Handles:
 * - Max concurrent containers limit
 * - Per-group message and task queuing
 * - Idle waiting and stdin piping
 * - Retry with exponential backoff
 * - Graceful shutdown
 */
import fs from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  activeStartedAt: number | null;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  watchdog: ReturnType<typeof setInterval> | null;
  lastActivityAt: number | null;
}

// If a group has been active for longer than this, force-clear it.
// Safety net for any code path that fails to release the active flag.
const STALE_ACTIVE_MS = 10 * 60 * 1000; // 10 minutes
// Per-run watchdog: SIGKILL the agent process if there's been no activity
// (no streamed output, no input) for this long. Reset by noteActivity()
// on every sandbox output. Catches silent hangs without killing legit
// long-running multi-turn conversations.
const RUN_WATCHDOG_INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes — opus has long thinking pauses
const RUN_WATCHDOG_CHECK_MS = 30 * 1000; // check every 30s

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private checkPendingFn: ((groupJid: string) => boolean) | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeStartedAt: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        watchdog: null,
        lastActivityAt: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Register a callback that checks the DB for unprocessed messages.
   * Called by drainGroup as a safety net after pendingMessages and pendingTasks
   * are both empty. Catches messages that slipped through cursor gaps (e.g.
   * piped to sandbox but sandbox crashed before consuming them).
   */
  setCheckPendingFn(fn: (groupJid: string) => boolean): void {
    this.checkPendingFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);

    if (state.active) {
      // Safety net: force-clear stale active state
      if (state.activeStartedAt && Date.now() - state.activeStartedAt > STALE_ACTIVE_MS) {
        logger.warn({ groupJid, staleSinceMs: Date.now() - state.activeStartedAt }, 'Force-clearing stale active group');
        state.active = false;
        state.activeStartedAt = null;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
        this.activeCount = Math.max(0, this.activeCount - 1);
      } else {
        state.pendingMessages = true;
        // If the sandbox is in idle-wait (between turns, after a result),
        // proactively close stdin so it exits gracefully and the queue
        // drains pendingMessages immediately. Without this we'd wait for
        // IDLE_TIMEOUT (30min default) before the new message gets a run.
        if (state.idleWaiting) {
          logger.info(
            { groupJid },
            'New message arrived while sandbox idle-waiting — closing stdin to drain queue',
          );
          this.closeStdin(groupJid);
        }
        return;
      }
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) return;
    if (state.pendingTasks.some((t) => t.id === taskId)) return;

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) this.closeStdin(groupJid);
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    // If we're replacing a still-alive proc registration, leave watchdog
    // logic to handle the old proc's exit cleanup. Only reset activity
    // tracking when this IS a new proc.
    const isReplacement = state.process && state.process !== proc;
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    if (!isReplacement) {
      state.lastActivityAt = Date.now();
    }

    // Inactivity watchdog: every CHECK_MS, look at lastActivityAt. If no
    // sandbox activity for INACTIVITY_MS — assume hung, SIGKILL the entire
    // process group (sandbox spawned with detached:true, so -pid kills the
    // whole tree: npm wrapper + srt + runner + MCP children).
    if (state.watchdog) clearInterval(state.watchdog);
    state.watchdog = setInterval(() => {
      const cur = this.groups.get(groupJid);
      if (!cur || cur.process !== proc) {
        if (state.watchdog) {
          clearInterval(state.watchdog);
          state.watchdog = null;
        }
        return;
      }
      if (proc.exitCode !== null || proc.signalCode) {
        if (state.watchdog) {
          clearInterval(state.watchdog);
          state.watchdog = null;
        }
        return;
      }
      const idleMs = Date.now() - (cur.lastActivityAt ?? Date.now());
      if (idleMs < RUN_WATCHDOG_INACTIVITY_MS) return;
      logger.error(
        {
          groupJid,
          containerName,
          pid: proc.pid,
          idleMs,
        },
        'Run watchdog tripped — SIGKILL on stuck agent (no activity)',
      );
      try {
        // Negative pid = kill entire process group. Requires detached:true
        // at spawn time (we set it in sandbox-runner.ts).
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch (err) {
        // Fallback: try direct kill if process group kill failed
        logger.warn({ err: (err as Error).message, groupJid }, 'Process-group SIGKILL failed, trying direct kill');
        try {
          proc.kill('SIGKILL');
        } catch (err2) {
          logger.warn({ err: (err2 as Error).message, groupJid }, 'Direct SIGKILL also failed');
        }
      }
    }, RUN_WATCHDOG_CHECK_MS);
    if (typeof state.watchdog.unref === 'function') state.watchdog.unref();

    if (typeof proc.once === 'function') {
      proc.once('exit', () => {
        // Only clear if this exit is for the CURRENT proc — otherwise we'd
        // kill a fresh watchdog set up for a replacement process.
        if (state.process === proc && state.watchdog) {
          clearInterval(state.watchdog);
          state.watchdog = null;
        }
      });
    }
  }

  /**
   * Reset the inactivity watchdog timer for a group. Call on every sandbox
   * output (streamed assistant text, tool result, etc) to mark the agent
   * as alive. Without periodic activity the watchdog SIGKILLs after
   * RUN_WATCHDOG_INACTIVITY_MS.
   */
  noteActivity(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state) return;
    state.lastActivityAt = Date.now();
  }

  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    // Close stdin if anything is waiting: scheduled tasks OR new user
    // messages (sequentialMessages mode queues into pendingMessages while
    // sandbox is in idle-wait between turns). Without checking
    // pendingMessages here, the sandbox would idle for IDLE_TIMEOUT (30min
    // default) before user messages get picked up.
    if (state.pendingTasks.length > 0 || state.pendingMessages) {
      this.closeStdin(groupJid);
    }
  }

  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
    state.idleWaiting = false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;
    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Last-resort SIGKILL when graceful close has already failed.
   * Use this only as a watchdog escape hatch — preferred path is closeStdin.
   */
  killProcess(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.process) return;
    if (state.process.killed) return;
    try {
      state.process.kill('SIGKILL');
      logger.warn(
        { groupJid, containerName: state.containerName },
        'GroupQueue.killProcess: SIGKILL sent',
      );
    } catch (err) {
      logger.warn({ groupJid, err }, 'GroupQueue.killProcess: kill failed');
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeStartedAt = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.activeStartedAt = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeStartedAt = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.activeStartedAt = null;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error({ groupJid }, 'Max retries exceeded');
      state.retryCount = 0;
      return;
    }
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info({ groupJid, retryCount: state.retryCount, delayMs }, 'Retry scheduled');
    setTimeout(() => {
      if (!this.shuttingDown) this.enqueueMessageCheck(groupJid);
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);

    // User messages ALWAYS drain before scheduled tasks.
    // Without this, cron tasks (+ REFLECT after each) form an unbroken chain
    // that starves user messages for hours. Messages are interactive and must
    // take priority over background work.
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Error in drain messages'),
      );
      return;
    }

    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Error in drain task'),
      );
      return;
    }

    // Safety net: check the DB for messages that slipped through.
    // Catches cursor gaps from piped-but-unprocessed messages, race conditions,
    // or any other path where messages exist but pendingMessages wasn't set.
    if (this.checkPendingFn) {
      try {
        if (this.checkPendingFn(groupJid)) {
          logger.info({ groupJid }, 'Safety net: DB has unprocessed messages after drain');
          this.runForGroup(groupJid, 'drain').catch((err) =>
            logger.error({ groupJid, err }, 'Error in safety-net drain'),
          );
          return;
        }
      } catch (err) {
        logger.debug({ groupJid, err }, 'checkPendingFn failed in drainGroup');
      }
    }

    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);
      if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Error in waiting drain'),
        );
      } else if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Error in waiting task'),
        );
      }
    }
  }

  async shutdown(gracePeriodMs: number = 10000): Promise<void> {
    this.shuttingDown = true;
    logger.info({ activeCount: this.activeCount }, 'GroupQueue shutting down');

    // Clear all pending retry timers to avoid delays on exit
    for (const [groupJid, state] of this.groups) {
      if (state.watchdog) {
        clearInterval(state.watchdog);
        state.watchdog = null;
      }
    }

    // Give active agents a grace period to finish
    const deadline = Date.now() + gracePeriodMs;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Force-kill any remaining active processes
    for (const [groupJid, state] of this.groups) {
      if (state.process && !state.process.killed) {
        logger.warn(
          { groupJid, containerName: state.containerName },
          'Force-killing process during shutdown',
        );
        try {
          state.process.kill('SIGKILL');
        } catch (err) {
          logger.warn({ groupJid, err }, 'Failed to kill process');
        }
      }
    }

    logger.info('GroupQueue shutdown complete');
  }
}
