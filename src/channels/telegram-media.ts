import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from '../orchestrator/logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_SCRIPT = `
import sys, whisper
model = whisper.load_model("turbo")
result = model.transcribe(sys.argv[1], fp16=False, language="ru")
print(result["text"].strip())
`;

/**
 * Transcribe an audio file using local openai-whisper (Python).
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  audioPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', WHISPER_SCRIPT, audioPath],
      { maxBuffer: 10 * 1024 * 1024, timeout: 180_000 },
    );
    const text = stdout.trim();
    if (!text) return null;
    return text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), audioPath },
      'Whisper transcription failed',
    );
    return null;
  }
}

/**
 * Extract text from a PDF using pdftotext (poppler-utils).
 * Returns extracted text or null on failure.
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', pdfPath, '-'],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 },
    );
    const text = stdout.trim();
    if (!text) return null;
    const MAX = 15000;
    if (text.length > MAX) {
      return `${text.slice(0, MAX)}\n\n[... truncated ${text.length - MAX} chars ...]`;
    }
    return text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), pdfPath },
      'pdftotext extraction failed',
    );
    return null;
  }
}

/**
 * Download a Telegram file to a temporary path.
 * Returns the local path on success, null on failure.
 * Caller must unlink the file when done.
 */
export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  suffix = '',
): Promise<string | null> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const tmpPath = path.join(
    os.tmpdir(),
    `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`,
  );
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(
        { status: response.status, filePath },
        'Telegram file download failed',
      );
      return null;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), filePath },
      'Telegram file download error',
    );
    return null;
  }
}

export function cleanupTempFile(tmpPath: string): void {
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
}
