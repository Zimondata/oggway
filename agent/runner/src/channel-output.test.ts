import { describe, it, expect } from 'vitest';
import { resolveChannelOutput } from './channel-output';

// Behavior tests for the channel-output guard. Each case reproduces a past
// channel-leak incident (or guards against over-blocking). A regression in any
// of these branches is what leaked text to the user before — the test catches
// it now, before Женя does.
describe('resolveChannelOutput', () => {
  // baf1386 / d51b2bd: the longest segment is the real answer; a short trailing
  // tail and the sdk result fallback must not win over it.
  it('1. longest segment wins over a shorter segment and over sdk fallback', () => {
    const decision = resolveChannelOutput({
      completedSegments: ['This is the full, real answer the user should see.'],
      trailingText: 'ok',
      sdkResultText: 'ok',
      isAutonomousRun: false,
    });
    expect(decision.deliver).toBe('This is the full, real answer the user should see.');
    expect(decision.sawText).toBe(true);
    expect(decision.blockedReason).toBe(null);
  });

  // 29a0b2a: short trailing chatter (narration after the answer) must not be
  // picked over the longer completed segment.
  it('2. short trailing chatter does not beat a longer completed segment', () => {
    const decision = resolveChannelOutput({
      completedSegments: ['Here is the detailed answer with all the context you asked for.'],
      trailingText: 'done',
      sdkResultText: 'done',
      isAutonomousRun: false,
    });
    expect(decision.deliver).toBe('Here is the detailed answer with all the context you asked for.');
    expect(decision.sawText).toBe(true);
  });

  // 1b4ae5e: a scheduled/cron run's prose is internal reasoning — never
  // forwarded. It speaks to the channel only via explicit send_message.
  it('3. autonomous scheduled run drops turn-text (autonomous-run)', () => {
    const decision = resolveChannelOutput({
      completedSegments: ['Internal reasoning about the scheduled task that must not leak.'],
      trailingText: '',
      sdkResultText: 'Internal reasoning about the scheduled task that must not leak.',
      isAutonomousRun: true,
    });
    expect(decision.deliver).toBe(null);
    expect(decision.blockedReason).toBe('autonomous-run');
    expect(decision.sawText).toBe(true);
  });

  // 493e7b0: dream/reflect run with text only in the trailing segment — still
  // dropped as autonomous.
  it('4. autonomous dream/reflect run with trailing-only text is dropped', () => {
    const decision = resolveChannelOutput({
      completedSegments: [],
      trailingText: 'Reflecting on the day, internal monologue not for the channel.',
      sdkResultText: null,
      isAutonomousRun: true,
    });
    expect(decision.deliver).toBe(null);
    expect(decision.blockedReason).toBe('autonomous-run');
    expect(decision.sawText).toBe(true);
  });

  // 42b5c83: an API-error surfaced as result text must be suppressed (and the
  // caller throws to trigger fresh-session recovery), not forwarded.
  it('5. API-error candidate is blocked (api-error)', () => {
    const decision = resolveChannelOutput({
      completedSegments: [],
      trailingText: '',
      sdkResultText: 'API Error: 529 Overloaded',
      isAutonomousRun: false,
    });
    expect(decision.deliver).toBe(null);
    expect(decision.blockedReason).toBe('api-error');
    expect(decision.sawText).toBe(false);
  });

  // Over-block guard: a normal interactive, non-error reply must pass through
  // untouched.
  it('6. normal interactive reply passes through (no false block)', () => {
    const decision = resolveChannelOutput({
      completedSegments: [],
      trailingText: 'Стек: Rails 8.1 с mise, SQLite, Tailwind v4',
      sdkResultText: 'Стек: Rails 8.1 с mise, SQLite, Tailwind v4',
      isAutonomousRun: false,
    });
    expect(decision.deliver).toBe('Стек: Rails 8.1 с mise, SQLite, Tailwind v4');
    expect(decision.sawText).toBe(true);
    expect(decision.blockedReason).toBe(null);
  });

  // All segments empty/whitespace -> deliver nothing (empty).
  it('7. all-empty/whitespace segments deliver nothing (empty)', () => {
    const decision = resolveChannelOutput({
      completedSegments: ['   ', ''],
      trailingText: '  ',
      sdkResultText: null,
      isAutonomousRun: false,
    });
    expect(decision.deliver).toBe(null);
    expect(decision.blockedReason).toBe('empty');
    expect(decision.sawText).toBe(false);
  });
});
