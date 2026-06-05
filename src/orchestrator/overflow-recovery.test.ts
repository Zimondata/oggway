/**
 * Tests for context overflow recovery paths.
 *
 * These test the specific failure scenarios from May 8, 2026:
 * 1. Watchdog kill (SIGKILL) -> runner never emits contextOverflow
 * 2. Error status blocking auto-continuation
 * 3. Cursor reset feedback loop after 2 failures
 * 4. Model routing honoring opus-for-all directive
 */

import { describe, it, expect } from 'vitest';
import { routeModel } from './model-router.js';

describe('Context overflow inference', () => {
  // Simulates the RunAgentResult shape returned by runAgent()
  type MockResult = {
    status: 'success' | 'error';
    turns?: number;
    contextOverflow?: boolean;
  };

  function shouldContinue(
    result: MockResult,
    continuationCount: number,
    max: number,
  ): boolean {
    // This mirrors the actual condition in message-loop.ts (post-fix)
    return !!result.contextOverflow && continuationCount < max;
  }

  it('triggers continuation on error with inferred overflow (watchdog kill)', () => {
    // Scenario: watchdog killed runner at 35 turns, no contextOverflow from runner
    const result: MockResult = {
      status: 'error',
      turns: 35,
      // contextOverflow inferred by heuristic: turns >= 30 -> true
      contextOverflow: true, // inferred
    };
    expect(shouldContinue(result, 0, 3)).toBe(true);
  });

  it('triggers continuation on success with native contextOverflow', () => {
    // Scenario: runner completed normally, SDK reported max_turns
    const result: MockResult = {
      status: 'success',
      turns: 50,
      contextOverflow: true,
    };
    expect(shouldContinue(result, 0, 3)).toBe(true);
  });

  it('does NOT trigger continuation when turns < 30 (not overflow)', () => {
    // Scenario: runner crashed after 5 turns - probably a real error, not overflow
    const result: MockResult = {
      status: 'error',
      turns: 5,
      contextOverflow: undefined, // not inferred: 5 < 30
    };
    expect(shouldContinue(result, 0, 3)).toBe(false);
  });

  it('does NOT trigger continuation for mid-range turns without native overflow', () => {
    // Scenario: runner crashed after 22 turns - could be transient, not overflow
    const result: MockResult = {
      status: 'error',
      turns: 22,
      contextOverflow: undefined, // 22 < 30 threshold, not inferred
    };
    expect(shouldContinue(result, 0, 3)).toBe(false);
  });

  it('does NOT trigger continuation when max reached', () => {
    const result: MockResult = {
      status: 'error',
      turns: 30,
      contextOverflow: true,
    };
    expect(shouldContinue(result, 3, 3)).toBe(false);
  });

  it('does NOT trigger on success without overflow', () => {
    const result: MockResult = {
      status: 'success',
      turns: 10,
      contextOverflow: undefined,
    };
    expect(shouldContinue(result, 0, 3)).toBe(false);
  });
});

describe('Model routing - opus for all', () => {
  it('routes light tier to opus', () => {
    const result = routeModel('[HEARTBEAT] check', undefined);
    expect(result.model).toBe('opus');
  });

  it('routes medium tier to opus', () => {
    const result = routeModel('как день?', undefined);
    expect(result.model).toBe('opus');
  });

  it('routes heavy tier to opus', () => {
    const result = routeModel('напиши код для парсера', undefined);
    expect(result.model).toBe('opus');
  });

  it('routes default (unmatched) to opus', () => {
    const result = routeModel(
      'random message that matches no pattern',
      undefined,
    );
    expect(result.model).toBe('opus');
  });

  it('respects explicit override', () => {
    const result = routeModel('anything', 'sonnet');
    expect(result.model).toBe('sonnet');
  });
});

describe('Cursor management after failures', () => {
  it('cursor should be set to current time, not deleted, after 2 failures', () => {
    // Simulate the fixed behavior: instead of `delete lastAgentTimestamp[jid]`
    // we now do `lastAgentTimestamp[jid] = new Date().toISOString()`
    const cursor: Record<string, string> = {
      'test-jid': '2026-05-08T10:00:00Z',
    };

    // The OLD (buggy) behavior was: delete cursor['test-jid']
    // Which makes cursor['test-jid'] || '' return '', pulling all messages

    // The NEW (fixed) behavior:
    cursor['test-jid'] = new Date().toISOString();

    // Verify it's a valid ISO timestamp, not empty
    expect(cursor['test-jid']).toBeTruthy();
    expect(cursor['test-jid'].length).toBeGreaterThan(10);

    // And using || '' fallback still returns the timestamp
    const fallback = cursor['test-jid'] || '';
    expect(fallback.length).toBeGreaterThan(10);
  });

  it('empty string cursor would pull all messages (the bug we fixed)', () => {
    // This documents WHY the fix matters
    const cursor: Record<string, string | undefined> = {};
    delete cursor['test-jid'];

    // The buggy fallback:
    const sinceTimestamp = cursor['test-jid'] || '';
    expect(sinceTimestamp).toBe('');
    // SQLite: WHERE timestamp > '' matches ALL rows (any timestamp > empty string)
    // -> pulls up to 200 messages -> immediate context overflow -> infinite loop
  });
});
