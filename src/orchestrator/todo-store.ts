/**
 * TodoStore — persistent per-group task list that survives context compression.
 *
 * Pattern from Hermes Agent (NousResearch). The single biggest cause of
 * "agent forgot what it was doing" is a SDK context compaction wiping the
 * recent plan. This store keeps the plan in a JSON file inside the group
 * folder so we can re-inject it AFTER compaction completes — the model
 * literally cannot lose its plan.
 *
 * File-based (not SQLite) because the file lives inside the group folder
 * which IS mounted into the sandbox — both the orchestrator (host-side)
 * and the agent runner's MCP server (sandbox-side) can read/write the
 * same store.
 *
 * Schema rules (verbatim from Hermes wording where it works):
 * - Status: pending | in_progress | completed | cancelled
 * - Only ONE item in_progress at a time (single-instance constraint)
 * - Items ordered by insertion = priority
 * - Completed items NOT injected post-compaction (else model re-does them)
 * - Cancelled items kept for audit but excluded from injection
 */

import fs from 'fs';
import path from 'path';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  id: number;
  content: string;
  status: TodoStatus;
  created_at: string;
  updated_at: string;
}

export interface TodoUpdate {
  id?: number;
  content?: string;
  status?: TodoStatus;
}

interface TodoFile {
  next_id: number;
  todos: Todo[];
}

function todoFilePath(groupDir: string): string {
  return path.join(groupDir, '.todos.json');
}

function readFile(groupDir: string): TodoFile {
  const fp = todoFilePath(groupDir);
  if (!fs.existsSync(fp)) return { next_id: 1, todos: [] };
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw) as TodoFile;
    if (!parsed.todos || !Array.isArray(parsed.todos)) {
      return { next_id: 1, todos: [] };
    }
    return parsed;
  } catch {
    return { next_id: 1, todos: [] };
  }
}

function writeFile(groupDir: string, data: TodoFile): void {
  const fp = todoFilePath(groupDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

/**
 * Replace the entire todo list, or merge updates by id.
 */
export function setTodos(
  groupDir: string,
  todos: TodoUpdate[],
  opts: { merge?: boolean } = {},
): Todo[] {
  const merge = opts.merge ?? false;
  const file = readFile(groupDir);
  const now = new Date().toISOString();

  if (!merge) {
    file.todos = [];
  }

  // Enforce single-in-progress invariant across the final state
  let existingInProgress = file.todos.find((t) => t.status === 'in_progress');

  for (const update of todos) {
    let st: TodoStatus = (update.status as TodoStatus) || 'pending';

    if (update.id !== undefined && merge) {
      const idx = file.todos.findIndex((t) => t.id === update.id);
      if (idx >= 0) {
        if (st === 'in_progress' && existingInProgress && existingInProgress.id !== update.id) {
          // demote previous in_progress to pending
          existingInProgress.status = 'pending';
          existingInProgress.updated_at = now;
        }
        file.todos[idx] = {
          ...file.todos[idx],
          content: update.content ?? file.todos[idx].content,
          status: update.status ?? file.todos[idx].status,
          updated_at: now,
        };
        if (st === 'in_progress') existingInProgress = file.todos[idx];
        continue;
      }
    }

    if (!update.content) continue;
    if (st === 'in_progress' && existingInProgress) {
      existingInProgress.status = 'pending';
      existingInProgress.updated_at = now;
    }
    const newTodo: Todo = {
      id: file.next_id++,
      content: update.content,
      status: st,
      created_at: now,
      updated_at: now,
    };
    file.todos.push(newTodo);
    if (st === 'in_progress') existingInProgress = newTodo;
  }

  writeFile(groupDir, file);
  return file.todos;
}

export function getTodos(groupDir: string): Todo[] {
  return readFile(groupDir).todos;
}

export function clearTodos(groupDir: string): void {
  writeFile(groupDir, { next_id: 1, todos: [] });
}

/**
 * Format active todos for re-injection after context compaction.
 * Returns null if no active items so caller can skip the injection cleanly.
 */
export function formatForInjection(groupDir: string): string | null {
  const todos = getTodos(groupDir);
  const active = todos.filter(
    (t) => t.status === 'pending' || t.status === 'in_progress',
  );
  if (active.length === 0) return null;
  const markers: Record<TodoStatus, string> = {
    pending: '[ ]',
    in_progress: '[→]',
    completed: '[x]',
    cancelled: '[-]',
  };
  const lines = ['[Your active task list was preserved across context compression]'];
  active.forEach((t, idx) => {
    lines.push(`- ${markers[t.status]} ${idx + 1}. ${t.content} (${t.status})`);
  });
  lines.push(
    '[Continue from where you left off. Mark items completed as you finish them via the todo tool.]',
  );
  return lines.join('\n');
}
