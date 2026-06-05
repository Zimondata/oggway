import { describe, it, expect } from 'vitest';
import {
  _getContinuationCount,
  _setContinuationCount,
  _MAX_AUTO_CONTINUATIONS,
} from './message-loop.js';

describe('Auto-continuation on context overflow', () => {
  it('MAX_AUTO_CONTINUATIONS is at least 3', () => {
    expect(_MAX_AUTO_CONTINUATIONS).toBeGreaterThanOrEqual(3);
  });

  it('continuation counter starts at 0 for unknown folders', () => {
    expect(_getContinuationCount('nonexistent-folder-xyz')).toBe(0);
  });

  it('continuation counter can be set and read', () => {
    const folder = 'test-folder-set-read';
    _setContinuationCount(folder, 2);
    expect(_getContinuationCount(folder)).toBe(2);
    // cleanup
    _setContinuationCount(folder, 0);
  });

  it('counter reset to 0 simulates new user message behavior', () => {
    // Simulate: agent overflowed twice, counter stuck at MAX
    const folder = 'test-folder-reset';
    _setContinuationCount(folder, _MAX_AUTO_CONTINUATIONS);
    expect(_getContinuationCount(folder)).toBe(_MAX_AUTO_CONTINUATIONS);

    // Simulate: new user message resets counter (the bug fix)
    _setContinuationCount(folder, 0);
    expect(_getContinuationCount(folder)).toBe(0);

    // Now counter < MAX, so auto-continuation would fire
    expect(_getContinuationCount(folder) < _MAX_AUTO_CONTINUATIONS).toBe(true);
    // cleanup
    _setContinuationCount(folder, 0);
  });

  it('counter increments up to MAX and blocks further continuations', () => {
    const folder = 'test-folder-max';
    for (let i = 0; i < _MAX_AUTO_CONTINUATIONS; i++) {
      expect(_getContinuationCount(folder) < _MAX_AUTO_CONTINUATIONS).toBe(
        true,
      );
      _setContinuationCount(folder, _getContinuationCount(folder) + 1);
    }
    // At MAX - no more continuations allowed
    expect(_getContinuationCount(folder) < _MAX_AUTO_CONTINUATIONS).toBe(false);
    expect(_getContinuationCount(folder)).toBe(_MAX_AUTO_CONTINUATIONS);
    // cleanup
    _setContinuationCount(folder, 0);
  });
});
