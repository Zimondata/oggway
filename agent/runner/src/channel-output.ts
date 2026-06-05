// Pure channel-output guard. Decides what text from an agent turn may reach
// the channel (Telegram, etc.), or that nothing should. Extracted from
// index.ts so the delivery decision can be exercised by vitest without
// importing the SDK. NO SDK imports — keep this module pure.
//
// Every past channel-leak incident is a branch of resolveChannelOutput:
//   baf1386 / d51b2bd — longest segment must win over shorter / sdk fallback
//   29a0b2a           — short trailing chatter must not beat a longer segment
//   1b4ae5e / 493e7b0 — autonomous (scheduled/dream/reflect) prose never leaks
//   42b5c83 / 8e64e5d — API-error text is suppressed, not forwarded

export interface ChannelOutputInput {
  completedSegments: string[];
  trailingText: string;
  sdkResultText: string | null;
  isAutonomousRun: boolean;
}

export type ChannelOutputBlockedReason = 'api-error' | 'autonomous-run' | 'empty';

export interface ChannelOutputDecision {
  deliver: string | null;
  blockedReason: ChannelOutputBlockedReason | null;
  sawText: boolean;
}

// One structured record per agent turn, for the agent_turns observability
// table. Built in the runner result handler (which has the decision + token
// boundaries) and piggybacked on the runner's existing stdout output payload
// so it reaches the orchestrator without a new IPC channel. The orchestrator
// side mirrors this shape (it compiles separately and cannot import this file).
export type ChannelTurnRunKind = 'interactive' | 'scheduled' | 'dream' | 'reflect' | 'error';

export interface ChannelTurnLog {
  turnIndex: number;
  runKind: ChannelTurnRunKind;
  toolsCalled: string[];
  textGeneratedChars: number;
  textSentChars: number;
  blockedReason: ChannelOutputBlockedReason | null;
  hadError: boolean;
  errorType: string | null;
}

// Same shape the SDK surfaces for an API error result whose text IS the error
// string ("API Error: 400 …"). Literal copied from index.ts result handler:
// start of string, optional whitespace, "API Error:", a 3-digit code.
export function isApiErrorText(text: string): boolean {
  return /^\s*API Error: \d{3}/.test(text);
}

// Pick the longest text segment of a turn. Segments captured before tool calls
// live in completedSegments; the trailing segment is passed separately. Copy
// the array, push trailingText when non-empty (after trim), then reduce to the
// segment with the longest trimmed length (seed = empty string).
export function pickLongestSegment(completedSegments: string[], trailingText: string): string {
  const segments = [...completedSegments];
  if (trailingText.trim()) segments.push(trailingText);
  return segments.reduce(
    (best, seg) => (seg.trim().length > best.trim().length ? seg : best),
    '',
  );
}

export function resolveChannelOutput(input: ChannelOutputInput): ChannelOutputDecision {
  const longest = pickLongestSegment(input.completedSegments, input.trailingText);
  const candidate = longest.trim() ? longest : (input.sdkResultText ?? '');

  if (isApiErrorText(candidate)) {
    return { deliver: null, blockedReason: 'api-error', sawText: false };
  }
  if (input.isAutonomousRun) {
    return { deliver: null, blockedReason: 'autonomous-run', sawText: candidate.trim().length > 0 };
  }
  if (candidate.trim()) {
    return { deliver: candidate, blockedReason: null, sawText: true };
  }
  return { deliver: null, blockedReason: 'empty', sawText: false };
}
