/**
 * Fact-check pre-hook for outbound agent responses.
 *
 * Scans outgoing text for high-risk claim patterns (file sizes in GB/MB/TB,
 * version strings, percentages, large round counts) and logs suspicious
 * occurrences to `groups/<folder>/memory/topics/hallucination-suspect.md`.
 *
 * Does NOT block messages. False positives are common (a real `du -sh` output
 * of "100KB" would match). The point is to build a per-group dataset of
 * claims-without-evidence the agent can review on next boot.
 *
 * The hook is paired with the `factualityRule` system prompt in
 * `agent/runner/src/index.ts`, which tells the agent to inline-cite tool
 * outputs (`(du -sh logs/ -> 100KB)`). A pattern match WITH such a citation
 * nearby is fine; without it, the line gets flagged.
 *
 * Evidence markers that suppress flagging on a line:
 *   - inline citation arrow: `->` or `→`
 *   - explicit guess markers: `[guess]`, `[непроверено]`, `[unverified]`
 *   - "не знаю" / "не проверяла" admissions
 *   - backtick-quoted code/command (likely a real shell snippet)
 */
import fs from 'fs';
import path from 'path';
import { OutboundEnvelope, OutboundPreHook, HookResult } from './types.js';
import { logger } from './logger.js';

const SIZE_RE = /\b\d+(?:[.,]\d+)?\s*(?:GB|MB|TB|KB|ГБ|МБ|ТБ|КБ)\b/i;
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?\b/i;
const PERCENT_RE = /\b\d+(?:[.,]\d+)?\s*%/;

const EVIDENCE_MARKERS = [
  '->',
  '→',
  '[guess]',
  '[непроверено]',
  '[unverified]',
  '[verified',
  '[checked',
  'не знаю',
  'не проверяла',
  'не проверял',
];

interface FlaggedMatch {
  line: string;
  pattern: string;
  match: string;
}

function findFlags(text: string): FlaggedMatch[] {
  const flags: FlaggedMatch[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const lowered = line.toLowerCase();
    const hasEvidence = EVIDENCE_MARKERS.some((m) => lowered.includes(m.toLowerCase()));
    if (hasEvidence) continue;
    // Skip lines that are clearly code blocks or quoted command output
    if (line.startsWith('    ') || line.startsWith('\t') || /^[`>]/.test(line.trim())) continue;
    // Skip lines that are mostly a backtick-wrapped command
    const backtickRatio = (line.match(/`/g) || []).length;
    if (backtickRatio >= 2) continue;

    const sizeMatch = line.match(SIZE_RE);
    if (sizeMatch) {
      flags.push({ line: line.trim(), pattern: 'size', match: sizeMatch[0] });
      continue;
    }
    const percentMatch = line.match(PERCENT_RE);
    if (percentMatch) {
      flags.push({ line: line.trim(), pattern: 'percent', match: percentMatch[0] });
      continue;
    }
    // Version match is noisy (dates, IPs); only flag if line also mentions a product-like word
    const versionMatch = line.match(VERSION_RE);
    if (versionMatch && /\b(version|версия|v\d|release|релиз)\b/i.test(line)) {
      flags.push({ line: line.trim(), pattern: 'version', match: versionMatch[0] });
    }
  }
  return flags;
}

export function createFactCheckHook(groupsDir: string): OutboundPreHook {
  return async (envelope: OutboundEnvelope): Promise<HookResult<OutboundEnvelope>> => {
    if (envelope.triggerType !== 'agent-response') {
      return { action: 'continue' };
    }
    if (!envelope.groupFolder) {
      return { action: 'continue' };
    }
    const flags = findFlags(envelope.text);
    if (flags.length === 0) {
      return { action: 'continue' };
    }

    try {
      const suspectFile = path.join(
        groupsDir,
        envelope.groupFolder,
        'memory',
        'topics',
        'hallucination-suspect.md',
      );
      fs.mkdirSync(path.dirname(suspectFile), { recursive: true });
      if (!fs.existsSync(suspectFile)) {
        const header = [
          '# Hallucination Suspect Log',
          '',
          'Auto-populated by fact-check-hook. Lines below contain verifiable claims (size/percent/version) without inline evidence markers (`->`, `[guess]`, etc).',
          '',
          'On boot, review recent entries: if a flagged claim was actually verified, the agent forgot to cite. If it was a guess, the agent forgot to mark it. Either way, drift from the factuality rule.',
          '',
          '---',
          '',
        ].join('\n');
        fs.writeFileSync(suspectFile, header);
      }
      const ts = new Date().toISOString();
      const block = [
        `## ${ts}`,
        ...flags.map((f) => `- [${f.pattern}: \`${f.match}\`] ${f.line}`),
        '',
      ].join('\n');
      fs.appendFileSync(suspectFile, block);
      logger.debug(
        { groupFolder: envelope.groupFolder, flagCount: flags.length, patterns: flags.map((f) => f.pattern) },
        'fact-check-hook flagged outbound message',
      );
    } catch (err) {
      logger.warn({ err }, 'fact-check-hook failed to write suspect log (continuing)');
    }

    return { action: 'continue' };
  };
}
