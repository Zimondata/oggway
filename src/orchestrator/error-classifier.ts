/**
 * Error classifier for agent SDK errors.
 *
 * Classifies errors into retryable (transient) vs non-retryable (permanent),
 * and determines whether the session state is corrupted (requiring session drop).
 *
 * Based on anthroclaw pattern: walk error cause chain, classify by HTTP status,
 * use jittered exponential backoff for retryable errors.
 */

export type ErrorCategory =
  | 'auth' // 401 - bad credentials
  | 'billing' // 402 - payment required
  | 'not-found' // 404 - session/resource gone
  | 'oversize' // 413 - payload too large
  | 'rate-limit' // 429 - too many requests
  | 'server-error' // 500/502/503 - transient server issues
  | 'overloaded' // 529 - API overloaded
  | 'network' // ECONNREFUSED, ETIMEDOUT, etc.
  | 'context-overflow' // context window exceeded
  | 'timeout' // process killed / watchdog
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  /** Whether the SDK session JSONL is likely corrupted (unanswered user turns) */
  sessionCorrupted: boolean;
  /** Suggested initial delay before retry (ms) */
  retryDelayMs: number;
  message: string;
}

const HTTP_STATUS_RE = /(?:API Error:|status[: ]+|HTTP[/ ]+\d\.\d\s+)(\d{3})/i;
const OVERLOADED_RE = /overloaded|529/i;
const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;
const AUTH_RE = /401|authentication_error|invalid.*credentials|unauthorized/i;
const BILLING_RE = /402|payment.*required|billing|insufficient.*credits/i;
const NOT_FOUND_RE = /404|not.?found|no.*conversation/i;
const OVERSIZE_RE = /413|too.?large|payload.*size|request.*entity/i;
const CONTEXT_OVERFLOW_RE =
  /context.*(?:window|length)|max.*tokens.*exceeded|prompt.*too.*long/i;
const NETWORK_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|fetch failed|network/i;
const SERVER_RE =
  /50[023]|bad gateway|service unavailable|internal server error/i;

function extractHttpStatus(msg: string): number | null {
  const m = msg.match(HTTP_STATUS_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** Walk the cause chain of an error and collect all messages */
function collectMessages(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 10 && current; i++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else if (typeof current === 'string') {
      parts.push(current);
      break;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' | ');
}

export function classifyError(err: unknown): ClassifiedError {
  const msg = collectMessages(err);
  const status = extractHttpStatus(msg);

  // Auth errors - not retryable (handled separately by auth-retry in runAgent)
  if (status === 401 || AUTH_RE.test(msg)) {
    return {
      category: 'auth',
      retryable: false,
      sessionCorrupted: false,
      retryDelayMs: 0,
      message: msg,
    };
  }

  // Billing - not retryable
  if (status === 402 || BILLING_RE.test(msg)) {
    return {
      category: 'billing',
      retryable: false,
      sessionCorrupted: false,
      retryDelayMs: 0,
      message: msg,
    };
  }

  // Context overflow - not retryable, session is corrupted (partial writes)
  if (CONTEXT_OVERFLOW_RE.test(msg)) {
    return {
      category: 'context-overflow',
      retryable: false,
      sessionCorrupted: true,
      retryDelayMs: 0,
      message: msg,
    };
  }

  // Oversize payload - not retryable, session corrupted
  if (status === 413 || OVERSIZE_RE.test(msg)) {
    return {
      category: 'oversize',
      retryable: false,
      sessionCorrupted: true,
      retryDelayMs: 0,
      message: msg,
    };
  }

  // Not found (session gone) - not retryable, session corrupted
  if (status === 404 || NOT_FOUND_RE.test(msg)) {
    return {
      category: 'not-found',
      retryable: false,
      sessionCorrupted: true,
      retryDelayMs: 0,
      message: msg,
    };
  }

  // Rate limit - retryable with longer delay, session is FINE
  if (status === 429 || RATE_LIMIT_RE.test(msg)) {
    return {
      category: 'rate-limit',
      retryable: true,
      sessionCorrupted: false,
      retryDelayMs: 15_000,
      message: msg,
    };
  }

  // API overloaded (529) - retryable, session fine
  if (status === 529 || OVERLOADED_RE.test(msg)) {
    return {
      category: 'overloaded',
      retryable: true,
      sessionCorrupted: false,
      retryDelayMs: 10_000,
      message: msg,
    };
  }

  // Server errors (500/502/503) - retryable, session fine
  if ((status && status >= 500 && status < 600) || SERVER_RE.test(msg)) {
    return {
      category: 'server-error',
      retryable: true,
      sessionCorrupted: false,
      retryDelayMs: 5_000,
      message: msg,
    };
  }

  // Network errors - retryable, session fine (never reached server)
  if (NETWORK_RE.test(msg)) {
    return {
      category: 'network',
      retryable: true,
      sessionCorrupted: false,
      retryDelayMs: 5_000,
      message: msg,
    };
  }

  // Unknown - conservative: not retryable, session may be corrupted
  return {
    category: 'unknown',
    retryable: false,
    sessionCorrupted: true,
    retryDelayMs: 0,
    message: msg,
  };
}

/**
 * Retry wrapper with jittered exponential backoff.
 * Only retries when the classifier says the error is retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (classified: ClassifiedError, attempt: number) => void;
    /** Check result and return an error string if it should be retried */
    shouldRetryResult?: (result: T) => string | null;
  } = {},
): Promise<
  { result: T; attempts: number } | { error: ClassifiedError; attempts: number }
> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 5_000;
  const maxDelayMs = opts.maxDelayMs ?? 120_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();

      // Check if the result itself indicates a retryable error
      if (opts.shouldRetryResult) {
        const errMsg = opts.shouldRetryResult(result);
        if (errMsg && attempt < maxAttempts) {
          const classified = classifyError(errMsg);
          if (classified.retryable) {
            const delay = jitteredDelay(
              classified.retryDelayMs || baseDelayMs,
              attempt,
              maxDelayMs,
            );
            opts.onRetry?.(classified, attempt);
            await sleep(delay);
            continue;
          }
          // Non-retryable result error
          return { error: classified, attempts: attempt };
        }
      }

      return { result, attempts: attempt };
    } catch (err) {
      const classified = classifyError(err);

      if (!classified.retryable || attempt >= maxAttempts) {
        return { error: classified, attempts: attempt };
      }

      const delay = jitteredDelay(
        classified.retryDelayMs || baseDelayMs,
        attempt,
        maxDelayMs,
      );
      opts.onRetry?.(classified, attempt);
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  return {
    error: classifyError('max retries exhausted'),
    attempts: maxAttempts,
  };
}

function jitteredDelay(baseMs: number, attempt: number, maxMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  // 50% jitter: delay is between 50% and 100% of the capped value
  return capped * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
