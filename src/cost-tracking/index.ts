import { registerExtension } from '../orchestrator/extensions.js';
import { getDb } from '../orchestrator/db.js';
import { logger } from '../orchestrator/logger.js';

registerExtension({
  name: 'cost-tracking',
  dbSchema: [
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'message',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      turns INTEGER DEFAULT 0,
      model TEXT,
      status TEXT NOT NULL,
      run_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_group_folder ON agent_runs(group_folder)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_run_at ON agent_runs(run_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_group_run_at ON agent_runs(group_folder, run_at)`,
    // Structured per-turn observability. One row per agent turn (not per run),
    // so a channel leak is one SQL query away:
    //   SELECT * FROM agent_turns WHERE run_kind='scheduled' AND text_sent_chars>0
    `CREATE TABLE IF NOT EXISTS agent_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      run_at TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      run_kind TEXT NOT NULL,
      tools_called TEXT,
      text_generated_chars INTEGER DEFAULT 0,
      text_sent_chars INTEGER DEFAULT 0,
      blocked_reason TEXT,
      had_error INTEGER DEFAULT 0,
      error_type TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_turns_group_run_at ON agent_turns(group_folder, run_at)`,
    `CREATE INDEX IF NOT EXISTS idx_agent_turns_blocked ON agent_turns(blocked_reason)`,
  ],
});

// Anthropic pricing (USD per million tokens) — update as pricing changes
const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number }
> = {
  sonnet: { input: 3, output: 15, cacheRead: 0.3 },
  opus: { input: 15, output: 75, cacheRead: 0.3 },
  haiku: { input: 0.25, output: 1.25, cacheRead: 0.03 },
};

function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const key = (model || 'sonnet').toLowerCase();
  const tier =
    Object.entries(PRICING).find(([k]) => key.includes(k))?.[1] ||
    PRICING.sonnet;
  return (
    (inputTokens / 1_000_000) * tier.input +
    (outputTokens / 1_000_000) * tier.output +
    (cacheReadTokens / 1_000_000) * tier.cacheRead
  );
}

export interface AgentRunRecord {
  groupFolder: string;
  chatJid: string;
  triggerType:
    | 'message'
    | 'scheduled'
    | 'webhook'
    | 'dreaming'
    | 'reflection'
    | 'wake'
    | 'subagent';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  turns: number;
  model?: string;
  status: 'success' | 'error';
}

export function logAgentRun(record: AgentRunRecord): void {
  try {
    const cost = estimateCost(
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
    );
    getDb()
      .prepare(
        `INSERT INTO agent_runs (group_folder, chat_jid, trigger_type, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, duration_ms, turns, model, status, run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.groupFolder,
        record.chatJid,
        record.triggerType,
        record.inputTokens,
        record.outputTokens,
        record.cacheCreationTokens,
        record.cacheReadTokens,
        cost,
        record.durationMs,
        record.turns,
        record.model || null,
        record.status,
        new Date().toISOString(),
      );
    logger.debug(
      {
        group: record.groupFolder,
        cost: cost.toFixed(4),
        tokens: record.inputTokens + record.outputTokens,
      },
      'Agent run logged',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log agent run cost');
  }
}

// Orchestrator-side mirror of the runner's ChannelTurnLog (agent/runner/src/
// channel-output.ts). The runner compiles separately and cannot share the
// type, so the shape is duplicated; it travels as JSON on the run output.
export interface ChannelTurnLog {
  turnIndex: number;
  runKind: 'interactive' | 'scheduled' | 'dream' | 'reflect' | 'error';
  toolsCalled: string[];
  textGeneratedChars: number;
  textSentChars: number;
  blockedReason: string | null;
  hadError: boolean;
  errorType: string | null;
}

// Persist one agent_turns row per turn. Mirrors logAgentRun's try/catch so a
// logging failure never breaks the run. Single transaction for the batch.
export function logAgentTurns(
  groupFolder: string,
  chatJid: string,
  turns: ChannelTurnLog[],
): void {
  if (!turns || turns.length === 0) return;
  try {
    const db = getDb();
    const runAt = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO agent_turns (group_folder, chat_jid, run_at, turn_index, run_kind, tools_called, text_generated_chars, text_sent_chars, blocked_reason, had_error, error_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = db.transaction((rows: ChannelTurnLog[]) => {
      for (const t of rows) {
        stmt.run(
          groupFolder,
          chatJid,
          runAt,
          t.turnIndex,
          t.runKind,
          JSON.stringify(t.toolsCalled ?? []),
          t.textGeneratedChars ?? 0,
          t.textSentChars ?? 0,
          t.blockedReason ?? null,
          t.hadError ? 1 : 0,
          t.errorType ?? null,
        );
      }
    });
    insertAll(turns);
  } catch (err) {
    logger.warn({ err }, 'Failed to log agent turns');
  }
}
