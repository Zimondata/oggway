/**
 * URL enricher — pre-fetches content for known URL patterns and injects it
 * into messages BEFORE they reach the agent.
 *
 * Why: small models (haiku) often fail to discover that a script exists in
 * memory/scripts/ to fetch YouTube transcripts. They give up and reply
 * "не могу из-за сетевых ограничений". Even with MEMORY.md hints, the
 * connection isn't reliably made.
 *
 * Solution: orchestrator-side pre-processing. When user sends a YouTube
 * link, we run transcribe-youtube.py here and append the transcript to
 * the message content. Agent receives a fully-loaded prompt and just
 * has to summarize/save — no tool exploration required.
 *
 * Failure modes are logged but never block the message; on script error
 * the original message passes through unchanged.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

const execFileP = promisify(execFile);

const YT_SCRIPT = (groupFolder: string) =>
  path.join(
    GROUPS_DIR,
    groupFolder,
    'memory',
    'scripts',
    'transcribe-youtube.py',
  );

const YT_URL_RE =
  /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+)[^\s)]*/g;

const MAX_TRANSCRIPT_CHARS = 30_000;
const SCRIPT_TIMEOUT_MS = 15_000;

interface EnrichResult {
  modifiedContent?: string;
  enrichmentNote?: string;
}

async function fetchYouTubeTranscript(
  url: string,
  groupFolder: string,
): Promise<string | null> {
  const script = YT_SCRIPT(groupFolder);
  try {
    const { stdout } = await execFileP('python3', [script, url], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 5_000_000,
    });
    const text = stdout.trim();
    if (!text || text.startsWith('Ошибка:')) return null;
    return text;
  } catch (err: any) {
    const msg = err?.stderr?.toString() || err?.message || String(err);
    logger.debug(
      { url, err: msg.slice(0, 200) },
      'YouTube transcript fetch failed',
    );
    return null;
  }
}

export async function enrichMessage(
  msg: NewMessage,
  groupFolder: string,
): Promise<EnrichResult> {
  const urls = msg.content.match(YT_URL_RE);
  if (!urls || urls.length === 0) return {};

  // Only enrich first URL to avoid massive prompts.
  const url = urls[0];

  const transcript = await fetchYouTubeTranscript(url, groupFolder);
  if (!transcript) {
    return {};
  }

  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) +
        `\n\n[...truncated, full ${transcript.length} chars]`
      : transcript;

  const note = `[YouTube transcript auto-fetched for ${url}, ${transcript.length} chars]`;
  logger.info(
    {
      group: groupFolder,
      url,
      transcriptChars: transcript.length,
      truncated: transcript.length > MAX_TRANSCRIPT_CHARS,
    },
    'URL enricher: YouTube transcript injected',
  );

  return {
    modifiedContent: `${msg.content}\n\n${note}\n\n--- BEGIN TRANSCRIPT ---\n${truncated}\n--- END TRANSCRIPT ---`,
    enrichmentNote: note,
  };
}

/**
 * Apply enrichment to a batch of messages. Returns a new array with
 * modified content where applicable; original objects are not mutated.
 */
export async function enrichMessages(
  messages: NewMessage[],
  groupFolder: string,
): Promise<NewMessage[]> {
  return Promise.all(
    messages.map(async (m) => {
      const result = await enrichMessage(m, groupFolder);
      if (result.modifiedContent) {
        return { ...m, content: result.modifiedContent };
      }
      return m;
    }),
  );
}
