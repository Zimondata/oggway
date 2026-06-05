/**
 * LLM-based task complexity classifier.
 *
 * Asks Claude Haiku whether a given prompt would benefit from Opus
 * or can be handled equivalently by Haiku. Used by the model router
 * when rule-based matching falls through to default.
 *
 * Calls Anthropic API directly from the orchestrator host (network is
 * unrestricted here; only sandbox is firewalled). Token from keychain.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const HAIKU_MODEL = 'claude-haiku-4-5';
const CLASSIFIER_TIMEOUT_MS = 6000;

const SYSTEM = `You are a task-complexity classifier for an AI assistant.
Output exactly one word: SONNET or OPUS.

SONNET: routine tasks not requiring deep intelligence — brief explanations, status updates, light analysis, summarization of one source, conversational chat, simple file edits, greetings/acks, time/date queries, casual replies. Minimum bar: still smart enough to discover and call tools.
OPUS: research across multiple sources, code/debug, architecture or strategy, nuanced reasoning, multi-step plans, content creation that must land well, anything where the user invested effort in describing the task.

When uncertain — choose OPUS. Quality matters more than cost.
Reply with only SONNET or OPUS — no explanation, no other words.`;

let cachedToken: { value: string; readAt: number } | null = null;
const TOKEN_CACHE_MS = 4 * 60 * 1000;

async function readOauthToken(): Promise<string | undefined> {
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

export type ClassifierTier = 'sonnet' | 'opus';

export async function classifyPromptComplexity(
  prompt: string,
): Promise<ClassifierTier | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const token = apiKey ? undefined : await readOauthToken();
  if (!apiKey && !token) return null;

  const trimmed = prompt.length > 4000 ? prompt.slice(0, 4000) : prompt;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else if (token) {
    headers['authorization'] = `Bearer ${token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 4,
        system: SYSTEM,
        messages: [{ role: 'user', content: trimmed }],
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      logger.debug(
        { status: res.status },
        'classifier: api returned non-2xx, defaulting',
      );
      return null;
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content?.[0]?.text || '').trim().toUpperCase();
    // Treat HAIKU as SONNET (per user policy: minimum is sonnet).
    if (text.startsWith('HAIKU') || text.startsWith('SONNET')) return 'sonnet';
    if (text.startsWith('OPUS')) return 'opus';
    return null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'classifier: request failed, defaulting',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
