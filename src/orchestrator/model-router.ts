/**
 * Model Router - rule-based model selection for cost optimization.
 *
 * Classifies prompts into tiers and returns the appropriate model.
 * Cuts costs by routing simple tasks to cheaper models while keeping
 * complex work on expensive ones.
 *
 * Tiers:
 *   light  -> opus   (all tasks use opus per user directive 2026-05-08)
 *   medium -> opus
 *   heavy  -> opus
 */

import { logger } from './logger.js';
import { classifyPromptComplexity } from './llm-classifier.js';
import { getAvailableTier, type ModelTier as AvailTier } from './rate-limit-probe.js';

export type ModelTier = 'light' | 'medium' | 'heavy';

interface RouteResult {
  tier: ModelTier;
  model: string;
  reason: string;
}

// Tier -> model mapping. Explicit model ID, no alias guessing.
// Per user 2026-05-28: Opus 4.8 для всего.
const TIER_MODELS: Record<ModelTier, string> = {
  light: 'claude-opus-4-8',
  medium: 'claude-opus-4-8',
  heavy: 'claude-opus-4-8',
};

// --- Pattern matchers (order matters: first match wins) ---

// Note: \b word boundaries do NOT work with Cyrillic in JS regex because
// Cyrillic chars are not in \w ([a-zA-Z0-9_]). Cyrillic patterns use plain
// matches or (?:^|\s) anchors instead.

const HEAVY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /напиши код|write code|\bimplement\b|\brefactor\b|\bdebug\b|fix bug|\bPR\b|pull request/i, reason: 'coding task' },
  { pattern: /проанализируй|deep analysis|\baudit\b|ревью|\breview\b|\bcompare\b|сравни/i, reason: 'deep analysis' },
  { pattern: /\broadmap\b|\bstrategy\b|стратегия|архитектура|\barchitecture\b/i, reason: 'planning/architecture' },
  { pattern: /напиши пост|напиши текст|write .{0,20}text|\bpost\b|статья|\barticle\b|tone of voice/i, reason: 'content creation' },
  { pattern: /исследуй|\bresearch\b|ресерч|find.*github|найди.*решение|сделай research/i, reason: 'research task' },
  { pattern: /лезь.*инет|лезь.*интернет|ищи.*в интернете|посмотри что.*на рынке|что есть на рынке|кто.*уже.*сделал|кто.*это.*делал|посмотри.*люди.*сделали|собрать инфу|собери инфу|инфа.*по теме/i, reason: 'web research' },
  { pattern: /сделай.*решение|пиздат|\bambitious\b|\bcomplex\b/i, reason: 'complex task' },
  { pattern: /\bGarmin\b|\bgarmin\b|гармин|browser_navigate|\bplaywright\b/i, reason: 'browser automation' },
  { pattern: /viral.*scout|content.*scout/i, reason: 'content scout' },
  { pattern: /план разработки|план проекта|разработай план|спланируй|развёрнут|разбери подробно|подробный разбор/i, reason: 'planning task' },
];

const LIGHT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /бэкап|\bbackup\b|\brsync\b|\bcopy\b|скопируй/i, reason: 'backup task' },
  { pattern: /^\[?(HEARTBEAT|DREAM|REFLECT|COST-WATCH)/i, reason: 'system task' },
  { pattern: /напомни.*спать|sleep reminder|лечь спать|напомни лечь/i, reason: 'sleep reminder' },
  { pattern: /HEARTBEAT_OK/, reason: 'heartbeat noop' },
  { pattern: /^(привет|hi|hello|ку|здарова|yo)\s*[.!?]*$/i, reason: 'greeting' },
  { pattern: /^(ок|ok|лан|ладно|понял|ясно|спасибо|thanks)\s*[.!?]*$/i, reason: 'acknowledgment' },
  { pattern: /который час|\bwhat time\b|\btime is it\b|дата|\bdate today\b/i, reason: 'time/date query' },
  { pattern: /переведи|\btranslate\b|перевод/i, reason: 'translation' },
  { pattern: /напомни Жене|напомни.*завтра/i, reason: 'simple reminder' },
];

const MEDIUM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bwellbeing\b|check-in|чекин|как спал|как день|самочувствие/i, reason: 'wellbeing check-in' },
  { pattern: /посчитай|\bcalculate\b|калории|КБЖУ|\bnutrition\b|еда/i, reason: 'nutrition/calculation' },
  { pattern: /что нового|новости|\bnews\b|\bupdate\b/i, reason: 'news/updates' },
  { pattern: /объясни|\bexplain\b|расскажи|\bwhat is\b|что такое|как работает/i, reason: 'explanation' },
  { pattern: /найди|\bsearch\b|поиск|загугли|websearch/i, reason: 'search task' },
];

/**
 * Classify a prompt and return the recommended model.
 *
 * Priority: explicit override > heavy patterns > light patterns > medium patterns > default (heavy/opus).
 *
 * Quality-first default: when rules don't match, we route to Opus.
 * Use `routeModelWithLLM` to additionally consult an LLM classifier
 * that can downgrade to Haiku for trivial prompts.
 */
export function routeModel(
  prompt: string,
  explicitModel?: string,
): RouteResult {
  // Explicit override always wins
  if (explicitModel) {
    const tier = modelToTier(explicitModel);
    return { tier, model: explicitModel, reason: 'explicit override' };
  }

  // System task prefixes always get light tier regardless of content
  if (/^\[?(HEARTBEAT|DREAM|REFLECT|COST-WATCH)/i.test(prompt)) {
    return { tier: 'light', model: TIER_MODELS.light, reason: 'system task prefix' };
  }

  // Check heavy patterns first (we don't want to accidentally downgrade)
  for (const { pattern, reason } of HEAVY_PATTERNS) {
    if (pattern.test(prompt)) {
      return { tier: 'heavy', model: TIER_MODELS.heavy, reason };
    }
  }

  // Check light patterns
  for (const { pattern, reason } of LIGHT_PATTERNS) {
    if (pattern.test(prompt)) {
      return { tier: 'light', model: TIER_MODELS.light, reason };
    }
  }

  // Check medium patterns
  for (const { pattern, reason } of MEDIUM_PATTERNS) {
    if (pattern.test(prompt)) {
      return { tier: 'medium', model: TIER_MODELS.medium, reason };
    }
  }

  // Default: opus for everything.
  return { tier: 'heavy', model: TIER_MODELS.heavy, reason: 'default-opus' };
}

/**
 * Map a model name/alias to a tier for logging/tracking.
 */
function modelToTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'light';
  if (m.includes('opus')) return 'heavy';
  return 'medium'; // sonnet or unknown -> medium
}

/**
 * Route and log. Returns just the model string for easy integration.
 */
export function selectModel(
  prompt: string,
  context: { groupFolder: string; taskId?: string },
  explicitModel?: string,
): string {
  const result = routeModel(prompt, explicitModel);
  logger.debug(
    {
      group: context.groupFolder,
      taskId: context.taskId,
      tier: result.tier,
      model: result.model,
      reason: result.reason,
    },
    'Model router decision',
  );
  return result.model;
}

/**
 * Route with LLM-assisted classification when rule-based result is the default.
 *
 * Calls a tiny Haiku request to ask whether this prompt would benefit from Opus
 * or can be answered equivalently by a smaller model. Only used when we'd
 * otherwise fall back to the default (rule-based no-match) — rules still win
 * when they match a clear pattern.
 *
 * Cost: ~$0.0001 per classification (tiny prompt, max_tokens=4).
 * Latency: ~300-700ms; bounded by 6s timeout, falls back to rule-based on failure.
 */
// Map an alias/tier ('opus'|'sonnet'|'haiku') to the rate-limit-probe tier.
function aliasToProbeTier(model: string): AvailTier {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  return 'sonnet';
}

// Apply rate-limit fallback: if preferred tier is exhausted (429),
// transparently route to the next available tier (opus → sonnet → haiku).
async function applyRateLimitFallback(
  preferredModel: string,
  context: { groupFolder: string; taskId?: string },
  baseReason: string,
): Promise<{ model: string; reason: string }> {
  const prefer = aliasToProbeTier(preferredModel);
  try {
    const result = await getAvailableTier(prefer);
    if (result.fallback) {
      logger.warn(
        {
          group: context.groupFolder,
          taskId: context.taskId,
          preferred: preferredModel,
          using: result.tier,
          probeReason: result.reason,
        },
        'Rate-limit fallback engaged',
      );
      return {
        model: result.tier,
        reason: `${baseReason}+rate-fallback:${preferredModel}->${result.tier}`,
      };
    }
    return { model: preferredModel, reason: baseReason };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Rate-limit probe failed, using preferred',
    );
    return { model: preferredModel, reason: baseReason };
  }
}

export async function selectModelAsync(
  prompt: string,
  context: { groupFolder: string; taskId?: string },
  explicitModel?: string,
): Promise<string> {
  const baseResult = routeModel(prompt, explicitModel);

  // All tiers map to opus now. Skip LLM classifier (saves ~300-700ms latency).
  // Only apply rate-limit fallback to avoid stuck opus -> sonnet if needed.
  const final = await applyRateLimitFallback(
    baseResult.model,
    context,
    baseResult.reason,
  );
  logger.debug(
    {
      group: context.groupFolder,
      taskId: context.taskId,
      tier: aliasToProbeTier(final.model),
      model: final.model,
      reason: final.reason,
    },
    'Model router decision',
  );
  return final.model;
}
