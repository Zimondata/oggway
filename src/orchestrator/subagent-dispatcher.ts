/**
 * Subagent dispatcher.
 *
 * Spawns a child agent with inherited context (folder, skills, credentials)
 * to handle a discrete task in isolation. The parent waits for a structured
 * result via IPC. Useful for parallel research, specialised sub-roles, or
 * batch operations where each child has its own cost cap.
 *
 * Architecture mirrors dreaming.dispatchSystemTask:
 *  - Each subagent runs as a queued task on a `<jid>#sub-<id>` lane
 *  - Inherits parent's groupFolder (shared memory + skills)
 *  - context_mode is always 'isolated' (no parent session leak)
 *  - Hard caps on turns + cost + timeout, enforced via agentConfig
 *  - Result is written to a child-specific IPC file the parent reads
 *
 * Inheritance rules:
 *  - Parent's allowedDomains pass through (browser-using subagents work)
 *  - Parent's recursion depth is tracked to prevent fork bombs
 */

import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, DEFAULT_RUNTIME } from './config.js';
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

const MAX_DEPTH = 3;

export function subagentQueueKey(chatJid: string, subagentId: string): string {
  return `${chatJid}#sub-${subagentId}`;
}

export interface SubagentRequest {
  subagentId: string;
  prompt: string;
  parentGroupFolder: string;
  parentChatJid: string;
  model?: string;
  maxTurns?: number;
  inheritSkills?: boolean;
  timeoutMinutes?: number;
  /** Set by recursive callers; the dispatcher rejects depth > MAX_DEPTH. */
  parentDepth?: number;
}

export interface SubagentDispatchDeps {
  queue: GroupQueue;
  router: MessageRouter;
  sessions: () => Record<string, string>;
  onProcess: (
    chatJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  findGroupByFolder: (folder: string) => RegisteredGroup | undefined;
}

function resultPath(parentFolder: string, subagentId: string): string {
  return path.join(
    DATA_DIR,
    'ipc',
    parentFolder,
    'subagent-results',
    `${subagentId}.json`,
  );
}

function writeResult(
  parentFolder: string,
  subagentId: string,
  payload: { status: 'success' | 'error'; output: string; error?: string; durationMs: number; turns?: number },
): void {
  const file = resultPath(parentFolder, subagentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

export async function dispatchSubagent(
  request: SubagentRequest,
  deps: SubagentDispatchDeps,
): Promise<void> {
  const startTime = Date.now();
  const depth = (request.parentDepth ?? 0) + 1;
  if (depth > MAX_DEPTH) {
    writeResult(request.parentGroupFolder, request.subagentId, {
      status: 'error',
      output: '',
      error: `Subagent depth limit (${MAX_DEPTH}) exceeded — refusing to spawn.`,
      durationMs: 0,
    });
    return;
  }

  const parent = deps.findGroupByFolder(request.parentGroupFolder);
  if (!parent) {
    writeResult(request.parentGroupFolder, request.subagentId, {
      status: 'error',
      output: '',
      error: `Parent group folder "${request.parentGroupFolder}" not found.`,
      durationMs: 0,
    });
    return;
  }

  const runtime = parent.runtime || DEFAULT_RUNTIME;
  const queueKey = subagentQueueKey(request.parentChatJid, request.subagentId);

  const routedModel = request.model ?? selectModel(
    request.prompt,
    { groupFolder: parent.folder, taskId: `sub-${request.subagentId}` },
  );

  const mergedAgentConfig: AgentConfig = {
    ...parent.agentConfig,
    model: routedModel,
    maxTurns: request.maxTurns ?? 15,
    // Pass parent's allowed domains so browser-using children work
    allowedDomains: parent.agentConfig?.allowedDomains,
  };

  // Synthetic group for the subagent — same folder (shared memory + skills),
  // but isMain=false (no privileged operations) and a derived name.
  const subagentGroup: RegisteredGroup = {
    ...parent,
    name: `${parent.name} (sub-${request.subagentId.slice(0, 8)})`,
    isMain: false,
    agentConfig: mergedAgentConfig,
  };

  const timeoutMs = (request.timeoutMinutes ?? 10) * 60 * 1000;

  const agentInput = {
    prompt: request.prompt,
    groupFolder: parent.folder,
    chatJid: request.parentChatJid,
    isMain: false,
    isScheduledTask: true, // reuse the scheduled-task agent prompt prefix
    assistantName: ASSISTANT_NAME,
    agentConfig: mergedAgentConfig,
  };

  let result: string | null = null;
  let error: string | null = null;
  let lastTurns: number | undefined;
  let lastUsage: ContainerOutput['usage'] | undefined;
  let activeProc: ChildProcess | null = null;

  const onStreamed = async (output: ContainerOutput) => {
    if (output.usage) lastUsage = output.usage;
    if (output.turns !== undefined) lastTurns = output.turns;
    if (output.result) {
      const intercepted = await interceptRateLimit(
        output.result,
        deps.router,
        request.parentChatJid,
        parent.folder,
      );
      if (intercepted) {
        result = '[rate-limited]';
        error = 'Rate limit hit';
        return;
      }
      result = output.result;
    }
    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    }
  };

  const onProcessCb = (proc: ChildProcess, name: string) => {
    activeProc = proc;
    deps.onProcess(queueKey, proc, name, parent.folder);
  };

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.warn(
      { subagentId: request.subagentId, timeoutMs },
      'Subagent timeout — killing',
    );
    if (activeProc && !activeProc.killed) {
      try { activeProc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, timeoutMs);

  try {
    const output = runtime === 'sandbox'
      ? await runSandboxAgent(subagentGroup, agentInput, onProcessCb, onStreamed)
      : await runContainerAgent(subagentGroup, agentInput, onProcessCb, onStreamed);
    if (output.status === 'error') {
      error = error ?? output.error ?? 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutHandle);
    if (timedOut && !error) error = `Subagent timed out after ${timeoutMs}ms`;
  }

  const durationMs = Date.now() - startTime;

  logAgentRun({
    groupFolder: parent.folder,
    chatJid: request.parentChatJid,
    triggerType: 'subagent',
    inputTokens: lastUsage?.inputTokens || 0,
    outputTokens: lastUsage?.outputTokens || 0,
    cacheCreationTokens: lastUsage?.cacheCreationInputTokens || 0,
    cacheReadTokens: lastUsage?.cacheReadInputTokens || 0,
    durationMs,
    turns: lastTurns || 0,
    model: mergedAgentConfig.model,
    status: error ? 'error' : 'success',
  });

  writeResult(parent.folder, request.subagentId, {
    status: error ? 'error' : 'success',
    output: result ?? '',
    error: error ?? undefined,
    durationMs,
    turns: lastTurns,
  });

  logger.info(
    {
      subagentId: request.subagentId,
      group: parent.folder,
      durationMs,
      turns: lastTurns,
      status: error ? 'error' : 'success',
    },
    'Subagent completed',
  );
}
