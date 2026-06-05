/**
 * Rate-limit guard.
 *
 * The Claude SDK returns a successful-looking result whose body is
 * "You've hit your limit · resets HH:MMam (Timezone)" when the user's
 * 5-hour Pro window is exhausted. Without intervention we route this
 * text to chat as if it were a real reply — once per agent run — which
 * spams the chat when many cron tasks fire at once.
 *
 * This module owns shared in-memory state so all four routing points
 * (user reply, user-task result, system-task result, watchdog) cooperate:
 *   - first detection activates the guard and notifies the user once;
 *   - subsequent detections within the same window stay silent;
 *   - new agent runs are short-circuited until reset.
 */

import { TIMEZONE } from './config.js';
import { getCurrentKeyLabel, hasLiveKeys, isPoolConfigured, markKeyDead } from './credential-pool.js';
import { logger } from './logger.js';
import { MessageRouter } from './types.js';

interface RateLimitState {
  until: Date;
  notifiedAt: Date;
}

let state: RateLimitState | null = null;

// Two formats observed from Claude Code rate-limit messages:
//   "resets 7:50pm (Europe/Madrid)"  — H:MM with minutes
//   "resets 12am (Europe/Madrid)"    — H only, no minutes (e.g. midnight, noon)
const RESET_PATTERN =
  /You've hit your limit.*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
const HIT_MARKER = "hit your limit";

export function detectRateLimit(text: string | null | undefined): {
  hit: boolean;
  resetAt: Date | null;
} {
  if (!text || !text.includes(HIT_MARKER)) {
    return { hit: false, resetAt: null };
  }
  const m = text.match(RESET_PATTERN);
  if (!m) {
    return { hit: true, resetAt: null };
  }
  const resetAt = parseResetTime(m[1], m[2], m[3], m[4]);
  return { hit: true, resetAt };
}

/**
 * Build the next future Date for a wall-clock time in the given IANA timezone.
 * Uses Intl.DateTimeFormat to read what the timezone wall-clock currently shows
 * and walks day-by-day to the first instant where wall-clock time equals (h:m).
 */
function parseResetTime(
  hourStr: string,
  minuteStr: string | undefined,
  ampm: string,
  tzName: string,
): Date | null {
  let hour = parseInt(hourStr, 10);
  // minuteStr is optional in the regex (e.g. "12am" with no minutes).
  // Treat absent as 00.
  const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  if (isNaN(hour) || isNaN(minute)) return null;
  const isPm = ampm.toLowerCase() === 'pm';
  if (hour === 12) hour = isPm ? 12 : 0;
  else if (isPm) hour += 12;

  const tz = isValidTimezone(tzName) ? tzName : TIMEZONE;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // Probe at 1-minute granularity from now+1min up to now+24h.
  const start = Date.now() + 60_000;
  for (let offset = 0; offset <= 24 * 60; offset++) {
    const probe = new Date(start + offset * 60_000);
    const parts = fmt.formatToParts(probe);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (h === hour && m === minute) {
      return probe;
    }
  }
  return null;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isRateLimited(): boolean {
  if (!state) return false;
  if (Date.now() >= state.until.getTime()) {
    state = null;
    return false;
  }
  return true;
}

export function getRateLimitedUntil(): Date | null {
  if (!isRateLimited()) return null;
  return state?.until ?? null;
}

/**
 * Activate the guard. Returns true the first time a window is opened.
 * Returns false when called again within the same window — caller should
 * suppress notification but still treat the run as failed.
 *
 * When the credential pool is configured: mark the just-used key dead and
 * suppress the global guard if other keys are still alive (the next agent
 * run will rotate to a live key automatically).
 */
export function activateRateLimit(resetAt: Date | null): boolean {
  const until = resetAt ?? new Date(Date.now() + 60 * 60 * 1000);

  // Pool integration: if a pool is configured, kill the sticky key and try
  // to rotate. Only activate the global guard when no live keys remain.
  if (isPoolConfigured()) {
    const label = getCurrentKeyLabel();
    if (label) {
      markKeyDead(label, until);
    }
    if (hasLiveKeys()) {
      logger.info(
        { deadKey: label, until: until.toISOString() },
        'Credential pool: rotating to live key, no global guard',
      );
      return false; // guard NOT activated; live keys will pick up next run
    }
    logger.warn(
      { deadKey: label, until: until.toISOString() },
      'Credential pool: all keys dead, falling back to global rate-limit guard',
    );
  }

  if (state && Math.abs(state.until.getTime() - until.getTime()) < 60_000) {
    return false;
  }
  state = { until, notifiedAt: new Date() };
  logger.warn(
    { until: state.until.toISOString() },
    'Rate-limit guard activated',
  );
  return true;
}

export function resetRateLimit(): void {
  state = null;
}

/**
 * Intercept agent output. If it contains a rate-limit notice:
 *  - activate the guard
 *  - send ONE notification to chat (only on first activation)
 *  - return true so the caller skips routing the original text
 */
export async function interceptRateLimit(
  text: string | null | undefined,
  router: MessageRouter,
  fallbackChatJid: string,
  groupFolder: string,
): Promise<boolean> {
  const { hit, resetAt } = detectRateLimit(text);
  if (!hit) return false;
  const isFirst = activateRateLimit(resetAt);
  if (isFirst) {
    const resetStr = resetAt
      ? resetAt.toLocaleString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: TIMEZONE,
          hour12: false,
        })
      : 'unknown time';
    try {
      await router.route({
        chatJid: fallbackChatJid,
        text: `Claude rate limit hit. All activity paused until ${resetStr} (${TIMEZONE}). Will resume automatically.`,
        triggerType: 'agent-response',
        groupFolder,
      });
    } catch (err) {
      logger.warn(
        { err, fallbackChatJid },
        'Failed to send rate-limit notification',
      );
    }
  }
  return true;
}
