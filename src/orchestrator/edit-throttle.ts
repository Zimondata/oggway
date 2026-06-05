/**
 * Per-key debounce for streaming message edits.
 *
 * Telegram's editMessageText is rate-limited (~1/sec per message in a chat).
 * The agent emits partial outputs much faster than that. We debounce edits
 * per (channel, message) tuple so only the latest text is applied, and we
 * never fire two edits closer than DEFAULT_DEBOUNCE_MS apart.
 *
 * Final flush: when the agent finishes, the host calls flush(key) to apply
 * the last pending text immediately (with no debounce delay).
 */

import { logger } from './logger.js';

interface PendingEdit {
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
  applyFn: (text: string) => Promise<void>;
  inFlight: boolean;
}

const DEFAULT_DEBOUNCE_MS = 800;

const pending = new Map<string, PendingEdit>();

/**
 * Schedule an edit. Subsequent calls for the same key replace the pending
 * text; the apply function runs once per debounce window.
 */
export function scheduleEdit(
  key: string,
  text: string,
  applyFn: (text: string) => Promise<void>,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): void {
  const existing = pending.get(key);
  if (existing) {
    existing.text = text;
    existing.applyFn = applyFn;
    return;
  }

  const entry: PendingEdit = {
    text,
    timer: null,
    applyFn,
    inFlight: false,
  };
  pending.set(key, entry);

  const fire = async () => {
    const current = pending.get(key);
    if (!current) return;
    if (current.inFlight) {
      // Re-schedule for next window if a previous fire is still applying.
      current.timer = setTimeout(fire, debounceMs);
      return;
    }
    current.inFlight = true;
    const textSnapshot = current.text;
    const fn = current.applyFn;
    current.timer = null;
    try {
      await fn(textSnapshot);
    } catch (err) {
      logger.warn(
        { key, err: err instanceof Error ? err.message : String(err) },
        'edit-throttle: apply failed',
      );
    } finally {
      const after = pending.get(key);
      if (after) {
        after.inFlight = false;
        // If text changed during inFlight, schedule another fire.
        if (after.text !== textSnapshot) {
          after.timer = setTimeout(fire, debounceMs);
        } else {
          pending.delete(key);
        }
      }
    }
  };

  entry.timer = setTimeout(fire, debounceMs);
}

/**
 * Apply the latest pending text immediately (cancels any pending timer).
 * Use after the streaming run has produced its final result to make sure
 * the user sees the canonical text without an 800ms tail.
 */
export async function flushEdit(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.inFlight) {
    // Wait for the in-flight call to settle, then flush again with the
    // most recent text.
    const wait = new Promise<void>((resolve) => {
      const check = () => {
        const current = pending.get(key);
        if (!current || !current.inFlight) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
    await wait;
  }
  const final = pending.get(key);
  if (!final) return;
  const fn = final.applyFn;
  const text = final.text;
  pending.delete(key);
  try {
    await fn(text);
  } catch (err) {
    logger.warn(
      { key, err: err instanceof Error ? err.message : String(err) },
      'edit-throttle: flush failed',
    );
  }
}

/**
 * Drop any pending edit without applying. Use on agent error to avoid
 * leaving stale streaming text in the chat.
 */
export function cancelEdit(key: string): void {
  const entry = pending.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(key);
}
