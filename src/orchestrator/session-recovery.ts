/**
 * Session recovery and persistence.
 *
 * Persists SDK session IDs to JSON so sessions survive service restarts.
 * Also manages cross-session carryover: when a session is dropped/reset,
 * the next session gets a brief summary of what was happening.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

interface SessionMappings {
  [groupFolder: string]: {
    sessionId: string;
    createdAt: string;
    lastActivity: string;
  };
}

interface SessionCarryover {
  [groupFolder: string]: {
    summary: string;
    droppedAt: string;
  };
}

const STATE_ROOT = process.cwd();
const SESSION_MAPPINGS_FILE = path.join(STATE_ROOT, '.session-mappings.json');
const SESSION_CARRYOVER_FILE = path.join(STATE_ROOT, '.session-carryover.json');

/**
 * Load session mappings from disk. Returns empty object if file doesn't exist.
 */
export function loadSessionMappings(): SessionMappings {
  try {
    if (!fs.existsSync(SESSION_MAPPINGS_FILE)) {
      return {};
    }
    const data = fs.readFileSync(SESSION_MAPPINGS_FILE, 'utf8');
    return JSON.parse(data) as SessionMappings;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        file: SESSION_MAPPINGS_FILE,
      },
      'Failed to load session mappings, starting fresh',
    );
    return {};
  }
}

/**
 * Persist session mappings to disk (atomic write).
 */
export function saveSessionMappings(mappings: SessionMappings): void {
  try {
    const tmp = SESSION_MAPPINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mappings, null, 2), 'utf8');
    fs.renameSync(tmp, SESSION_MAPPINGS_FILE);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to save session mappings',
    );
  }
}

/**
 * Register a session: update the mappings and persist.
 */
export function registerSession(
  groupFolder: string,
  sessionId: string,
  mappings: SessionMappings,
): void {
  mappings[groupFolder] = {
    sessionId,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  };
  saveSessionMappings(mappings);
}

/**
 * Update last activity timestamp for a session.
 */
export function updateSessionActivity(
  groupFolder: string,
  mappings: SessionMappings,
): void {
  if (mappings[groupFolder]) {
    mappings[groupFolder].lastActivity = new Date().toISOString();
    saveSessionMappings(mappings);
  }
}

/**
 * Load carryover summaries from disk.
 */
export function loadSessionCarryover(): SessionCarryover {
  try {
    if (!fs.existsSync(SESSION_CARRYOVER_FILE)) {
      return {};
    }
    const data = fs.readFileSync(SESSION_CARRYOVER_FILE, 'utf8');
    return JSON.parse(data) as SessionCarryover;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        file: SESSION_CARRYOVER_FILE,
      },
      'Failed to load session carryover',
    );
    return {};
  }
}

/**
 * Save carryover summaries to disk (atomic write).
 */
export function saveSessionCarryover(carryover: SessionCarryover): void {
  try {
    const tmp = SESSION_CARRYOVER_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(carryover, null, 2), 'utf8');
    fs.renameSync(tmp, SESSION_CARRYOVER_FILE);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to save session carryover',
    );
  }
}

/**
 * Record a carryover summary when dropping a session.
 * Summary should be concise (1-2 sentences) about what was discussed.
 */
export function recordCarryover(
  groupFolder: string,
  summary: string,
  carryover: SessionCarryover,
): void {
  carryover[groupFolder] = {
    summary,
    droppedAt: new Date().toISOString(),
  };
  saveSessionCarryover(carryover);
}

/**
 * Consume a carryover summary (remove it after use).
 */
export function consumeCarryover(
  groupFolder: string,
  carryover: SessionCarryover,
): string | null {
  const item = carryover[groupFolder];
  if (!item) return null;
  delete carryover[groupFolder];
  saveSessionCarryover(carryover);
  return item.summary;
}

/**
 * Clear all session state (used for testing / explicit reset).
 */
export function clearAllSessions(): void {
  try {
    if (fs.existsSync(SESSION_MAPPINGS_FILE))
      fs.unlinkSync(SESSION_MAPPINGS_FILE);
    if (fs.existsSync(SESSION_CARRYOVER_FILE))
      fs.unlinkSync(SESSION_CARRYOVER_FILE);
    logger.info('Cleared all session files');
  } catch (err) {
    logger.warn({ err }, 'Failed to clear session files');
  }
}
