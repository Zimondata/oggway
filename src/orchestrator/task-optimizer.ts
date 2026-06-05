/**
 * Task Auto-Optimizer
 *
 * Analyzes task_run_logs after each run and detects wasteful patterns:
 * - High silent ratio (task runs but produces nothing actionable)
 * - Model overkill (expensive model for trivial output)
 * - Stale output (identical results every run)
 *
 * Actions: auto-downgrade model, log recommendations, notify admin.
 * Frequency changes require manual approval (logged as recommendations).
 */

import { getDb } from './db.js';
import { logger } from './logger.js';

const SILENT_RE =
  /^(\[SILENT\]|HEARTBEAT_OK|heartbeat:?\s*ok\b|no skill\b|<internal>HEARTBEAT_OK<\/internal>)/i;

interface RunLog {
  result: string | null;
  duration_ms: number;
  status: string;
  run_at: string;
}

interface OptimizationResult {
  taskId: string;
  actions: string[];
  recommendations: string[];
}

// Minimum runs before we evaluate (don't judge a task on 1-2 runs)
const MIN_RUNS_FOR_EVAL = 5;

// If this % of recent runs are silent, flag it
const SILENT_RATIO_THRESHOLD = 0.8;

// If avg output is short and model is not haiku, suggest downgrade
const SHORT_RESULT_CHARS = 200;

function isSilent(result: string | null): boolean {
  if (!result || result.trim() === '') return true;
  return SILENT_RE.test(result.trim());
}

/**
 * Evaluate a task's recent run history and return optimization actions.
 * Called after every task run completes.
 */
export function evaluateTask(taskId: string): OptimizationResult {
  const out: OptimizationResult = { taskId, actions: [], recommendations: [] };

  const db = getDb();

  // Get last 10 runs for this task
  const runs = db
    .prepare(
      `SELECT result, duration_ms, status, run_at
       FROM task_run_logs
       WHERE task_id = ?
       ORDER BY run_at DESC
       LIMIT 10`,
    )
    .all(taskId) as RunLog[];

  if (runs.length < MIN_RUNS_FOR_EVAL) return out;

  // Get task metadata
  const task = db
    .prepare(
      `SELECT id, schedule_type, schedule_value, model, prompt FROM scheduled_tasks WHERE id = ?`,
    )
    .get(taskId) as
    | {
        id: string;
        schedule_type: string;
        schedule_value: string;
        model: string | null;
        prompt: string;
      }
    | undefined;

  if (!task) return out;

  // --- Rule 1: Silent ratio ---
  const silentCount = runs.filter((r) => isSilent(r.result)).length;
  const silentRatio = silentCount / runs.length;

  if (silentRatio >= SILENT_RATIO_THRESHOLD) {
    out.recommendations.push(
      `[silent-ratio] ${Math.round(silentRatio * 100)}% of last ${runs.length} runs were silent. ` +
        `Consider reducing frequency or merging with another task.`,
    );
  }

  // --- Rule 2: Model overkill ---
  const currentModel = (task.model || 'sonnet').toLowerCase();
  const isExpensiveModel =
    currentModel.includes('opus') || currentModel.includes('sonnet');

  if (isExpensiveModel && silentRatio > 0.5) {
    // Most runs are silent - definitely doesn't need an expensive model
    const newModel = 'haiku';
    db.prepare(`UPDATE scheduled_tasks SET model = ? WHERE id = ?`).run(
      newModel,
      taskId,
    );
    out.actions.push(
      `[model-downgrade] Auto-downgraded ${taskId} from ${currentModel} to ${newModel} ` +
        `(${Math.round(silentRatio * 100)}% silent runs)`,
    );
  } else if (isExpensiveModel) {
    // Check if outputs are consistently short (trivial work)
    const nonSilentRuns = runs.filter((r) => !isSilent(r.result));
    if (nonSilentRuns.length > 0) {
      const avgLen =
        nonSilentRuns.reduce((sum, r) => sum + (r.result?.length || 0), 0) /
        nonSilentRuns.length;
      if (avgLen < SHORT_RESULT_CHARS) {
        out.recommendations.push(
          `[model-overkill] Avg output length ${Math.round(avgLen)} chars on ${currentModel}. ` +
            `Consider haiku.`,
        );
      }
    }
  }

  // --- Rule 3: Stale output (identical results) ---
  const nonSilentResults = runs
    .filter((r) => !isSilent(r.result) && r.result)
    .map((r) => r.result!.trim().slice(0, 500));

  if (nonSilentResults.length >= 3) {
    const first = nonSilentResults[0];
    const allSame = nonSilentResults.slice(0, 3).every((r) => r === first);
    if (allSame) {
      out.recommendations.push(
        `[stale-output] Last 3 actionable results are identical. Task may be stuck or redundant.`,
      );
    }
  }

  // --- Rule 4: High cost, low value ---
  const avgDuration =
    runs.reduce((sum, r) => sum + r.duration_ms, 0) / runs.length;
  if (silentRatio >= 0.6 && avgDuration > 60000) {
    out.recommendations.push(
      `[cost-waste] Avg ${Math.round(avgDuration / 1000)}s per run, ${Math.round(silentRatio * 100)}% silent. ` +
        `Burning tokens for nothing.`,
    );
  }

  // Log everything
  if (out.actions.length > 0 || out.recommendations.length > 0) {
    logger.info(
      {
        taskId,
        actions: out.actions,
        recommendations: out.recommendations,
      },
      'Task optimizer evaluation',
    );
  }

  return out;
}

/**
 * Get a summary of all task efficiency for admin reporting.
 */
export function getEfficiencyReport(): string {
  const db = getDb();
  const tasks = db
    .prepare(
      `SELECT id, schedule_type, schedule_value, model, status
       FROM scheduled_tasks
       WHERE status = 'active' AND schedule_type = 'cron'`,
    )
    .all() as Array<{
    id: string;
    schedule_type: string;
    schedule_value: string;
    model: string | null;
    status: string;
  }>;

  const lines: string[] = ['Task Efficiency Report:', ''];

  for (const task of tasks) {
    const runs = db
      .prepare(
        `SELECT result, duration_ms, status, run_at
         FROM task_run_logs
         WHERE task_id = ?
         ORDER BY run_at DESC
         LIMIT 20`,
      )
      .all(task.id) as RunLog[];

    if (runs.length === 0) continue;

    const silentCount = runs.filter((r) => isSilent(r.result)).length;
    const silentPct = Math.round((silentCount / runs.length) * 100);
    const avgDuration = Math.round(
      runs.reduce((s, r) => s + r.duration_ms, 0) / runs.length / 1000,
    );
    const model = task.model || 'default';

    lines.push(
      `${task.id}: ${silentPct}% silent, avg ${avgDuration}s, model=${model}, cron=${task.schedule_value}`,
    );
  }

  return lines.join('\n');
}
