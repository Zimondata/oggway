import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_RUNTIME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  GROUPS_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
  WEBHOOK_PORT,
  WEBHOOK_SECRET,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  cleanupSandboxOrphans,
  ensureSandboxRuntimeAvailable,
  runSandboxAgent,
} from '../runtimes/sandbox-runner.js';
// Channels loaded from src/index.ts;
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channel-registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../runtimes/container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from '../runtimes/container-runtime.js';
import {
  createTask,
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTagsStreaming,
} from './router.js';
import { createMessageRouter } from './outbound-router.js';
import { createFactCheckHook } from './fact-check-hook.js';
import { createMessageIngestion } from './ingestion.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  callExtensionStartup,
  getExtensionDbSchema,
  wireExtensionHooks,
} from './extensions.js';
// Load plugins (self-registering on import)
// Extensions loaded from src/index.ts;
import {
  Channel,
  MessageRouter,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import { logAgentRun, logAgentTurns } from '../cost-tracking/index.js';
import {
  formatSkillsForContext,
  recordSkillUsage,
  searchSkills,
  type SkillRecord,
} from '../skill-registry/index.js';
import {
  getRateLimitedUntil,
  interceptRateLimit,
  isRateLimited,
} from './rate-limit-state.js';
import { startWebhookServer } from '../webhook/server.js';
import { selectModel, selectModelAsync } from './model-router.js';
import { cancelEdit, flushEdit, scheduleEdit } from './edit-throttle.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let sessionLastActivity: Record<string, number> = {};
const SESSION_STALE_MS = 15 * 60 * 1000;
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
const consecutiveFailures: Record<string, number> = {};
/** Tracks how many auto-continuations have fired for a group in a row.
 *  Reset to 0 on any successful non-overflow run or new user message. */
const continuationCount: Record<string, number> = {};
const MAX_AUTO_CONTINUATIONS = 3;
const lastRateLimitNoticeAt: Record<string, number> = {};
const RATE_LIMIT_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
/** Tracks last reflection timestamp per group for rate limiting. */
const lastReflectionTime: Record<string, number> = {};
// When the bot recovers from a recent failure (rate-limit cleared, sandbox
// restart, retry success), brag to the user once. Pattern: Hermes-style
// "look I fixed myself" — turns a frustrating outage into proof of autonomy.
const recoveryCelebrationOwed: Record<
  string,
  { reason: string; sinceMs: number }
> = {};
const recoveryBragMessages = [
  'Ну вот, я разобралась. Лимит на opus отлип, сама подняла себя обратно.',
  'Перебдела. Сама перезапустилась, теперь снова в игре.',
  'Видишь, я ж говорю — оживу. Опус вернулся, я работаю.',
  'Окей, пошла обратно в строй. Лимит отпустило, продолжаем.',
  'Я снова на связи. Не пришлось тебя дёргать — сама разрулила.',
];
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }

  // Crash recovery: if a previous service was killed mid-process, the cursor
  // for that chat is advanced past messages that never got a reply. We persist
  // a per-chat "in_progress_<jid>" rollback marker BEFORE running the agent
  // and clear it after successful reply. On startup, restore those markers
  // so unanswered messages get re-processed.
  const inProgressJson = getRouterState('in_progress_cursors');
  const taintedJids = new Set<string>();
  if (inProgressJson) {
    try {
      const inProgress = JSON.parse(inProgressJson) as Record<string, string>;
      let recovered = 0;
      for (const [jid, rollbackCursor] of Object.entries(inProgress)) {
        if (typeof rollbackCursor === 'string' && rollbackCursor) {
          lastAgentTimestamp[jid] = rollbackCursor;
          recovered++;
          taintedJids.add(jid);
        }
      }
      if (recovered > 0) {
        logger.warn(
          { recovered, jids: Object.keys(inProgress) },
          'Crash recovery: rolled back cursors for in-flight messages from previous run',
        );
      }
      // Clear markers after recovery
      setRouterState('in_progress_cursors', '{}');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to parse in_progress_cursors, skipping recovery',
      );
    }
  }

  sessions = getAllSessions();
  // Drop sessions for groups whose previous run crashed mid-process. Their
  // SDK session JSONL contains user turns without assistant replies, which
  // makes the agent hallucinate "I already replied" on resume. Map jid →
  // group folder via registeredGroups (loaded next).
  if (taintedJids.size > 0) {
    const tmpGroups = getAllRegisteredGroups();
    for (const jid of taintedJids) {
      const folder = tmpGroups[jid]?.folder;
      if (folder && sessions[folder]) {
        logger.warn(
          { jid, folder, droppedSession: sessions[folder] },
          'Crash recovery: dropping tainted session to avoid stale-resume hallucinations',
        );
        delete sessions[folder];
        try {
          deleteSession(folder);
        } catch (err) {
          logger.debug(
            { err: err instanceof Error ? err.message : String(err), folder },
            'Failed to delete tainted session',
          );
        }
      }
    }
  }
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // For thread/ticket groups, copy CLAUDE.md from the parent group
  const parentFolder = group.folder
    .replace(/_thread_.*$/, '')
    .replace(/_trigger$/, '');
  if (parentFolder !== group.folder) {
    const parentClaudeMd = path.join(GROUPS_DIR, parentFolder, 'CLAUDE.md');
    const targetClaudeMd = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(parentClaudeMd) && !fs.existsSync(targetClaudeMd)) {
      fs.copyFileSync(parentClaudeMd, targetClaudeMd);
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );

  // Seed system tasks for the freshly registered group.
  // Skipped for thread/trigger sub-groups (they share the parent's tasks).
  const isSubGroup = /_thread_|_trigger$/.test(group.folder);
  if (!isSubGroup) {
    void import('./dreaming.js').then(({ seedSystemTasks }) => {
      try {
        seedSystemTasks(jid, group);
      } catch (err) {
        logger.warn(
          { err, folder: group.folder },
          'Failed to seed system tasks for new group',
        );
      }
    });
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('../runtimes/container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _getContinuationCount(folder: string): number {
  return continuationCount[folder] ?? 0;
}
/** @internal - exported for testing */
export function _setContinuationCount(folder: string, count: number): void {
  continuationCount[folder] = count;
}
/** @internal - exported for testing */
export { MAX_AUTO_CONTINUATIONS as _MAX_AUTO_CONTINUATIONS };

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
  router: MessageRouter,
): Promise<boolean> {
  // Refresh from DB so direct SQL updates to agent_config (e.g. allowedDomains)
  // take effect on the next agent spawn without requiring a service restart.
  const fresh = getRegisteredGroup(chatJid);
  if (fresh) registeredGroups[chatJid] = fresh;
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Rate-limit gate: skip without advancing the cursor so the message
  // gets re-processed cleanly after reset. Notification was already
  // delivered once on first detection.
  if (isRateLimited()) {
    const until = getRateLimitedUntil();
    logger.info(
      { group: group.name, until: until?.toISOString() },
      'Skipping user messages: rate-limited',
    );
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Manual session reset: any incoming message starting with /reset, /новая,
  // or containing "новая тема" / "забудь контекст" forces a fresh session
  // before the next agent run. Helps when the agent is dragging stale
  // context across topic shifts.
  const resetTriggerPattern =
    /^\s*\/(reset|новая)\b|новая тема|забудь контекст|сбрось контекст/i;
  const sessionResetRequested = missedMessages.some((m) =>
    resetTriggerPattern.test(m.content || ''),
  );
  if (sessionResetRequested && sessions[group.folder]) {
    logger.info(
      { group: group.folder, droppedSession: sessions[group.folder] },
      'User requested session reset, dropping session',
    );
    delete sessions[group.folder];
    delete sessionLastActivity[group.folder];
  }

  // URL enricher: pre-fetch YouTube transcripts (and other supported URLs)
  // so the agent doesn't have to discover/run scripts itself. Small models
  // (haiku) often fail at tool-discovery; this gives them the content directly.
  let enrichedMessages = missedMessages;
  try {
    const { enrichMessages } = await import('./url-enricher.js');
    enrichedMessages = await enrichMessages(missedMessages, group.folder);
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        group: group.folder,
      },
      'URL enricher failed, using raw messages',
    );
  }

  // Load recent chat history as <history> block — gives the agent visibility
  // into prior messages even when SDK session resume failed/dropped. This is
  // how OpenClaude works: agent always sees scroll-back. ~30 messages max,
  // costs ~1500 tokens per request, much cheaper than re-asking user.
  // Skip messages already in current batch (by id+timestamp).
  let historyMessages: NewMessage[] = [];
  try {
    const { searchChatMessages } = await import('./db.js');
    const oldestNewTs = enrichedMessages[0]?.timestamp;
    const recent = searchChatMessages(chatJid, {
      limit: 30,
      includeBot: true,
      untilIso: oldestNewTs,
    });
    // Exclude any that overlap with current batch by id
    const newIds = new Set(enrichedMessages.map((m) => m.id));
    historyMessages = recent
      .filter((m) => !newIds.has(m.id))
      .map((m) => ({
        id: m.id,
        chat_jid: chatJid,
        sender: '',
        sender_name: m.sender_name,
        content: m.content,
        timestamp: m.timestamp,
        is_from_me: m.is_from_me,
      }));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to load chat history, proceeding without',
    );
  }

  const prompt = formatMessages(enrichedMessages, TIMEZONE, historyMessages);

  // Pre-flight: if BOTH opus and sonnet are rate-limited, fail loud to the
  // user instead of running the agent (which would hang or silently retry).
  // Per user policy: no haiku fallback, ever.
  try {
    const { getAvailableTier } = await import('./rate-limit-probe.js');
    const probe = await getAvailableTier('opus');
    if (probe.allRateLimited) {
      // Note that we hit a rate-limit episode — used later to emit a brag
      // when models recover.
      recoveryCelebrationOwed[chatJid] = {
        reason: 'rate-limit',
        sinceMs: Date.now(),
      };
      const now = Date.now();
      const lastNotice = lastRateLimitNoticeAt[chatJid] || 0;
      const noticeStale = now - lastNotice > RATE_LIMIT_NOTICE_COOLDOWN_MS;
      logger.warn(
        {
          group: group.folder,
          probeReason: probe.reason,
          willNotify: noticeStale,
          minSinceLastNotice: Math.round((now - lastNotice) / 60000),
        },
        'All model tiers rate-limited — skipping agent run',
      );
      // Only send a notice once per 30-min window. Subsequent rate-limited
      // ticks just silently skip; cursor stays old so messages get retried
      // automatically when probe sees recovery on next poll.
      if (noticeStale) {
        lastRateLimitNoticeAt[chatJid] = now;
        try {
          await router.route({
            chatJid,
            text: 'Anthropic API залимичен на opus и sonnet. Жду пока лимит сбросится (обычно 30-60 мин), потом отвечу автоматом.',
            triggerType: 'agent-response',
            groupFolder: group.folder,
          });
        } catch (sendErr) {
          logger.warn({ err: sendErr }, 'Failed to send rate-limit notice');
        }
      }
      // Don't advance cursor — message stays pending. Polling loop will
      // re-evaluate on the next user message (or naturally when poll tick
      // sees old pending). No setTimeout retry — that was creating loops.
      return true;
    }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Pre-flight rate-limit check failed, proceeding optimistically',
    );
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  // Crash-recovery marker: persist the rollback target BEFORE running the
  // agent, so if the service is killed mid-process (launchctl restart, OOM,
  // panic), the next service startup can restore previousCursor and
  // re-process the messages instead of leaking them into the cursor void.
  // Cleared in the success path further down; kept on graceful error paths
  // because those already roll back the cursor in-memory and saveState.
  try {
    const inProgressJson = getRouterState('in_progress_cursors');
    const inProgress = inProgressJson ? JSON.parse(inProgressJson) : {};
    inProgress[chatJid] = previousCursor;
    setRouterState('in_progress_cursors', JSON.stringify(inProgress));
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to persist in_progress marker');
  }
  const clearInProgress = () => {
    try {
      const json = getRouterState('in_progress_cursors');
      const map = json ? JSON.parse(json) : {};
      delete map[chatJid];
      setRouterState('in_progress_cursors', JSON.stringify(map));
    } catch (err) {
      logger.debug({ err, chatJid }, 'Failed to clear in_progress marker');
    }
  };

  // Reset continuation counter on fresh user messages. Without this, once
  // the agent overflows twice the counter stays stuck at MAX and ALL subsequent
  // user messages immediately show the fallback instead of auto-continuing.
  // Each user-initiated conversation deserves fresh continuation attempts.
  continuationCount[group.folder] = 0;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle.
  // Armed at start so a silent agent eventually gets closed; reset on each
  // SDK result so an actively-streaming agent isn't cut off.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Absolute hard kill: 5 minutes past idle as a last resort if closeStdin
  // doesn't reap the process. Catches truly stuck child processes.
  const ABSOLUTE_HARD_TIMEOUT = IDLE_TIMEOUT + 5 * 60 * 1000;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(replyJid);
    }, IDLE_TIMEOUT);
  };

  // Arm the idle timer immediately so a silent agent eventually gets closed.
  resetIdleTimer();

  const hardKillTimer = setTimeout(() => {
    logger.error(
      { group: group.name, timeoutMs: ABSOLUTE_HARD_TIMEOUT },
      'Agent run exceeded absolute hard timeout — SIGKILL',
    );
    queue.killProcess(replyJid);
  }, ABSOLUTE_HARD_TIMEOUT);

  // For trigger-required channels, reply in a thread (using the trigger message ts).
  // This creates a conversation thread that we register with requiresTrigger: false
  // so follow-up replies don't need the trigger word.
  const triggerMsg = missedMessages.find((m) =>
    TRIGGER_PATTERN.test(m.content.trim()),
  );
  const isChannelJid = !chatJid.includes(':', chatJid.indexOf(':') + 1);
  let replyJid = chatJid;
  let agentGroup = group;
  if (isChannelJid && triggerMsg && group.requiresTrigger !== false) {
    const threadJid = `${chatJid}:${triggerMsg.id}`;
    const threadFolder = `${group.folder}_thread_${triggerMsg.id.replace('.', '_')}`;
    // Register the thread so follow-up replies route here without trigger
    if (!registeredGroups[threadJid]) {
      registerGroup(threadJid, {
        name: `${group.name} (thread)`,
        folder: threadFolder,
        trigger: group.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        containerConfig: group.containerConfig,
      });
    }
    replyJid = threadJid;
    // Use the thread group for the agent so it gets its own container
    agentGroup = registeredGroups[threadJid] || group;
  }

  await channel.setTyping?.(replyJid, true);
  let hadError = false;
  let outputSentToUser = false;
  // Track whether output was sent BEFORE the final result callback fires.
  // Used to distinguish "agent sent real IPC output then crashed" from
  // "agent crashed and we routed the error fallback text as output".
  let outputSentBeforeFinal = false;

  // Pre-run: pull relevant skills from this group's library and inject into systemPrompt.
  // We mutate a per-run copy of agentConfig so we don't pollute the registered group.
  let injectedSkills: SkillRecord[] = [];
  try {
    injectedSkills = searchSkills(agentGroup.folder, prompt, 3);
  } catch (err) {
    logger.warn({ err, group: agentGroup.folder }, 'searchSkills failed');
  }
  if (injectedSkills.length > 0) {
    const skillBlock = formatSkillsForContext(injectedSkills);
    const baseSystemPrompt = agentGroup.agentConfig?.systemPrompt ?? '';
    agentGroup = {
      ...agentGroup,
      agentConfig: {
        ...agentGroup.agentConfig,
        systemPrompt: baseSystemPrompt
          ? `${skillBlock}\n${baseSystemPrompt}`
          : skillBlock,
      },
    };
    logger.info(
      { group: group.name, skills: injectedSkills.map((s) => s.name) },
      'Injected relevant skills into agent context',
    );
  }

  // Streaming state for this run. If the channel supports edit, the first
  // partial assistant message creates a draft (sendMessage), and subsequent
  // partials edit it (editMessage with debounce). The final SDK 'result'
  // message flushes the throttle and replaces the draft with the canonical text.
  // Streaming edits can confuse readers when the agent rewrites mid-stream.
  // Per-group opt-out: agentConfig.disableStreaming = true → only send the
  // canonical final text, no in-flight draft.
  const streamingDisabled = Boolean(agentGroup.agentConfig?.disableStreaming);
  const channelSupportsEdit =
    !streamingDisabled &&
    channel.capabilities?.supportsEdit === true &&
    typeof channel.editMessage === 'function';
  const streamKey = `${replyJid}:${Date.now()}`;
  let streamingMessageId: string | number | null = null;
  let streamingDraftStarted = false;

  const agentResult = await runAgent(
    agentGroup,
    prompt,
    replyJid,
    async (result) => {
      // Reset idle timer on EVERY callback (partials, tool heartbeats, finals).
      // Without this, long tool-only sequences (no text output) look like
      // inactivity and the watchdog SIGKILLs healthy runs.
      resetIdleTimer();

      // Streaming partial: edit the in-flight draft instead of sending a new message.
      if (result.partial && channelSupportsEdit) {
        const rawDraft = result.partialText?.trim();
        if (!rawDraft) return;
        // Strip <internal>...</internal> blocks AND any unclosed <internal>
        // tail so suppressed content never appears in the draft.
        const draftText = stripInternalTagsStreaming(rawDraft);
        if (!draftText) return;

        // Lazy-start the draft on the first partial so we have a messageId to edit.
        if (!streamingDraftStarted) {
          streamingDraftStarted = true;
          try {
            const sent = await channel.sendMessage(replyJid, draftText);
            const info = sent as { messageId?: string | number } | void;
            if (info?.messageId !== undefined) {
              streamingMessageId = info.messageId;
              outputSentToUser = true;
            }
          } catch (err) {
            logger.warn(
              { err, group: group.name },
              'Failed to send streaming draft',
            );
            streamingDraftStarted = false; // allow retry on next partial
          }
          return;
        }

        // Subsequent partials: schedule a debounced edit.
        if (streamingMessageId !== null && channel.editMessage) {
          const editFn = channel.editMessage.bind(channel);
          const msgId = streamingMessageId;
          scheduleEdit(streamKey, draftText, async (text) => {
            await editFn(replyJid, msgId, text);
          });
        }
        return;
      }

      // Final result (non-partial). Cancel/flush streaming, then route as before.
      // Capture whether we already sent real output (IPC/streaming) before this
      // final result. The error handler uses this to avoid double-messaging.
      outputSentBeforeFinal = outputSentToUser;
      // If this is a context overflow and we can auto-continue, suppress the
      // fallback message entirely — the continuation task will pick up instead.
      if (
        result.contextOverflow &&
        (continuationCount[group.folder] ?? 0) < MAX_AUTO_CONTINUATIONS
      ) {
        // Swallow the "упёрлась в лимит" fallback — continuation is queued.
        cancelEdit(streamKey);
        streamingMessageId = null;
        streamingDraftStarted = false;
        return;
      }
      if (result.result) {
        // Skip duplicate send when there's no streaming draft to update.
        // (Auth-retry case: previous attempt already delivered final text.)
        // But when a streaming draft exists, the final result must replace it
        // via edit, so we fall through to the edit logic below.
        if (outputSentToUser && streamingMessageId === null) {
          return;
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (raw.trim()) {
          const intercepted = await interceptRateLimit(
            raw,
            router,
            replyJid,
            group.folder,
          );
          if (intercepted) {
            hadError = true;
            outputSentToUser = true;
            // If we had a streaming draft, drop it (intercept already sent its own).
            cancelEdit(streamKey);
            streamingMessageId = null;
            streamingDraftStarted = false;
          } else if (streamingMessageId !== null && channel.editMessage) {
            // Replace the draft with canonical final text. If text exceeds the
            // channel edit limit, edit the draft with the head, then send the
            // remainder as fresh follow-up messages so nothing is dropped.
            // Strip <internal> blocks here too — the edit path bypasses router.
            const cleaned = formatOutbound(raw);
            if (!cleaned) {
              // Whole result was internal; collapse the draft to a tiny marker
              // so suppressed content doesn't stay visible. (Channels don't
              // implement deleteMessage; smallest non-empty edit is safest.)
              cancelEdit(streamKey);
              if (channel.editMessage) {
                try {
                  await channel.editMessage(replyJid, streamingMessageId, '·');
                } catch (err) {
                  logger.debug(
                    { err },
                    'Failed to collapse internal-only draft',
                  );
                }
              }
              streamingMessageId = null;
              streamingDraftStarted = false;
              outputSentToUser = true;
            } else {
              const EDIT_LIMIT = 4000;
              const head =
                cleaned.length > EDIT_LIMIT
                  ? cleaned.slice(0, EDIT_LIMIT)
                  : cleaned;
              const tail =
                cleaned.length > EDIT_LIMIT ? cleaned.slice(EDIT_LIMIT) : '';
              const editFn = channel.editMessage.bind(channel);
              const msgId = streamingMessageId;
              scheduleEdit(streamKey, head, async (text) => {
                await editFn(replyJid, msgId, text);
              });
              await flushEdit(streamKey);
              streamingMessageId = null;
              streamingDraftStarted = false;
              outputSentToUser = true;
              if (tail.trim()) {
                await router.route({
                  chatJid: replyJid,
                  text: tail,
                  triggerType: 'agent-response',
                  groupFolder: group.folder,
                });
              }
            }
          } else {
            // No streaming draft (channel doesn't support edit, or first chunk
            // was the final result). Send as a fresh message via router.
            await router.route({
              chatJid: replyJid,
              text: raw,
              triggerType: 'agent-response',
              groupFolder: group.folder,
            });
            outputSentToUser = true;
          }
        }
        // (idle timer already reset at top of callback)
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
        cancelEdit(streamKey);
      }
    },
  );

  await channel.setTyping?.(replyJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  clearTimeout(hardKillTimer);

  // Log cost tracking data
  logAgentRun({
    groupFolder: agentGroup.folder,
    chatJid: replyJid,
    triggerType: 'message',
    inputTokens: agentResult.usage?.inputTokens || 0,
    outputTokens: agentResult.usage?.outputTokens || 0,
    cacheCreationTokens: agentResult.usage?.cacheCreationInputTokens || 0,
    cacheReadTokens: agentResult.usage?.cacheReadInputTokens || 0,
    durationMs: agentResult.durationMs,
    turns: agentResult.turns || 0,
    model: agentGroup.agentConfig?.model,
    status: agentResult.status === 'error' || hadError ? 'error' : 'success',
  });

  // Structured per-turn observability (agent_turns). One row per agent turn,
  // so channel leaks are one SQL query away. Never throws (mirrors logAgentRun).
  if (agentResult.channelTurns?.length) {
    logAgentTurns(agentGroup.folder, replyJid, agentResult.channelTurns);
  }

  // Post-run: record skill usage for any injected skills the agent referenced.
  // Heuristic: substring match of skill name or id in the final result text.
  if (injectedSkills.length > 0) {
    const haystack = (agentResult.result ?? '').toLowerCase();
    const runFailed = agentResult.status === 'error' || hadError;
    for (const skill of injectedSkills) {
      const referenced =
        haystack.includes(skill.name.toLowerCase()) ||
        haystack.includes(skill.id.toLowerCase());
      if (!referenced) continue;
      try {
        recordSkillUsage(
          skill.id,
          agentGroup.folder,
          runFailed ? 'failure' : 'success',
        );
      } catch (err) {
        logger.warn({ err, skill: skill.id }, 'recordSkillUsage failed');
      }
    }
  }

  // Post-run reflection: if this was a substantive multi-tool task, queue a
  // lightweight reflection run that may extract a new skill.
  // Rate-limited: max 1 reflection per 4 hours per group. Previous 30min
  // cooldown produced 60+ reflects/day, saturating the queue and delaying
  // user messages by hours.
  const turnsCount = agentResult.turns ?? 0;
  const toolsCount = agentResult.distinctToolsUsed ?? 0;
  const REFLECTION_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
  const lastReflectionAt = lastReflectionTime[agentGroup.folder] ?? 0;
  const reflectionCooledDown =
    Date.now() - lastReflectionAt >= REFLECTION_COOLDOWN_MS;
  if (
    agentResult.status === 'success' &&
    !hadError &&
    turnsCount >= 10 &&
    toolsCount > 3 &&
    reflectionCooledDown
  ) {
    try {
      lastReflectionTime[agentGroup.folder] = Date.now();
      const reflectionId = `reflect-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const reflectionPrompt = [
        `[REFLECT] Review the most recent task you just completed (${turnsCount} turns, ${toolsCount} distinct tools).`,
        'Did you solve a non-trivial problem in a way another agent (or future-you) would benefit from recalling?',
        'If yes: call skill_save with name (kebab-case), problem (recognizable situation), approach (concrete steps), and gotchas. Then reply "saved: <name>".',
        'If no: reply exactly "no skill" and nothing else.',
        'Do NOT message the user. Wrap any narration in <internal></internal>.',
      ].join('\n');
      createTask({
        id: reflectionId,
        group_folder: agentGroup.folder,
        chat_jid: replyJid,
        prompt: reflectionPrompt,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() + 5_000).toISOString(),
        context_mode: 'isolated',
        model: 'opus',
        next_run: new Date(Date.now() + 5_000).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.info(
        {
          group: agentGroup.folder,
          turns: turnsCount,
          tools: toolsCount,
          reflectionId,
        },
        'Reflection task queued',
      );
    } catch (err) {
      logger.warn(
        { err, group: agentGroup.folder },
        'Failed to queue reflection task',
      );
    }
  } else if (!reflectionCooledDown && turnsCount >= 10 && toolsCount > 3) {
    logger.debug(
      {
        group: agentGroup.folder,
        cooldownRemainingMs:
          REFLECTION_COOLDOWN_MS - (Date.now() - lastReflectionAt),
      },
      'Reflection skipped: cooldown active',
    );
  }

  // ─── Auto-continuation on context overflow ───
  // When the agent hit the context window limit (safety net fired), drop the
  // full session and queue a lightweight continuation task so the agent
  // picks up where it left off with a fresh context window. Cap at
  // MAX_AUTO_CONTINUATIONS to prevent infinite loops.
  // Context overflow triggers auto-continuation regardless of error status.
  // The whole point is that overflow IS an error-like condition - the runner
  // was doing real work and got cut off. Blocking on status !== 'error' meant
  // watchdog-killed runs (which exit as errors) never got continued.
  if (
    agentResult.contextOverflow &&
    (continuationCount[agentGroup.folder] ?? 0) < MAX_AUTO_CONTINUATIONS
  ) {
    continuationCount[agentGroup.folder] =
      (continuationCount[agentGroup.folder] ?? 0) + 1;
    const contNum = continuationCount[agentGroup.folder];
    logger.info(
      {
        group: agentGroup.folder,
        continuation: contNum,
        maxContinuations: MAX_AUTO_CONTINUATIONS,
      },
      'Context overflow detected, queuing auto-continuation',
    );

    // Drop the bloated session so the next run starts fresh.
    if (sessions[agentGroup.folder]) {
      delete sessions[agentGroup.folder];
      delete sessionLastActivity[agentGroup.folder];
      try {
        deleteSession(agentGroup.folder);
      } catch (err) {
        logger.debug(
          {
            err: err instanceof Error ? err.message : String(err),
            group: agentGroup.folder,
          },
          'Failed to delete session during continuation cleanup',
        );
      }
    }

    // Queue a continuation task that fires immediately. User just saw overflow and is waiting.
    const contId = `cont-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const contPrompt = [
      `[CONTINUATION ${contNum}/${MAX_AUTO_CONTINUATIONS}] Fresh start after context overflow.`,
      '',
      'Your previous run completed work via tools (files, messages, memory saves). It hit the context window limit.',
      'Read memory/ and vault/ to understand what was done. Do NOT repeat work already completed.',
      '',
      'Context budget rules to avoid overflow again:',
      '1. Use Edit (not Write) on files > 500 lines - Edit sends only the diff, saves context',
      '2. Break large tasks into phases: 1 phase per run, send intermediate update with send_message, then return',
      '3. Read only the file sections you need - not entire 2000-line CSS or typescript files',
      '4. If you reach ~30-40 turns, wrap up and summarize instead of continuing',
      '',
      'Continue from where work left off. If task is complete, just confirm it.',
    ].join('\n');
    try {
      createTask({
        id: contId,
        group_folder: agentGroup.folder,
        chat_jid: replyJid,
        prompt: contPrompt,
        schedule_type: 'once',
        schedule_value: new Date(Date.now() + 500).toISOString(), // 0.5s delay instead of 5s
        context_mode: 'group',
        next_run: new Date(Date.now() + 500).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      // Only clear in-progress AFTER task was successfully queued.
      // If createTask throws, we keep in_progress so crash recovery re-processes.
      consecutiveFailures[chatJid] = 0;
      clearInProgress();
      saveState();
    } catch (err) {
      logger.warn(
        { err, group: agentGroup.folder },
        'Failed to queue continuation task',
      );
      // Don't clear in-progress - let crash recovery handle it
    }
    return true;
  }
  // Reset continuation counter on any successful non-overflow run.
  if (!agentResult.contextOverflow) {
    continuationCount[agentGroup.folder] = 0;
  }

  if (agentResult.status === 'error' || hadError) {
    // CRITICAL: drop the session ID on ANY error path. The SDK session JSONL
    // has user inputs without their assistant replies (because we crashed
    // mid-thinking). On resume, the agent sees those user messages and
    // hallucinates "I already replied" because conversations don't normally
    // contain unanswered user turns. Forcing a fresh session prevents this
    // false-memory bug. Long-term context lives in memory/ files, not the
    // session JSONL, so we don't lose meaningful state.
    if (sessions[group.folder]) {
      logger.warn(
        { group: group.folder, droppedSession: sessions[group.folder] },
        'Dropping session after error to prevent stale-resume hallucinations',
      );
      delete sessions[group.folder];
      delete sessionLastActivity[group.folder];
      try {
        deleteSession(group.folder);
      } catch (err) {
        logger.debug(
          {
            err: err instanceof Error ? err.message : String(err),
            group: group.folder,
          },
          'Failed to delete session after error',
        );
      }
    }
    // If we already sent REAL output (IPC/streaming) before the final result,
    // don't roll back the cursor — re-processing would send duplicates.
    // Use outputSentBeforeFinal (not outputSentToUser) to avoid double-messaging:
    // when the only "output" was the error fallback text itself, we should NOT
    // send the extra "поломалось" notice — the user already got the error message.
    if (outputSentBeforeFinal) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      try {
        await router.route({
          chatJid: replyJid,
          text: 'Что-то поломалось после моего предыдущего ответа. Если ты писал что-то ещё — переотправь, я пропустила.',
          triggerType: 'agent-response',
          groupFolder: group.folder,
        });
      } catch (sendErr) {
        logger.warn(
          { err: sendErr, group: group.name },
          'Failed to send post-output failure notice',
        );
      }
      consecutiveFailures[chatJid] = 0;
      clearInProgress();
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    clearInProgress();
    consecutiveFailures[chatJid] = (consecutiveFailures[chatJid] || 0) + 1;
    logger.warn(
      { group: group.name, fails: consecutiveFailures[chatJid] },
      'Agent error, rolled back message cursor for retry',
    );

    // After 2 consecutive silent failures: tell the user something broke
    // (so they're not staring at silence) and write an incident file so
    // the self-heal pipeline can pick it up on the next approval.
    if (consecutiveFailures[chatJid] >= 2) {
      try {
        await router.route({
          chatJid: replyJid,
          text: 'Что-то поломалось на моей стороне, две попытки подряд. Если срочно — попробуй переформулировать или скинь содержимое напрямую. Я записала incident, починю.',
          triggerType: 'agent-response',
          groupFolder: group.folder,
        });
      } catch (sendErr) {
        logger.warn(
          { err: sendErr, group: group.name },
          'Failed to send user-facing failure message',
        );
      }
      try {
        const incidentsDir = path.join(
          GROUPS_DIR,
          agentGroup.folder,
          'incidents',
        );
        fs.mkdirSync(incidentsDir, { recursive: true });
        const id = `auto-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
        const file = path.join(incidentsDir, `${id}.md`);
        const errSnippet =
          (agentResult as { error?: string }).error?.slice(0, 1000) ||
          'no error string';
        const promptSnippet = prompt.slice(0, 2000);
        const body = [
          `# Auto-incident ${id}`,
          ``,
          `**Группа:** ${agentGroup.folder}`,
          `**Время:** ${new Date().toISOString()}`,
          `**Подряд провалов:** ${consecutiveFailures[chatJid]}`,
          ``,
          `## Ошибка`,
          ``,
          '```',
          errSnippet,
          '```',
          ``,
          `## Prompt (первые 2K)`,
          ``,
          '```',
          promptSnippet,
          '```',
          ``,
          `## Контекст`,
          ``,
          `Сообщения юзера получены, но agent run упал ${consecutiveFailures[chatJid]} раз подряд без отправки ответа. ` +
            `Юзер получил placeholder-сообщение. Approve этот incident (rename .md → .APPROVED) чтобы fixer-Claude диагностировал.`,
          ``,
        ].join('\n');
        await fs.promises.writeFile(file, body);
        logger.info(
          { file, group: agentGroup.folder },
          'Auto-incident written',
        );
      } catch (incErr) {
        logger.warn(
          { err: incErr, group: agentGroup.folder },
          'Failed to write auto-incident',
        );
      }
      // STOP retrying these messages — advance cursor past them. Infinite
      // retry loops (watchdog kill → rollback → retry → kill) are worse than
      // skipping a message. The user was notified and can resend if needed.
      // Set to current time so only NEW messages are picked up.
      // BUG FIX: previously used `delete` which caused '' fallback in
      // getMessagesSince, pulling 200 old messages and re-overflowing.
      lastAgentTimestamp[chatJid] = new Date().toISOString();
      consecutiveFailures[chatJid] = 0;
      saveState();
    }

    return false;
  }

  consecutiveFailures[chatJid] = 0;
  // Successful run: clear the in-progress crash-recovery marker.
  clearInProgress();

  // Advance cursor past any messages that were piped during the run.
  // The poll loop no longer advances lastAgentTimestamp when piping (to prevent
  // message loss on crash), so we catch up here on the success path.
  // Sequential mode never pipes — messages stay in DB unconsumed, so advancing
  // past them would silently drop them. Drain run will pick them up from cursor.
  if (!group.agentConfig?.sequentialMessages) {
    try {
      const postRunPending = getMessagesSince(
        chatJid,
        lastAgentTimestamp[chatJid] || '',
        ASSISTANT_NAME,
      );
      if (postRunPending.length > 0) {
        const agentEndTime = new Date().toISOString();
        // Only advance past messages that arrived BEFORE the run ended.
        // Messages arriving right now should wait for the next run.
        const msgsDuringRun = postRunPending.filter(
          (m) => m.timestamp <= agentEndTime,
        );
        if (msgsDuringRun.length > 0) {
          lastAgentTimestamp[chatJid] =
            msgsDuringRun[msgsDuringRun.length - 1].timestamp;
          saveState();
          logger.info(
            { group: group.name, advancedPast: msgsDuringRun.length },
            'Advanced cursor past messages piped during run',
          );
        }
      }
    } catch (err) {
      logger.debug({ err, group: group.name }, 'Post-run cursor check failed');
    }
  }

  // Self-heal celebration — if we just recovered from a rate-limit episode
  // (or other recent failure), brag to the user once. Hermes-style "look I
  // fixed myself" — turns the outage into proof of autonomy.
  const owed = recoveryCelebrationOwed[chatJid];
  if (owed) {
    const downtimeMin = Math.round((Date.now() - owed.sinceMs) / 60000);
    delete recoveryCelebrationOwed[chatJid];
    // Only brag if downtime was meaningful (>3 min) — short blips don't
    // warrant a separate message and feel needy.
    if (downtimeMin >= 3) {
      const base =
        recoveryBragMessages[
          Math.floor(Math.random() * recoveryBragMessages.length)
        ];
      const text =
        downtimeMin > 10 ? `${base} (был дауном ${downtimeMin} мин)` : base;
      try {
        await router.route({
          chatJid,
          text,
          triggerType: 'agent-response',
          groupFolder: group.folder,
        });
        logger.info(
          { group: group.folder, downtimeMin, reason: owed.reason },
          'Self-heal celebration sent',
        );
      } catch (err) {
        logger.warn({ err }, 'Failed to send recovery brag');
      }
    }
  }

  return true;
}

interface RunAgentResult {
  status: 'success' | 'error';
  usage?: ContainerOutput['usage'];
  durationMs: number;
  turns?: number;
  distinctToolsUsed?: number;
  result?: string | null;
  contextOverflow?: boolean;
  channelTurns?: ContainerOutput['channelTurns'];
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<RunAgentResult> {
  const isMain = group.isMain === true;
  const startTime = Date.now();
  const lastActivity = sessionLastActivity[group.folder];
  if (
    sessions[group.folder] &&
    lastActivity &&
    startTime - lastActivity > SESSION_STALE_MS
  ) {
    logger.info(
      {
        group: group.folder,
        idleMs: startTime - lastActivity,
        droppedSession: sessions[group.folder],
      },
      'Session stale, dropping to start fresh',
    );
    delete sessions[group.folder];
  }
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Track last usage data from streamed results
  let lastUsage: ContainerOutput['usage'] | undefined;
  let lastTurns: number | undefined;
  let lastDistinctTools: number | undefined;
  let lastResultText: string | null = null;
  let lastChannelTurns: ContainerOutput['channelTurns'] | undefined;

  // Wrap onOutput to track session ID and usage from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        // Reset inactivity watchdog: any output (text, partial, result,
        // session id) means the agent is alive. Without this the watchdog
        // would kill long-running multi-turn conversations.
        queue.noteActivity(chatJid);
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          sessionLastActivity[group.folder] = Date.now();
          setSession(group.folder, output.newSessionId);
        }
        if (output.usage) lastUsage = output.usage;
        if (output.turns !== undefined) lastTurns = output.turns;
        if (output.distinctToolsUsed !== undefined)
          lastDistinctTools = output.distinctToolsUsed;
        if (output.channelTurns) lastChannelTurns = output.channelTurns;
        if (output.result) lastResultText = output.result;
        await onOutput(output);
      }
    : undefined;

  try {
    const runtime = group.runtime || DEFAULT_RUNTIME;
    // Route model: explicit group override wins, otherwise classify prompt.
    // Use the async LLM-assisted router so trivial prompts can be downgraded
    // to haiku while genuinely ambiguous ones still default to opus.
    const routedModel = await selectModelAsync(
      prompt,
      { groupFolder: group.folder },
      group.agentConfig?.model,
    );
    const agentInput = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      agentConfig: { ...group.agentConfig, model: routedModel },
    };
    const onProcessCb = (proc: any, name: string) =>
      queue.registerProcess(chatJid, proc, name, group.folder);

    const runAgent = () =>
      runtime === 'sandbox'
        ? runSandboxAgent(group, agentInput, onProcessCb, wrappedOnOutput)
        : runContainerAgent(group, agentInput, onProcessCb, wrappedOnOutput);

    let output = await runAgent();

    // Auth-error auto-recovery: if the run failed with a 401 in its error
    // text, force-refresh the OAuth token from keychain and retry once.
    // Sandbox mode only (container uses credential proxy, not OAuth).
    const authErrorPattern =
      /(API Error: 401|authentication_error|Invalid authentication credentials)/i;
    if (
      runtime === 'sandbox' &&
      output.status === 'error' &&
      typeof output.error === 'string' &&
      authErrorPattern.test(output.error)
    ) {
      logger.warn(
        { group: group.name },
        'Auth 401 detected, forcing keychain refresh and retrying once',
      );
      try {
        // `claude -p ok` runs OUTSIDE sandbox, forces keychain rotation
        // Use async execFile to avoid blocking the event loop
        const { execFile } = await import('child_process');
        await new Promise<void>((resolve, reject) => {
          execFile(
            'claude',
            ['-p', 'ok', '--output-format', 'text', '--max-turns', '1'],
            {
              timeout: 25000,
            },
            (err) => {
              if (err) reject(err);
              else resolve();
            },
          );
        });
        output = await runAgent();
      } catch (refreshErr) {
        logger.error(
          {
            err:
              refreshErr instanceof Error
                ? refreshErr.message
                : String(refreshErr),
          },
          'Token refresh failed during auth-retry',
        );
      }
    }

    const durationMs = Date.now() - startTime;

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      sessionLastActivity[group.folder] = Date.now();
      setSession(group.folder, output.newSessionId);
    }

    // Use usage from the output directly, or from the last streamed output
    const usage = output.usage || lastUsage;
    const turns = output.turns ?? lastTurns;
    const distinctToolsUsed = output.distinctToolsUsed ?? lastDistinctTools;
    const result = output.result ?? lastResultText;
    const channelTurns = output.channelTurns ?? lastChannelTurns;

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        `${runtime === 'sandbox' ? 'Sandbox' : 'Container'} agent error`,
      );
      // Infer context overflow from streamed turn count when the runner
      // was killed (watchdog, SIGKILL) before it could set the flag.
      // Threshold: 30 turns (not 20) to avoid false positives from
      // runs that fail for non-overflow reasons (auth, network, bugs).
      // The runner itself now reports contextOverflow natively for most
      // cases; this inference is only for watchdog kills.
      const inferredOverflow = output.contextOverflow || (turns ?? 0) >= 30;
      if (inferredOverflow && !output.contextOverflow) {
        logger.info(
          { group: group.name, turns, durationMs },
          'Inferring contextOverflow from high turn count on error exit',
        );
      }
      return {
        status: 'error',
        usage,
        durationMs,
        turns,
        distinctToolsUsed,
        result,
        contextOverflow: inferredOverflow || undefined,
        channelTurns,
      };
    }

    return {
      status: 'success',
      usage,
      durationMs,
      turns,
      distinctToolsUsed,
      result,
      contextOverflow: output.contextOverflow,
      channelTurns,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error({ group: group.name, err }, 'Agent error');
    // Preserve tracked data from streamed outputs so auto-continuation
    // can fire even when the runner process crashes (watchdog kill, OOM, etc).
    // Heuristic: 30+ turns before crash strongly suggests context overflow.
    // Lower counts are more likely transient failures (auth, network, etc).
    const inferredOverflow = (lastTurns ?? 0) >= 30;
    if (inferredOverflow) {
      logger.info(
        { group: group.name, lastTurns, durationMs },
        'Inferring contextOverflow from high turn count on crash',
      );
    }
    return {
      status: 'error',
      durationMs,
      usage: lastUsage,
      turns: lastTurns,
      distinctToolsUsed: lastDistinctTools,
      result: lastResultText,
      contextOverflow: inferredOverflow || undefined,
      channelTurns: lastChannelTurns,
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`ClaudeClaw running (trigger: @${ASSISTANT_NAME})`);

  // Heartbeat: log every 5 minutes to prove the loop is alive.
  // Absence of heartbeat in logs = service silently died.
  let lastHeartbeat = Date.now();
  const HEARTBEAT_INTERVAL = 5 * 60 * 1000;

  while (true) {
    if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
      lastHeartbeat = Date.now();
      logger.info('Poll loop heartbeat (alive)');
    }
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Quiet-period debounce. Hermes uses 0.6s text / 0.8s media; OpenClaw
          // 1.5-2s default. We use 2s text / 4s if voice or photo present
          // (Whisper-induced latency and brain-dump bursts can space TG arrivals
          // by 2-3 seconds). Override via agentConfig.debounceMs.
          //
          // Mechanism: if the newest queued message arrived less than the
          // window ago, skip this poll iteration. The messages stay in DB,
          // lastAgentTimestamp[chatJid] is NOT advanced; next poll re-checks.
          // When user finally pauses → window expires → all batched into ONE
          // <messages> block to the agent. Result: 5 voices in 30s = ONE
          // agent run with full context, not 5 fragmented runs.
          // Two-tier debounce (Hermes pattern):
          //  - 600ms default for normal text (instant feel for single msg)
          //  - 2000ms when last chunk approaches 4000-char Telegram split
          //    threshold (split detection — wait for continuation)
          //  - 4000ms when voice/photo present (Whisper latency padding)
          const hasMedia = messagesToSend.some((m) =>
            /\[Voice:|\[Audio:|\[Photo|\[Document:|\[Video|\[PDF:/.test(
              m.content,
            ),
          );
          const lastMsgLen =
            messagesToSend[messagesToSend.length - 1].content.length;
          const isSplitCandidate = lastMsgLen >= 3900;
          const defaultDebounce = hasMedia
            ? 4000
            : isSplitCandidate
              ? 2000
              : 600;
          const debounceMs = group.agentConfig?.debounceMs ?? defaultDebounce;
          const newestTs = messagesToSend[messagesToSend.length - 1].timestamp;
          const ageMs = Date.now() - new Date(newestTs).getTime();
          if (ageMs < debounceMs) {
            logger.debug(
              { chatJid, ageMs, debounceMs, batched: messagesToSend.length },
              'Debouncing — quiet-period not reached, will re-check after window',
            );
            // Critical: schedule a re-check after the debounce window closes.
            // Without this, lastTimestamp has already advanced past the
            // message and the poll loop won't see it again — message is lost.
            // queue.enqueueMessageCheck triggers processGroupMessages which
            // pulls everything since lastAgentTimestamp[chatJid] (still old).
            const delayMs = debounceMs - ageMs + 200;
            setTimeout(() => {
              try {
                queue.enqueueMessageCheck(chatJid);
              } catch (err) {
                logger.warn(
                  { chatJid, err },
                  'Failed to enqueue debounce re-check',
                );
              }
            }, delayMs).unref();
            continue;
          }

          // Sequential mode: when group is configured for serial processing,
          // never inject mid-flight. New messages wait in DB until the
          // current run completes; the next poll iteration spawns a fresh
          // run that consumes them with full context (resume keeps session).
          // Without this, multiple voices sent in succession get mixed into
          // the running query and the agent can drop or merge replies.
          const sequential = Boolean(group.agentConfig?.sequentialMessages);
          if (sequential) {
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // DO NOT advance lastAgentTimestamp here. The pipe is fire-and-forget:
            // if the sandbox crashes before consuming the piped message, the cursor
            // would be past it and the message is permanently lost. By leaving the
            // cursor unchanged, processGroupMessages on the NEXT run will include
            // piped messages in its initial batch (safe duplicate, not lost data).
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

export async function main(): Promise<void> {
  // Database must be initialized BEFORE querying registered groups
  initDatabase(getExtensionDbSchema());
  logger.info('Database initialized');

  // TodoStore is file-based (groups/<folder>/.todos.json), no DB init needed.
  // Both orchestrator and sandbox MCP server share the same JSON file.

  // Runtime-dependent initialization
  const allGroups = Object.values(getAllRegisteredGroups());
  const needsContainers =
    DEFAULT_RUNTIME === 'container' ||
    allGroups.some((g) => (g.runtime || DEFAULT_RUNTIME) === 'container');
  const needsSandbox =
    DEFAULT_RUNTIME === 'sandbox' ||
    allGroups.some((g) => (g.runtime || DEFAULT_RUNTIME) === 'sandbox');

  if (needsContainers) {
    ensureContainerSystemRunning();
  }
  if (needsSandbox) {
    ensureSandboxRuntimeAvailable();
    cleanupSandboxOrphans();
  }

  loadState();
  restoreRemoteControl();

  // Seed system tasks (dreaming, cost-watch) for every registered group.
  // Idempotent — existing rows are skipped by id check.
  try {
    const { seedSystemTasks } = await import('./dreaming.js');
    for (const [jid, group] of Object.entries(registeredGroups)) {
      const isSubGroup = /_thread_|_trigger$/.test(group.folder);
      if (isSubGroup) continue;
      seedSystemTasks(jid, group);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to seed system tasks at startup');
  }

  // Start credential proxy only if container runtime is active
  // (sandbox mode passes credentials directly — no proxy needed)
  let proxyServer: Awaited<ReturnType<typeof startCredentialProxy>> | undefined;
  if (needsContainers) {
    proxyServer = await startCredentialProxy(
      CREDENTIAL_PROXY_PORT,
      PROXY_BIND_HOST,
    );
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer?.close();
    await queue.shutdown();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await router.send(chatJid, result.url);
      } else {
        await router.send(chatJid, `Remote Control failed: ${result.error}`);
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await router.send(chatJid, 'Remote Control session ended.');
      } else {
        await router.send(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
      // Immediately tell the queue a new message arrived. Without this, we
      // depend on the polling loop to discover it — which races with the
      // sandbox-completion cleanup. When sandbox finishes between the
      // user's send and the next poll tick, drainGroup() sees
      // pendingMessages=false and goes idle; polling later finds the
      // message but state.active is still being torn down — handover is
      // dropped, message rots in DB. Direct enqueue eliminates the race.
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        try {
          queue.enqueueMessageCheck(chatJid);
        } catch (err) {
          logger.warn(
            { chatJid, err: err instanceof Error ? err.message : String(err) },
            'enqueueMessageCheck after storeMessage failed (polling fallback active)',
          );
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
  };

  // Create router BEFORE connecting channels. The router closes over the
  // `channels` array reference, so channels added later are visible to it.
  // This prevents a TDZ bug: if a channel delivers a message synchronously
  // during connect(), handleRemoteControl needs router to be initialized.
  const router = createMessageRouter(channels);
  router.addPreHook(createFactCheckHook(GROUPS_DIR));

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    router,
  });
  const ingestion = createMessageIngestion({
    checkTrigger: (chatJid, sender) => {
      const group = registeredGroups[chatJid];
      if (!group) return { needsTrigger: true, hasTrigger: false };
      const isMainGroup = group.isMain === true;
      const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
      if (!needsTrigger) return { needsTrigger: false, hasTrigger: true };
      // For ingestion callers (webhook, extension), trigger check uses sender allowlist.
      // Channel messages bypass ingestion entirely (handled by the polling loop with
      // full trigger pattern matching on message content).
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = isTriggerAllowed(chatJid, sender, allowlistCfg);
      return { needsTrigger, hasTrigger };
    },
    enqueueMessageCheck: (chatJid) => queue.enqueueMessageCheck(chatJid),
  });

  // Wire extension hooks into services
  wireExtensionHooks(ingestion, router);

  // Start all plugins (triage, etc.)
  callExtensionStartup({
    ingestion,
    router,
    logger,
    // Backward compat (deprecated):
    sendMessage: async (jid, text) => router.send(jid, text),
    findChannel: (jid) => findChannel(channels, jid),
  });

  startIpcWatcher({
    router,
    queue,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    channels,
  });
  // Start webhook server if configured
  if (WEBHOOK_SECRET) {
    startWebhookServer(WEBHOOK_PORT, WEBHOOK_SECRET, {
      ingestion,
      findGroupByFolder: (folder) => {
        for (const [jid, group] of Object.entries(registeredGroups)) {
          if (group.folder === folder) return { jid, name: group.name };
        }
        return undefined;
      },
      wakeDeps: {
        queue,
        router,
        sessions: () => sessions,
        onProcess: (groupJid, proc, containerName, groupFolder) =>
          queue.registerProcess(groupJid, proc, containerName, groupFolder),
        findGroup: (folder) => {
          for (const group of Object.values(registeredGroups)) {
            if (group.folder === folder) return group;
          }
          return undefined;
        },
        findJid: (folder) => {
          for (const [jid, group] of Object.entries(registeredGroups)) {
            if (group.folder === folder) return jid;
          }
          return undefined;
        },
      },
    });
  }

  // Self-heal: watch for approved incidents, spawn fixer-Claude, report back
  const { startSelfHealWatcher } = await import('./selfheal.js');
  startSelfHealWatcher(channels);

  queue.setProcessMessagesFn((chatJid) =>
    processGroupMessages(chatJid, router),
  );
  queue.setCheckPendingFn((chatJid) => {
    try {
      const cursor = lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, cursor, ASSISTANT_NAME);
      return pending.length > 0;
    } catch {
      return false;
    }
  });
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}
