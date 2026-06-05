/**
 * ClaudeClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { buildAppendedSystemPrompt } from './prompt-builder.js';
import { resolveChannelOutput, pickLongestSegment } from './channel-output.js';
import type { ChannelTurnLog } from './channel-output.js';

interface AgentConfig {
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentConfig?: AgentConfig;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  durationMs?: number;
  turns?: number;
  distinctToolsUsed?: number;
  /** Per-turn structured log for the agent_turns observability table. */
  channelTurns?: ChannelTurnLog[];
  /** True when the SDK ended due to context overflow (error_max_turns / budget). */
  contextOverflow?: boolean;
  /**
   * Streaming: intermediate assistant text (full accumulated, not delta).
   * The host edits its in-flight outbound draft instead of sending a new
   * message. Final SDK 'result' message still arrives as `partial: false`.
   */
  partial?: boolean;
  partialText?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Runtime-agnostic path resolution:
// Docker/Container: paths are /workspace/* via volume mounts (env vars absent, fallback used)
// Sandbox: CLAUDECLAW_*_DIR env vars provide actual host paths
const WORKSPACE_GROUP   = process.env.CLAUDECLAW_GROUP_DIR   || '/workspace/group';
const WORKSPACE_IPC     = process.env.CLAUDECLAW_IPC_DIR     || '/workspace/ipc';
const WORKSPACE_PROJECT = process.env.CLAUDECLAW_PROJECT_DIR || '/workspace/project';
const WORKSPACE_GLOBAL  = process.env.CLAUDECLAW_GLOBAL_DIR  || '/workspace/global';
const WORKSPACE_EXTRA   = process.env.CLAUDECLAW_EXTRA_DIR   || '/workspace/extra';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);

      // Memory flush: extract key facts and append to daily memory log
      try {
        const memoryDir = path.join(WORKSPACE_GROUP, 'memory', 'daily');
        fs.mkdirSync(memoryDir, { recursive: true });
        const memoryFile = path.join(memoryDir, `${date}.md`);

        if (!fs.existsSync(memoryFile)) {
          fs.writeFileSync(memoryFile, `# Memory — ${date}\n\n`);
        }

        // Save a compaction marker with summary and message count
        const flushEntry = summary
          ? `- [${new Date().toISOString().split('T')[1].split('.')[0]}] [compaction] ${summary} (${messages.length} messages archived)\n`
          : `- [${new Date().toISOString().split('T')[1].split('.')[0]}] [compaction] ${messages.length} messages archived to conversations/${filename}\n`;
        fs.appendFileSync(memoryFile, flushEntry);
        log(`Memory flush: wrote summary to ${memoryFile}`);
      } catch (memErr) {
        log(`Memory flush failed: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
      }
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

/**
 * PostCompact hook — verify memory flush succeeded and log compaction event.
 */
function createPostCompactHook(): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const date = new Date().toISOString().split('T')[0];
    const memoryFile = path.join(WORKSPACE_GROUP, 'memory', 'daily', `${date}.md`);

    if (fs.existsSync(memoryFile)) {
      log('PostCompact: memory flush verified — daily log exists');
    } else {
      log('PostCompact: no daily memory log found — PreCompact flush may have failed');
    }

    // Re-inject the active todo list so the model doesn't lose its plan
    // across the compaction event. Pattern from Hermes Agent — the killer
    // feature that makes long autonomous tasks reliable. Stored in
    // .todo-injection.md so a UserPromptSubmit hook (or the next user
    // message handler) can prepend it before the next turn.
    try {
      const todoFile = path.join(WORKSPACE_GROUP, '.todos.json');
      if (fs.existsSync(todoFile)) {
        const data = JSON.parse(fs.readFileSync(todoFile, 'utf-8')) as {
          todos?: Array<{ id: number; content: string; status: string }>;
        };
        const active = (data.todos || []).filter(
          (t) => t.status === 'pending' || t.status === 'in_progress',
        );
        if (active.length > 0) {
          const markers: Record<string, string> = {
            pending: '[ ]',
            in_progress: '[→]',
            completed: '[x]',
            cancelled: '[-]',
          };
          const lines = ['[Your active task list was preserved across context compression]'];
          active.forEach((t, idx) => {
            lines.push(`- ${markers[t.status] || '[?]'} ${idx + 1}. ${t.content} (${t.status})`);
          });
          lines.push('[Continue from where you left off. Mark items completed via the todo tool as you finish.]');
          const injectionText = lines.join('\n');
          // Try the SDK's additionalContext mechanism (supported in newer
          // versions). Cast through any since the type union doesn't
          // formally include PostCompact-specific output.
          log(`PostCompact: injecting ${active.length} active todos into context`);
          return { hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: injectionText } } as any;
        }
      }
    } catch (err) {
      log(`PostCompact todo re-injection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

/**
 * Stop hook — fires when agent run terminates (whether normally or due to errors).
 * Detects API errors via stop_hook_active flag and notifies user through IPC.
 */
function createStopHook(chatJid: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const stopInput = input as { hook_event_name?: string; stop_hook_active?: boolean; last_assistant_message?: string };

    // Only notify on actual stop_hook_active (agent halted, not normal completion)
    if (stopInput.stop_hook_active) {
      const lastMsg = stopInput.last_assistant_message || 'Unknown stop';
      const errorMsg = lastMsg.substring(0, 200); // truncate long messages
      log(`Stop: agent halted - ${errorMsg}`);

      // Write IPC message to notify user through their channel
      try {
        const ipcMessagesDir = path.join(WORKSPACE_IPC, 'messages');
        fs.mkdirSync(ipcMessagesDir, { recursive: true });
        const filename = `${Date.now()}-agent-stop.json`;
        const data = {
          type: 'message',
          chatJid,
          text: `Agent stopped: ${errorMsg}`,
          timestamp: new Date().toISOString(),
        };
        const tempPath = path.join(ipcMessagesDir, `${filename}.tmp`);
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, path.join(ipcMessagesDir, filename));
      } catch (ipcErr) {
        log(`Failed to write Stop IPC notification: ${ipcErr instanceof Error ? ipcErr.message : String(ipcErr)}`);
      }
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  browserMcpPath?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; usage: ContainerOutput['usage']; turns: number; distinctToolsUsed: number }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for the _close sentinel. We DO NOT pipe new IPC messages into
  // the active query anymore — that legacy "warm sequential" feature
  // crashes the SDK (sdk.mjs unhandled exception) when a new message
  // arrives just as opus is finishing its final result, killing the entire
  // run and losing the about-to-be-delivered reply. Symptom we hunted all
  // day: opus does 30+ turns, would-be-final response evaporates, fallback
  // emits "Я отработала N turn'ов..." while user thinks bot is broken.
  //
  // With single-shot mode (runner exits after its first run), each new
  // user message spawns a fresh sandbox via the orchestrator's normal
  // queue path. No piping needed. Just drain so files don't accumulate.
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      try { stream.end(); } catch { /* stream already closed */ }
      ipcPolling = false;
      return;
    }
    // Don't drain or push IPC files during a live query. drainIpcInput
    // would also delete them, losing user messages. Leaving them in place
    // means: (a) the next sandbox spawn picks them up via the startup
    // drainIpcInput() call (line ~950); (b) the orchestrator's normal
    // queue path will spawn that next sandbox once we exit (single-shot).
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Usage tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let turns = 0;
  const toolsSeen = new Set<string>();

  // Streaming state — emit partial text on each assistant message, throttled.
  let accumulatedAssistantText = '';
  let lastPartialEmitMs = 0;
  // Per-turn text buffer: all text blocks emitted since the last `result`
  // event. The SDK's `result.result` only carries the LAST assistant text
  // block (everything after the final tool_use), so a "long answer → tool
  // call → short tail" turn loses the long answer when streaming is disabled
  // (only result.result is delivered). turnText preserves the whole reply.
  // Reset on each result to avoid leaking across auto-continuation turns.
  let turnText = '';
  // Every contiguous text segment that completed BEFORE a tool_use. Each
  // tool_use pushes the current turnText here and resets it. At the result
  // event we pick the LONGEST segment as the real answer. This fixes both
  // failure shapes at once: "narration → tool → answer" (short narration
  // loses to long answer) and "answer → tool → short tail" (long answer
  // beats the tail). Snapshotting only the last segment lost the answer in
  // the second shape; the longest-wins heuristic keeps it.
  const completedSegments: string[] = [];
  // Tool names invoked since the last `result` event. Reset each turn, used
  // to populate ChannelTurnLog.toolsCalled (best-effort per-turn breakdown).
  const turnTools: string[] = [];
  // Per-run structured turn log, piggybacked on the final output payload so
  // the orchestrator can persist it to agent_turns (the sandboxed runner has
  // no direct DB access).
  const channelTurns: ChannelTurnLog[] = [];

  // Tracks whether ANY `result` event from the SDK carried actual text
  // (i.e. SDKResultSuccess with .result string). When the SDK ends without
  // a text-bearing result (e.g. SDKResultError with subtype=error_max_turns
  // / error_max_budget_usd / error_during_execution), we synthesize a
  // fallback reply after the loop so the user is never left in silence.
  let sentResultWithText = false;
  // Track whether the SDK actually hit context/budget limits (vs tool-loop
  // halt, clean exit without text, or other non-overflow terminations).
  // Only these should trigger auto-continuation in message-loop.
  let sawContextOverflow = false;

  // Tool-loop guardrails — pattern from Hermes Agent. Track per-run tool
  // call hashes; if the agent calls the same tool with identical args 3+
  // times in a row, abort the stream — it's thrashing. Saves tokens and
  // prevents the "30 iterations on broken gh command" failure.
  const toolCallCounts = new Map<string, number>();
  const TOOL_LOOP_HALT_THRESHOLD = 3;
  let loopHaltedReason: string | null = null;
  function hashToolCall(name: string, input: unknown): string {
    let inputStr: string;
    try {
      inputStr = JSON.stringify(input);
    } catch {
      inputStr = String(input);
    }
    return `${name}:${inputStr}`;
  }

  // Smart heartbeat with two states:
  //   1. AWAITING RESULT (between push and result event) — if no SDK events
  //      for HEARTBEAT_GRACE_MS, agent is genuinely stuck (rate-limit retry
  //      deadlock, network freeze, SDK internal hang). Suppress heartbeat
  //      → watchdog SIGKILLs.
  //   2. IDLE-WAIT (after a result event, before next user push) — this is
  //      normal: SDK iterator is parked awaiting next stream input. Keep
  //      emitting heartbeat so watchdog doesn't kill healthy idle wait.
  //      The orchestrator's _close sentinel handles graceful shutdown.
  //
  // `awaitingResult` is set true on each stream.push (in pollIpcDuringQuery
  // and the initial push), cleared on each result event.
  let lastSdkEventAt = Date.now();
  let awaitingResult = true; // initial prompt is pushed before for-await starts
  const HEARTBEAT_GRACE_MS = 90_000;
  const heartbeatInterval = setInterval(() => {
    const sinceLastEvent = Date.now() - lastSdkEventAt;
    if (awaitingResult && sinceLastEvent > HEARTBEAT_GRACE_MS) {
      log(`Heartbeat suppressed: stuck mid-query, no SDK events for ${Math.round(sinceLastEvent / 1000)}s — letting watchdog see truth`);
      return;
    }
    writeOutput({
      status: 'success',
      result: null,
      partial: true,
      partialText: '',
    });
  }, 60_000);
  if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();
  const PARTIAL_EMIT_INTERVAL_MS = 500;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = path.join(WORKSPACE_GLOBAL, 'CLAUDE.md');
  let globalMarkdown: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalMarkdown = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Apply per-group agent config overrides
  const agentCfg = containerInput.agentConfig;

  // Background runs (dreaming, reflection) skip the skill nudge
  const isBackgroundRun = /^\[(DREAM|REFLECT)/i.test(containerInput.prompt ?? '');

  // Assemble appended system prompt - layers user markdown, skill nudge,
  // and the code-owned factuality rule. See agent/runner/src/prompt-builder.ts.
  // Behaviour-preserving extraction of the previous inline blocks.
  const globalClaudeMd = buildAppendedSystemPrompt({
    globalMarkdown,
    perGroupOverride: agentCfg?.systemPrompt,
    isBackgroundRun,
    userMessage: containerInput.prompt,
    groupDir: WORKSPACE_GROUP,
  });

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = WORKSPACE_EXTRA;
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Determine allowed tools (per-group override or defaults)
  const defaultAllowedTools = [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__claudeclaw__*',
    'mcp__claudeclaw-browser__*'
  ];
  const allowedTools = agentCfg?.allowedTools && agentCfg.allowedTools.length > 0
    ? agentCfg.allowedTools
    : defaultAllowedTools;

  // Ensure memory directory exists for auto-memory + our memory tools
  const memoryDir = path.join(WORKSPACE_GROUP, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  // Build query options
  const queryOptions: Record<string, any> = {
    cwd: WORKSPACE_GROUP,
    autoMemoryDirectory: memoryDir, // v2.1.80+ — unifies SDK auto-memory with our memory_save/memory_search
    additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
    betas: ['context-1m-2025-08-07'], // Enable 1M token context window
    resume: sessionId,
    resumeSessionAt: resumeAt,
    systemPrompt: globalClaudeMd
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
      : undefined,
    allowedTools,
    env: sdkEnv,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'],
    mcpServers: {
      claudeclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          CLAUDECLAW_CHAT_JID: containerInput.chatJid,
          CLAUDECLAW_GROUP_FOLDER: containerInput.groupFolder,
          CLAUDECLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
      // Browser MCP — connects to the host-side Chromium daemon over CDP.
      // Tools become no-ops with a clear "start the daemon" error if the
      // daemon is offline; they only really activate when the user has
      // launched ./scripts/browser-daemon.sh.
      ...(browserMcpPath
        ? {
            'claudeclaw-browser': {
              command: 'node',
              args: [browserMcpPath],
              env: {
                CLAUDECLAW_BROWSER_CDP_URL:
                  process.env.CLAUDECLAW_BROWSER_CDP_URL || 'http://localhost:9222',
              },
            },
          }
        : {}),
    },
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      PostCompact: [{ hooks: [createPostCompactHook()] }],
      Stop: [{ hooks: [createStopHook(containerInput.chatJid)] }],
    },
  };

  // Apply per-group model override
  if (agentCfg?.model) {
    queryOptions.model = agentCfg.model;
  }

  // Apply per-group maxTurns override
  if (agentCfg?.maxTurns) {
    queryOptions.maxTurns = agentCfg.maxTurns;
  }

  // Apply per-group effort override (v2.1.78+)
  if (agentCfg?.effort) {
    queryOptions.effort = agentCfg.effort;
  }

  // Apply per-group disallowed tools (v2.1.78+ — blacklist on top of allowlist)
  if (agentCfg?.disallowedTools && agentCfg.disallowedTools.length > 0) {
    queryOptions.disallowedTools = agentCfg.disallowedTools;
  }

  for await (const message of query({
    prompt: stream,
    options: queryOptions,
  })) {
    messageCount++;
    // Mark SDK as alive — heartbeat will emit if this is recent.
    lastSdkEventAt = Date.now();
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      turns++;
      // Track distinct tools the agent invoked, for reflection-trigger heuristics.
      const content = (message as { message?: { content?: unknown } }).message?.content;
      let assistantText = '';
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') {
            const blockType = (block as { type?: string }).type;
            if (blockType === 'tool_use') {
              const name = (block as { name?: string }).name;
              if (typeof name === 'string') {
                toolsSeen.add(name);
                turnTools.push(name);
              }
              // Loop detection: count identical (tool, args) calls.
              const toolInput = (block as { input?: unknown }).input;
              if (typeof name === 'string') {
                const hash = hashToolCall(name, toolInput);
                const prev = toolCallCounts.get(hash) || 0;
                const next = prev + 1;
                toolCallCounts.set(hash, next);
                if (next >= TOOL_LOOP_HALT_THRESHOLD && !loopHaltedReason) {
                  loopHaltedReason = `tool-loop-detected: ${name} called ${next} times with identical args`;
                  log(`Tool-loop guardrail tripped: ${loopHaltedReason}`);
                  try {
                    stream.end();
                  } catch {
                    /* stream may already be closed */
                  }
                }
              }
              // Segment boundary: the text accumulated so far completed before
              // this tool call. Push it (keeping earlier segments) and reset so
              // the next segment is fresh. The longest segment wins at result.
              if (turnText.trim()) {
                completedSegments.push(turnText);
                turnText = '';
              }
            } else if (blockType === 'text') {
              const text = (block as { text?: string }).text;
              if (typeof text === 'string') {
                assistantText += text;
                turnText += text;
              }
            }
          }
        }
      }
      // Streaming: emit partial output for in-flight text. Throttled to
      // ~500ms so we don't flood IPC; final 'result' message will emit
      // the canonical full text again with partial:false.
      if (assistantText.trim()) {
        accumulatedAssistantText += assistantText;
        const now = Date.now();
        if (now - lastPartialEmitMs >= PARTIAL_EMIT_INTERVAL_MS) {
          lastPartialEmitMs = now;
          writeOutput({
            status: 'success',
            result: null,
            partial: true,
            partialText: accumulatedAssistantText,
          });
        }
      } else {
        // Heartbeat for tool-only assistant turns: even when no text is
        // generated (agent is just calling tools) we emit an empty partial
        // so the orchestrator's inactivity watchdog can reset. Without
        // this, long tool sequences (file edits, sql queries) read as
        // "no activity" and the watchdog SIGKILLs healthy long runs.
        writeOutput({
          status: 'success',
          result: null,
          partial: true,
          partialText: '',
        });
      }
    }

    // Capture usage data from messages
    if ('usage' in message) {
      const u = (message as any).usage;
      if (u) {
        totalInputTokens += u.input_tokens || 0;
        totalOutputTokens += u.output_tokens || 0;
        totalCacheCreation += u.cache_creation_input_tokens || 0;
        totalCacheRead += u.cache_read_input_tokens || 0;
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      // Mark that we've completed a turn — heartbeat will keep emitting in
      // idle-wait state (between turns). Set back to true on next push.
      awaitingResult = false;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      // Prefer the full accumulated turn text over the SDK's result.result,
      // which only holds the last text block (after the final tool_use). When
      // there was no text before a tool call, turnText === result.result and
      // behavior is unchanged; otherwise turnText is the superset the user
      // should actually see. Reset after consuming so the next turn (auto-
      // continuation) starts clean.
      // Pick the LONGEST text segment of the turn as the answer. Segments
      // captured before tool calls live in completedSegments; the trailing
      // segment is still in turnText. Longest-wins keeps the real answer
      // whether it came before a tool (e.g. answer → save → short tail) or
      // after (narration → tool → answer). Fall back to the SDK's result.
      // Delivery decision lives in the pure resolveChannelOutput guard
      // (./channel-output.ts) so it is unit-testable without the SDK. It picks
      // the longest text segment of the turn (segments captured before tool
      // calls live in completedSegments; the trailing segment is in turnText),
      // falls back to the SDK result, and classifies the result as api-error /
      // autonomous-run / empty / deliverable. The candidate is recomputed here
      // only for logging and the api-error throw text. See channel-output.ts
      // for the per-incident mapping.
      const isAutonomousRun = containerInput.isScheduledTask === true || isBackgroundRun;
      const candidate =
        pickLongestSegment(completedSegments, turnText) || (textResult ?? '');
      const decision = resolveChannelOutput({
        completedSegments,
        trailingText: turnText,
        sdkResultText: textResult ?? null,
        isAutonomousRun,
      });
      turnText = '';
      completedSegments.length = 0;
      const resultSubtype = message.subtype;
      log(`Result #${resultCount}: subtype=${resultSubtype}${candidate ? ` text=${candidate.slice(0, 200)}` : ''}`);
      // Structured per-turn log (agent_turns observability). Best-effort; never
      // throws. runKind: error subtype wins, then background (dream/reflect),
      // then scheduled, else interactive. toolsCalled is the per-turn tool list.
      const isErrorSubtype =
        typeof resultSubtype === 'string' && resultSubtype.startsWith('error');
      const isReflectRun = /^\[REFLECT/i.test(containerInput.prompt ?? '');
      channelTurns.push({
        turnIndex: resultCount,
        runKind: isErrorSubtype
          ? 'error'
          : isBackgroundRun
            ? (isReflectRun ? 'reflect' : 'dream')
            : containerInput.isScheduledTask === true
              ? 'scheduled'
              : 'interactive',
        toolsCalled: [...turnTools],
        textGeneratedChars: candidate.length,
        textSentChars: decision.deliver?.length ?? 0,
        blockedReason: decision.blockedReason,
        hadError: isErrorSubtype,
        errorType: isErrorSubtype ? resultSubtype : null,
      });
      turnTools.length = 0;
      // POISON / API-ERROR GUARD: the SDK can surface an API error as a result
      // message whose text IS the error string ("API Error: 400 …"), sometimes
      // even with subtype "success". The worst case is a poisoned session — a
      // mid-stream _close left an incomplete thinking block as the transcript
      // tail, so every resumed turn 400s with "thinking blocks in the latest
      // assistant message cannot be modified". Forwarding that to the channel
      // spams the user, and with background tasks active each task_notification
      // re-injects another turn that 400s identically (6 identical errors in
      // incident 2026-05-31T20-16-57). Detect the error shape on the FIRST such
      // result and throw instead of forwarding: the catch in main()'s query
      // loop matches the poison signature and restarts in a fresh session
      // exactly once. Throwing here also short-circuits the remaining
      // background-task re-injections before they reach the channel.
      if (decision.blockedReason === 'api-error') {
        log(`API-error result detected (#${resultCount}), suppressing forward and bailing: ${candidate.slice(0, 200)}`);
        ipcPolling = false;
        clearInterval(heartbeatInterval);
        throw new Error(candidate);
      }
      // AUTONOMOUS-RUN OUTPUT GATE (root-cause fix, incident
      // 2026-06-01T14-14-47): channel turn-text is only wanted from an
      // INTERACTIVE turn, where the agent's prose IS the reply. Autonomous
      // runs — scheduled/cron tasks and background dream/reflect runs — speak
      // to the channel ONLY via explicit send_message / send_document. Any
      // prose they emit is internal reasoning and must NEVER be forwarded,
      // regardless of whether IPC was used, errored, or the run stayed silent.
      // The previous guard keyed on "scheduled AND already sent via IPC", so a
      // scheduled task that decided to stay silent (no IPC) fell through and
      // leaked its reasoning as result text. Keying on run KIND instead closes
      // that gap and supersedes the per-case leak fixes (1b4ae5e, 42b5c83,
      // baf1386, 29a0b2a). Setting sentResultWithText=true keeps the quiet-exit
      // fallback from adding a postscript, so a silent autonomous run stays
      // fully silent. Interactive main-chat replies are unaffected.
      let fullTurnText = decision.deliver;
      if (isAutonomousRun) {
        if (decision.sawText) {
          log(`Autonomous run: dropping turn-text forward (${candidate.length} chars) — channel output only via IPC`);
        }
        sentResultWithText = true;
      }
      if (decision.sawText) sentResultWithText = true;
      // Detect actual context/budget overflow from SDK error subtypes.
      // Only these should trigger auto-continuation, not tool-loop halts
      // or clean exits without text.
      if (resultSubtype === 'error_max_turns' || resultSubtype === 'error_max_budget_usd') {
        sawContextOverflow = true;
        log(`Context overflow detected: subtype=${resultSubtype}`);
      }
      writeOutput({
        status: 'success',
        result: fullTurnText || null,
        newSessionId,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheCreationInputTokens: totalCacheCreation || undefined,
          cacheReadInputTokens: totalCacheRead || undefined,
        },
        turns,
        distinctToolsUsed: toolsSeen.size,
        channelTurns: [...channelTurns],
      });
    }
  }

  // SAFETY NET: SDK can end without a text-bearing result message —
  // happens when the run hits `error_max_turns` / `error_max_budget_usd`
  // / `error_during_execution`. In that case `SDKResultError` has no
  // `.result` field, the runner sends `result: null`, and the user sees
  // total silence (no error log either, because `outbound-router`'s
  // empty-text guards live further down the pipe). We synthesize a final
  // reply here using whatever streamed text we accumulated. If none,
  // emit a short honest message so the user knows the run finished
  // without producing an answer instead of just disappearing.
  if (!sentResultWithText) {
    // If streaming already delivered text OR the agent sent output via
    // IPC tools (send_message/send_document), suppress the fallback.
    // The user already saw the agent's work - a "hit limit" postscript
    // adds nothing useful.
    const sentViaIpc = toolsSeen.has('mcp__claudeclaw__send_message') ||
      toolsSeen.has('mcp__claudeclaw__send_document');
    if ((accumulatedAssistantText.trim() || sentViaIpc) && !sawContextOverflow) {
      log(`QUIET EXIT: SDK ended without final text but output was delivered (streaming: ${accumulatedAssistantText.length} chars, ipc: ${sentViaIpc}). No fallback needed.`);
      writeOutput({
        status: 'success',
        result: null,
        newSessionId,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheCreationInputTokens: totalCacheCreation || undefined,
          cacheReadInputTokens: totalCacheRead || undefined,
        },
        turns,
        distinctToolsUsed: toolsSeen.size,
        channelTurns: [...channelTurns],
        contextOverflow: false,
      });
    } else {
      // Determine whether this is likely a real context overflow or just
      // a startup/transient failure. Only overflow-like runs should trigger
      // auto-continuation (3 silent retries). Low-turn failures should
      // report immediately so the user isn't staring at silence for minutes.
      //
      // Heuristic: treat as overflow when:
      //   - SDK natively detected it (sawContextOverflow), OR
      //   - Agent did substantial work (>=15 turns) before dying
      // Low-turn silent failures (<15 turns) are startup crashes, auth
      // errors, prompt issues, etc. - retrying won't help.
      const likelyOverflow = sawContextOverflow || turns >= 15;
      const fallbackText = likelyOverflow
        ? `Контекст переполнен после ${turns} ходов. Продолжаю в новой сессии...`
        : `Сессия завершилась без ответа (${turns} ходов, ${toolsSeen.size} инструментов).`;
      log(`FALLBACK: SDK ended without text result. sawContextOverflow=${sawContextOverflow}, turns=${turns}, likelyOverflow=${likelyOverflow}`);
      writeOutput({
        status: likelyOverflow ? 'success' : 'error',
        result: fallbackText,
        newSessionId,
        error: likelyOverflow ? undefined : `Silent failure after ${turns} turns`,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheCreationInputTokens: totalCacheCreation || undefined,
          cacheReadInputTokens: totalCacheRead || undefined,
        },
        turns,
        distinctToolsUsed: toolsSeen.size,
        channelTurns: [...channelTurns],
        contextOverflow: likelyOverflow || undefined,
      });
    }
  }

  ipcPolling = false;
  clearInterval(heartbeatInterval);
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, tokens: ${totalInputTokens}in/${totalOutputTokens}out, tools: ${toolsSeen.size}`);
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreation || undefined,
      cacheReadInputTokens: totalCacheRead || undefined,
    },
    turns,
    distinctToolsUsed: toolsSeen.size,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const browserMcpPath = path.join(__dirname, 'mcp-browser.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult;
      try {
        queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, browserMcpPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Stale session: Claude Code rotated/removed the resume file.
        // Poisoned session: a close-sentinel interruption left an incomplete
        // thinking block as the transcript tail, so every resume 400s with
        // "thinking blocks in the latest assistant message cannot be modified".
        // Either way, retry once without resume, starting a fresh session.
        if (sessionId && /No conversation found with session ID|No message found with message\.uuid|thinking.{0,60}blocks in the latest assistant message cannot be modified/i.test(msg)) {
          log(`Session ${sessionId} is stale/poisoned (${msg}). Starting fresh session.`);
          sessionId = undefined;
          resumeAt = undefined;
          queryResult = await runQuery(prompt, undefined, mcpServerPath, containerInput, sdkEnv, undefined, browserMcpPath);
        } else {
          throw err;
        }
      }
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it (include usage from this query)
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        usage: queryResult.usage,
        turns: queryResult.turns,
        distinctToolsUsed: queryResult.distinctToolsUsed,
      });

      // SINGLE-SHOT MODE for every run.
      //
      // Previously the runner stayed alive in idle-wait after a reply,
      // polling for follow-up messages — a warm-pool optimization. In
      // practice it caused ~10 multi-minute silences in one day:
      //   - runner sometimes hung in idle-wait without polling _close
      //   - orchestrator's drain race-conditioned with cursor advance
      //   - watchdog took 8 min to detect zombies (0% CPU + no TCP)
      //   - new user messages sat behind the zombie until forced kill
      //
      // Trade: each new message incurs ~5s sandbox cold start, but
      // delivery is reliable. If we ever bring back warm-pool, it must
      // be a SEPARATE pool process not bound to a specific message.
      log('Run complete, exiting (single-shot mode)');
      break;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
