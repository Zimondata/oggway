/**
 * Rate-limit probe — checks which Anthropic models are currently available
 * before the orchestrator commits to a model for an agent run.
 *
 * Anthropic OAuth tokens have separate rate-limit pools per model tier
 * (opus/sonnet/haiku). When one is exhausted, the SDK silently retries forever
 * instead of erroring. This module probes each tier with a tiny POST and
 * returns the cheapest-available tier, so the orchestrator can route around
 * dead tiers automatically (no manual `agentConfig.model` switching).
 *
 * Cost: ~$0.0001 per tier probe (1 input token, max_tokens=1).
 * Cache: 5 minutes (Anthropic rate-limit windows are 5+ hours, but we
 * refresh more often so a recovering tier becomes available quickly).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

const TIER_TO_MODEL_ID: Record<ModelTier, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

interface TierStatus {
  available: boolean;
  checkedAt: number;
  reason?: string;
}

const CACHE_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4_000;

const cache: Record<ModelTier, TierStatus> = {
  opus: { available: true, checkedAt: 0 },
  sonnet: { available: true, checkedAt: 0 },
  haiku: { available: true, checkedAt: 0 },
};

let cachedToken: { value: string; readAt: number } | null = null;
const TOKEN_CACHE_MS = 4 * 60 * 1000;

async function readOauthToken(): Promise<string | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return apiKey;

  const now = Date.now();
  if (cachedToken && now - cachedToken.readAt < TOKEN_CACHE_MS) {
    return cachedToken.value;
  }
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    const parsed = JSON.parse(stdout.trim());
    const token: string | undefined = parsed?.claudeAiOauth?.accessToken;
    if (token) {
      cachedToken = { value: token, readAt: now };
      return token;
    }
  } catch {}
  return undefined;
}

async function probeTier(_tier: ModelTier): Promise<TierStatus> {
  // CRITICAL FIX (2026-05-05): the previous implementation made a raw curl
  // to api.anthropic.com with the OAuth token. That endpoint reports 429
  // separately from the path the actual `claude` binary uses (which routes
  // through Claude Code's first-party gateway with different rate-limit
  // pools). We were getting persistent 429 from the probe while the agent
  // could in fact answer. Result: the orchestrator silently blocked every
  // bot response with "залимичен" notices for 12+ hours.
  //
  // Until we have a probe that mirrors the actual claude-binary auth path,
  // always report tier as available. Real failures will surface via the
  // SDK's actual call result and the existing consecutiveFailures + auth
  // retry mechanisms.
  return { available: true, checkedAt: Date.now(), reason: 'probe-disabled (false-positive on api.anthropic.com)' };
}

async function ensureFresh(tier: ModelTier): Promise<TierStatus> {
  const cached = cache[tier];
  const now = Date.now();
  if (cached.checkedAt > 0 && now - cached.checkedAt < CACHE_MS) {
    return cached;
  }
  const status = await probeTier(tier);
  cache[tier] = status;
  if (!status.available) {
    logger.warn(
      { tier, reason: status.reason },
      'Rate-limit probe: tier unavailable',
    );
  } else if (cached.checkedAt > 0 && !cached.available) {
    logger.info({ tier }, 'Rate-limit probe: tier RECOVERED');
  }
  return status;
}

/**
 * Get the best available tier given a preference.
 * Per user 2026-05-04: NO haiku ever, even when others rate-limited. Chain
 * is opus → sonnet only. If both are 429, returns preferred but caller can
 * detect via `allRateLimited: true` and surface that to the user instead
 * of silently degrading to a dumber model.
 */
export async function getAvailableTier(prefer: ModelTier): Promise<{
  tier: ModelTier;
  fallback: boolean;
  reason?: string;
  allRateLimited?: boolean;
}> {
  const order: ModelTier[] =
    prefer === 'opus' ? ['opus', 'sonnet']
    : prefer === 'sonnet' ? ['sonnet']
    : ['sonnet']; // even if someone passes 'haiku', upgrade to sonnet

  for (const tier of order) {
    const status = await ensureFresh(tier);
    if (status.available) {
      const fallback = tier !== prefer;
      return {
        tier,
        fallback,
        reason: fallback
          ? `${prefer} unavailable (${cache[prefer].reason}), falling back`
          : undefined,
      };
    }
  }
  // Both opus and sonnet down. Return sonnet as least-bad, signal upstream.
  return {
    tier: 'sonnet',
    fallback: prefer !== 'sonnet',
    reason: 'opus AND sonnet rate-limited, attempting sonnet anyway',
    allRateLimited: true,
  };
}

/**
 * Mark a tier as unavailable (called from message-loop when a run errors out
 * with rate-limit-like signature). This forces the next routing decision to
 * skip this tier without waiting for the cache to expire.
 */
export function markTierUnavailable(tier: ModelTier, reason: string): void {
  cache[tier] = {
    available: false,
    checkedAt: Date.now(),
    reason,
  };
  logger.warn({ tier, reason }, 'Rate-limit probe: tier marked unavailable');
}

/**
 * For diagnostic/admin commands.
 */
export function getProbeStatus(): Record<ModelTier, TierStatus> {
  return { ...cache };
}
