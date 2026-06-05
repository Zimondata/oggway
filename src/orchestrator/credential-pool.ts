/**
 * Credential pool — round-robin between multiple Anthropic API keys.
 *
 * Single API key is a single point of failure: hit the 5h Pro/Tier limit
 * and the agent goes silent for hours. Pool of 2-3 keys lets us rotate
 * on 429, mark dead keys until reset, and keep the agent responsive.
 *
 * Sources for the pool (in order):
 *   1. ANTHROPIC_API_KEYS=key1,key2,key3 (preferred — single env var)
 *   2. ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2, ... (numbered fallback)
 *   3. ANTHROPIC_API_KEY (single key — no rotation, just legacy fallback)
 *
 * Strategy: sticky for 60s on the same key (preserves Anthropic prompt
 * cache on a per-key basis), then rotate. 429 immediately marks the key
 * dead until the parsed reset time and bumps to the next live key.
 */

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

interface PoolKey {
  value: string;
  label: string;       // short label for logs (last 4 chars of key)
  deadUntil: number | null;  // ms timestamp; null = alive
  usageCount: number;
  lastUsed: number;    // ms timestamp
}

let pool: PoolKey[] = [];
let lastIndex = -1;
let stickyKey: PoolKey | null = null;
let stickyUntil = 0;

const STICKY_WINDOW_MS = 60_000;

function loadPoolFromEnv(): PoolKey[] {
  const env = readEnvFile([
    'ANTHROPIC_API_KEYS',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY_1',
    'ANTHROPIC_API_KEY_2',
    'ANTHROPIC_API_KEY_3',
    'ANTHROPIC_API_KEY_4',
    'ANTHROPIC_API_KEY_5',
  ]);

  const fromProcess = (k: string) => process.env[k] || env[k] || '';

  const list: string[] = [];
  // 1. Comma-separated list
  const csv = fromProcess('ANTHROPIC_API_KEYS').trim();
  if (csv) {
    list.push(...csv.split(',').map((s) => s.trim()).filter(Boolean));
  }
  // 2. Numbered fallback
  for (let i = 1; i <= 5; i++) {
    const key = fromProcess(`ANTHROPIC_API_KEY_${i}`).trim();
    if (key) list.push(key);
  }
  // 3. Legacy single key
  const single = fromProcess('ANTHROPIC_API_KEY').trim();
  if (single && !list.includes(single)) list.push(single);

  // Dedupe in case of overlap
  const seen = new Set<string>();
  const unique = list.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return unique.map((value, idx) => ({
    value,
    label: `key${idx + 1}-${value.slice(-4)}`,
    deadUntil: null,
    usageCount: 0,
    lastUsed: 0,
  }));
}

export function initCredentialPool(): void {
  pool = loadPoolFromEnv();
  if (pool.length === 0) {
    logger.warn('Credential pool: no API keys found in env');
  } else if (pool.length === 1) {
    logger.info({ keys: pool.map((p) => p.label) }, 'Credential pool: single-key mode (no rotation)');
  } else {
    logger.info(
      { keys: pool.map((p) => p.label), count: pool.length },
      'Credential pool initialised',
    );
  }
}

function liveKeys(): PoolKey[] {
  const now = Date.now();
  return pool.filter((k) => !k.deadUntil || k.deadUntil <= now);
}

/**
 * Return the API key the next agent run should use. Honours sticky
 * window so a multi-turn dialog hits the same key (preserves cache).
 *
 * Returns null when every key is dead — caller should fall back to
 * existing rate-limit guard behaviour.
 */
export function getNextKey(): { value: string; label: string } | null {
  if (pool.length === 0) return null;
  const now = Date.now();

  // Sticky window: if the previously-chosen key is still alive and the
  // window hasn't expired, keep using it.
  if (stickyKey && stickyUntil > now) {
    const stillAlive = !stickyKey.deadUntil || stickyKey.deadUntil <= now;
    if (stillAlive) {
      stickyKey.usageCount++;
      stickyKey.lastUsed = now;
      return { value: stickyKey.value, label: stickyKey.label };
    }
  }

  const live = liveKeys();
  if (live.length === 0) {
    logger.warn(
      { dead: pool.length },
      'Credential pool: all keys exhausted',
    );
    return null;
  }

  // Round-robin among live keys.
  let candidate: PoolKey;
  if (live.length === 1) {
    candidate = live[0];
  } else {
    lastIndex = (lastIndex + 1) % live.length;
    candidate = live[lastIndex];
  }

  candidate.usageCount++;
  candidate.lastUsed = now;
  stickyKey = candidate;
  stickyUntil = now + STICKY_WINDOW_MS;

  logger.debug(
    { key: candidate.label, live: live.length, total: pool.length },
    'Credential pool: selected key',
  );
  return { value: candidate.value, label: candidate.label };
}

/**
 * Mark a key dead until the given time. Use after a 429 / rate-limit hit.
 * Resets sticky if the dead key was sticky.
 */
export function markKeyDead(label: string, until: Date): void {
  const key = pool.find((k) => k.label === label);
  if (!key) {
    logger.warn({ label }, 'Credential pool: markKeyDead for unknown key');
    return;
  }
  key.deadUntil = until.getTime();
  if (stickyKey === key) {
    stickyKey = null;
    stickyUntil = 0;
  }
  logger.warn(
    { key: label, until: until.toISOString() },
    'Credential pool: key marked dead',
  );
}

export function getPoolStatus(): Array<{
  label: string;
  alive: boolean;
  deadUntil: string | null;
  usageCount: number;
  lastUsedIso: string | null;
}> {
  const now = Date.now();
  return pool.map((k) => ({
    label: k.label,
    alive: !k.deadUntil || k.deadUntil <= now,
    deadUntil: k.deadUntil ? new Date(k.deadUntil).toISOString() : null,
    usageCount: k.usageCount,
    lastUsedIso: k.lastUsed ? new Date(k.lastUsed).toISOString() : null,
  }));
}

/** True when the pool is functional (≥1 key, may be ≥1 alive). */
export function isPoolConfigured(): boolean {
  return pool.length > 0;
}

/** True when ≥1 key is still alive (eligible for use). */
export function hasLiveKeys(): boolean {
  return liveKeys().length > 0;
}

/** Return the label of the most recently issued key (sticky), or null. */
export function getCurrentKeyLabel(): string | null {
  if (!stickyKey) return null;
  return stickyKey.label;
}

/** @internal — for tests */
export function _resetPoolForTests(): void {
  pool = [];
  lastIndex = -1;
  stickyKey = null;
  stickyUntil = 0;
}
