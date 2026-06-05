/**
 * Wake event dispatcher.
 *
 * Runs in a dedicated GroupQueue lane (`<jid>#wake`) so external events
 * never block interactive user messages or scheduled cron tasks.
 * Architecture mirrors dreaming.dispatchSystemTask but with smaller hard
 * caps because wake handlers should be quick by design.
 */

import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME, DEFAULT_RUNTIME } from './config.js';
import { logAgentRun } from '../cost-tracking/index.js';
import {
  ContainerOutput,
  runContainerAgent,
} from '../runtimes/container-runner.js';
import { runSandboxAgent } from '../runtimes/sandbox-runner.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { selectModel } from './model-router.js';
import { interceptRateLimit } from './rate-limit-state.js';
import { AgentConfig, MessageRouter, RegisteredGroup } from './types.js';
import { WakeEvent, buildWakePrompt } from './wake-events.js';

export function wakeQueueKey(chatJid: string): string {
  return `${chatJid}#wake`;
}

export interface WakeDispatchDeps {
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

/** Hard caps for wake events. Tighter than dreaming because they should be quick. */
const WAKE_DEFAULTS = {
  maxTurns: 6,
  timeoutMs: 5 * 60 * 1000,
};

export async function dispatchWakeEvent(
  group: RegisteredGroup,
  event: WakeEvent,
  deps: WakeDispatchDeps,
): Promise<void> {
  const startTime = Date.now();
  const runtime = group.runtime || DEFAULT_RUNTIME;

  // Each wake event runs as its own group-queue task. The agent itself
  // sees the real chat_jid (so send_message routes to user) but the
  // queue uses a #wake-suffixed key so wake events don't block anything.
  const queueKey = wakeQueueKey(group.folder);
  const targetChatJid = group.folder; // group's main jid lookup happens via registeredGroups; we use folder to derive the wake task identity, but agentInput.chatJid is the real jid.

  const prompt = buildWakePrompt(event);
  const routedModel = selectModel(prompt, { groupFolder: group.folder });

  const mergedAgentConfig: AgentConfig = {
    ...group.agentConfig,
    model: routedModel,
    maxTurns: WAKE_DEFAULTS.maxTurns,
  };
  const groupForRun: RegisteredGroup = {
    ...group,
    agentConfig: mergedAgentConfig,
  };

  // Wake events typically need recent context; default to group session.
  const sessionId = deps.sessions()[group.folder];

  let result: string | null = null;
  let error: string | null = null;
  let lastTurns: number | undefined;
  let lastUsage: ContainerOutput['usage'] | undefined;
  let activeProc: ChildProcess | null = null;

  const TASK_CLOSE_DELAY_MS = 10_000;
  let closeScheduled = false;
  const scheduleClose = () => {
    if (closeScheduled) return;
    closeScheduled = true;
    setTimeout(() => {
      try {
        deps.queue.closeStdin(queueKey);
      } catch { /* queue may be empty */ }
    }, TASK_CLOSE_DELAY_MS);
  };

  // Resolve the chatJid the agent should see (for send_message routing).
  // Find in deps via a peek: the group object we got already has folder;
  // we need its main jid. Cheapest: caller is expected to pass group with
  // proper context; agent just needs the real jid for send_message MCP.
  // In wake-dispatcher's callsite we always pass the real chatJid via group.
  const realChatJid = (event.payload._chatJid as string | undefined) ?? '';

  const onStreamed = async (output: ContainerOutput) => {
    if (output.usage) lastUsage = output.usage;
    if (output.turns !== undefined) lastTurns = output.turns;
    if (output.result) {
      const intercepted = await interceptRateLimit(
        output.result,
        deps.router,
        realChatJid || group.folder,
        group.folder,
      );
      if (intercepted) {
        result = '[rate-limited]';
        error = 'Rate limit hit';
        scheduleClose();
        return;
      }
      result = output.result;
      // Wake events don't auto-route their own result text; the agent
      // decides via send_message MCP whether to bother the user. This
      // mirrors dream-* tasks (forwardResult: false).
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
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid: realChatJid,
    isMain: group.isMain === true,
    isScheduledTask: true, // reuses the scheduled-task agent prompt prefix
    assistantName: ASSISTANT_NAME,
    agentConfig: mergedAgentConfig,
  };

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.warn(
      { event: `${event.source}.${event.eventType}`, timeoutMs: WAKE_DEFAULTS.timeoutMs },
      'Wake event timeout — closing and killing sandbox',
    );
    try { deps.queue.closeStdin(queueKey); } catch { /* ignore */ }
    setTimeout(() => {
      if (activeProc && !activeProc.killed) {
        try { activeProc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 5_000);
  }, WAKE_DEFAULTS.timeoutMs);

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
      error = `Wake event timed out after ${WAKE_DEFAULTS.timeoutMs}ms`;
    }
  }

  const durationMs = Date.now() - startTime;

  logAgentRun({
    groupFolder: group.folder,
    chatJid: realChatJid || group.folder,
    triggerType: 'wake',
    inputTokens: lastUsage?.inputTokens || 0,
    outputTokens: lastUsage?.outputTokens || 0,
    cacheCreationTokens: lastUsage?.cacheCreationInputTokens || 0,
    cacheReadTokens: lastUsage?.cacheReadInputTokens || 0,
    durationMs,
    turns: lastTurns || 0,
    model: mergedAgentConfig.model,
    status: error ? 'error' : 'success',
  });

  logger.info(
    {
      event: `${event.source}.${event.eventType}`,
      group: group.folder,
      durationMs,
      turns: lastTurns,
      status: error ? 'error' : 'success',
    },
    'Wake event handled',
  );
}
