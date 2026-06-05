export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/claudeclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface AgentConfig {
  model?: string; // 'sonnet' | 'opus' | 'haiku' | full model ID
  effort?: 'low' | 'medium' | 'high'; // Model reasoning effort (v2.1.78+)
  systemPrompt?: string; // Appended to agent's system context
  allowedTools?: string[]; // Tool allowlist override (empty = use defaults)
  disallowedTools?: string[]; // Tool blacklist (v2.1.78+ — applied on top of allowlist)
  maxTurns?: number; // Max conversation turns
  allowedDomains?: string[]; // Extra network domains the sandbox agent can access (merged with base Anthropic + localhost)
  allowedWritePaths?: string[]; // Extra host filesystem paths the sandbox agent can write to (merged into filesystem.allowWrite). Use for tasks that legitimately touch paths outside the workspace, e.g. backup dirs.
  disableStreaming?: boolean; // If true, only send the final message — skip in-flight streaming draft + edits.
  sequentialMessages?: boolean; // If true, never inject new messages into a running sandbox; queue them for the next run instead. Prevents voice/text getting mixed/dropped when sent in quick succession.
  debounceMs?: number; // Quiet-period debounce window in ms. Default: 2000 (text) / 4000 (when voice/photo present). Override to tune brain-dump batching: bot waits N ms of quiet before batching N rapid messages into ONE agent run.
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  runtime?: 'container' | 'sandbox'; // Per-group runtime override (falls back to DEFAULT_RUNTIME)
  agentConfig?: AgentConfig;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  model?: string | null; // Per-task model override (haiku/sonnet/opus/full ID)
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface ChannelCapabilities {
  /**
   * Channel can edit a previously-sent message in place. Used for
   * streaming agent responses (Telegram supports it; WhatsApp doesn't).
   */
  supportsEdit?: boolean;
}

export interface SentMessageInfo {
  /** Channel-specific id of the just-sent message, used for editMessage. */
  messageId?: string | number;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  /**
   * Send a message. May return SentMessageInfo with messageId so callers
   * can edit it later (streaming). Returning void/null is also allowed
   * for channels that don't support editing.
   */
  sendMessage(jid: string, text: string): Promise<void | SentMessageInfo>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  /** Optional: typing indicator. Channels that support it implement it. */
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  /** Optional: sync group/chat names from the platform. */
  syncGroups?(force: boolean): Promise<void>;
  /** Optional: edit a previously-sent message. Required when supportsEdit=true. */
  editMessage?(
    jid: string,
    messageId: string | number,
    text: string,
  ): Promise<void>;
  /** Optional: send a file (document) — markdown, PDF, image, etc. */
  sendDocument?(jid: string, filePath: string, caption?: string): Promise<void>;
  /** Optional: capability flags. Default = no special capabilities. */
  capabilities?: ChannelCapabilities;
}

// --- Message routing ---

export interface IngestionEnvelope {
  groupFolder: string;
  chatJid: string;
  sender: string;
  senderName: string;
  triggerType: 'channel' | 'webhook' | 'cron' | 'ipc' | 'extension';
  prompt: string;
  bypassTrigger?: boolean; // webhooks, cron, main group skip trigger check
  meta?: Record<string, unknown>;
}

export interface OutboundEnvelope {
  chatJid: string;
  text: string;
  triggerType: 'agent-response' | 'ipc' | 'task-result' | 'extension';
  groupFolder?: string;
  meta?: Record<string, unknown>;
}

export type HookResult<T> =
  | { action: 'continue' }
  | { action: 'drop'; reason?: string }
  | { action: 'modify'; envelope: T };

export type IngestionPreHook = (
  envelope: IngestionEnvelope,
) => Promise<HookResult<IngestionEnvelope>>;

export type OutboundPreHook = (
  envelope: OutboundEnvelope,
) => Promise<HookResult<OutboundEnvelope>>;

export interface MessageIngestion {
  addPreHook(hook: IngestionPreHook): void;
  addPostHook(hook: (envelope: IngestionEnvelope) => void): void;
  ingest(envelope: IngestionEnvelope): Promise<boolean>;
}

export interface MessageRouter {
  addPreHook(hook: OutboundPreHook): void;
  addPostHook(hook: (envelope: OutboundEnvelope) => void): void;
  route(envelope: OutboundEnvelope): Promise<void>;
  /** Convenience: route with minimal envelope */
  send(jid: string, text: string): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
