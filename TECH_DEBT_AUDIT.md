# Tech Debt Audit - ClaudeClaw

Generated: 2026-05-05
Codebase: ~18,900 LOC TypeScript
Tool: tech-debt-audit skill (manual run)

## Executive summary

- 4 Critical, 13 High, 16 Medium, 8 Low findings
- Debt concentration: `src/orchestrator/message-loop.ts` (1617 LOC god file, 25 commits in 3 months, zero tests)
- Second concentration: `src/runtimes/` (container-runner 751 LOC + sandbox-runner 813 LOC with duplicated parsing logic)
- **Blocking risk:** 3 sync I/O calls (`execFileSync`, `writeFileSync`) in async hot paths block the event loop
- **Security:** SQL field interpolation in skill-registry, shell injection pattern in whatsapp.ts
- **Test gap:** 7 critical modules (message-loop, model-router, selfheal, rate-limit-probe, ipc, llm-classifier, extension-loader) have zero test coverage
- Positive: SQLite usage is solid (WAL mode, busy_timeout), channel implementations are clean, config system works

## Architectural mental model

ClaudeClaw is a single-process Node.js service that polls a SQLite database for new messages, dispatches them to Claude SDK agents running in isolated environments (Apple Container or OS-level sandbox), and routes responses back through messaging channels (Telegram, WhatsApp, Slack).

The message loop (`message-loop.ts`) is the heart - it polls every 2s, checks triggers, manages sessions, spawns agents via `group-queue.ts`, and handles streaming output. Two parallel runtime implementations (container-runner, sandbox-runner) build CLI args, mount volumes/paths, and parse agent output using identical marker-based JSON extraction.

IPC between orchestrator and agents happens via filesystem (JSON files in `data/ipc/`). Extensions are dynamically loaded from `extensions/` directories. A self-heal pipeline watches for approved incidents and spawns fixer processes.

The architecture is pragmatic and works well for a single-instance deployment. The main structural issue is that `message-loop.ts` accumulated responsibilities (enrichment, trigger checking, session management, agent dispatch, self-heal celebrations, streaming parsing) that should be separate modules.

## Findings

| ID | Category | File:Line | Severity | Effort | Description | Recommendation |
|----|----------|-----------|----------|--------|-------------|----------------|
| F001 | Architectural decay | message-loop.ts:283-979 | Critical | L | `processGroupMessages()` is 697 LOC - handles enrichment, triggers, sessions, dispatch, self-heal, streaming. God function. | Extract into: trigger-checker.ts, session-manager.ts, agent-dispatcher.ts. Keep message-loop as orchestrator. |
| F002 | Test debt | message-loop.ts (whole file) | Critical | L | 1617 LOC, 25 commits in 3 months, zero test coverage. THE HEART of the system is completely untested. | Start with integration tests for `processGroupMessages()` with mocked DB and agent runner. |
| F003 | Security | skill-registry/index.ts:344 | Critical | S | SQL field name via template literal: `` `UPDATE skills SET ${field} = ${field} + 1` ``. If `field` ever comes from user input, SQL injection. Currently safe (hardcoded values) but pattern is dangerous. | Validate `field` against explicit whitelist, or use separate prepared statements per field. |
| F004 | Type debt | ipc.ts:79-103, extensions.ts:18 | Critical | M | IPC messages parsed from JSON files with no schema validation. Extension handlers receive `data: any`. Malformed messages cause silent failures or crashes. | Add Zod schemas for IPC envelope types. Type extension handlers with generics. |
| F005 | Architectural decay | container-runner.ts:395-427 vs sandbox-runner.ts:642-675 | High | M | Identical OUTPUT_START_MARKER/OUTPUT_END_MARKER JSON parsing logic duplicated across both runtimes. Bug fixes must be applied twice. | Extract to `src/runtimes/output-parser.ts`. |
| F006 | Performance | llm-classifier.ts:36-40 | High | S | `execFileSync('security', ...)` blocks event loop up to 5s in async `classifyPromptComplexity()`. | Replace with `execFile()` (async) + promisify. |
| F007 | Performance | rate-limit-probe.ts:54-58 | High | S | Same `execFileSync('security', ...)` pattern in async `getAvailableTier()`. 5s blocking risk. | Replace with async `execFile()`. |
| F008 | Performance | message-loop.ts:927 | High | S | `fs.writeFileSync()` in async `processGroupMessages()` blocks the polling loop during incident file creation. | Replace with `fs.promises.writeFile()`. |
| F009 | Security | whatsapp.ts:91-93 | High | S | `exec()` with string interpolation for osascript notification. Pattern allows shell injection if msg ever contains user input. Currently hardcoded, but fragile. | Use `execFile('osascript', ['-e', script])` with args array. |
| F010 | Security | ipc.ts:79-142 | High | M | JSON files from `data/ipc/` parsed without schema validation. No length limits on text payload. No type checking beyond existence. | Zod schema for each IPC message type with max lengths. |
| F011 | Test debt | model-router.ts (283 LOC) | High | M | Model selection logic with 284 regex patterns, LLM classifier fallback, rate-limit chain - zero tests. | Unit tests for pattern matching, integration test for fallback chain. |
| F012 | Test debt | selfheal.ts (293 LOC) | High | M | Auto-fix pipeline that spawns child processes, manages locks, scans incidents - zero tests. | Mock child_process, test lock management and incident scanning. |
| F013 | Error handling | message-loop.ts:186, :836 | High | S | Empty `catch {}` blocks silently suppress errors from `deleteSession()`. Prevents debugging session cleanup failures. | At minimum log at debug level. |
| F014 | Consistency | message-loop.ts:357,391,447,1122 | High | M | `err instanceof Error ? err.message : String(err)` pattern repeated 4+ times. No utility function. | Create `toErrorMessage(err)` utility. |
| F015 | Type debt | extensions.ts:16-32 | High | M | `IpcHandler` uses `data: any`, `ExtensionStartupDeps.logger: any`, `findChannel: (jid: string) => any`. Defeats TypeScript for extension authors. | Type with proper interfaces and generics. |
| F016 | Type debt | container-runner.ts:405, sandbox-runner.ts:653 | High | M | `ContainerOutput` parsed with bare `JSON.parse()` - no validation. Partial/malformed JSON causes unhandled crash. | Validate with Zod schema after parse. |
| F017 | Architectural decay | router.ts:83 vs outbound-router.ts:15 | Medium | S | `findChannel()` function duplicated - exported in router.ts, locally redeclared in outbound-router.ts. | Delete local copy, import from router.ts. |
| F018 | Consistency | ipc.ts, llm-classifier.ts, db.ts, extension-loader.ts | Medium | S | Multiple JSON parsing patterns: `safeJsonParse()` exists in db.ts but unused elsewhere. Some bare `JSON.parse()`, some try-catch wrapped. | Use `safeJsonParse()` consistently, or Zod `.safeParse()`. |
| F019 | Consistency | credential-proxy.ts, llm-classifier.ts, url-enricher.ts | Medium | M | Three different HTTP strategies: `http` module, `fetch` with AbortController, `fetch` with custom timeout. No shared HTTP client. | Not urgent - different use cases justify different approaches. Consider shared timeout wrapper. |
| F020 | Test debt | rate-limit-probe.ts (163 LOC) | Medium | M | Rate-limit detection with known false-positive bug (documented in code comment) - zero tests. | Test tier fallback chain and cache TTL. |
| F021 | Dependency | package.json:31 | Medium | S | `qrcode` package declared but never imported. Only `qrcode-terminal` is used (whatsapp-auth.ts:12). | Remove `qrcode` from dependencies. |
| F022 | Dependency | package.json:30 | Medium | S | `playwright` declared as dependency but never imported in src/. Browser automation uses MCP tools, not direct playwright. | Move to devDependencies or remove. |
| F023 | Config | 10+ files | Medium | M | 30+ env vars scattered across codebase. `config.ts` documents ~10, but ANTHROPIC_API_KEY, SELFHEAL_AUTO_APPROVE, CONTAINER_IMAGE, LOG_LEVEL, TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_USER_ID etc. are read ad-hoc from process.env. | Central env var registry in config.ts with documentation. |
| F024 | Documentation | CLAUDE.md:47-75 | Medium | M | Claims `extensions/claudeclaw-slack/` and `extensions/claudeclaw-triage/` exist in repo tree. They don't - extensions are per-instance, installed into user directories. Misleading for new developers. | Clarify extensions are installed per-instance, not in repo. |
| F025 | Documentation | CLAUDE.md (missing) | Medium | M | No documentation of IPC authorization model. `ipc.ts:235-301` implements per-group isolation (non-main groups restricted to self-scheduling) but this security boundary is undocumented. | Add IPC security section to CLAUDE.md. |
| F026 | Documentation | types.ts:35-47 vs CLAUDE.md:155-171 | Medium | S | CLAUDE.md agentConfig example omits `disableStreaming` and `sequentialMessages` fields present in types.ts. Users won't discover these flags. | Update CLAUDE.md example. |
| F027 | Resource | selfheal.ts:290 | Medium | S | `setInterval(15s)` created without returning handle. No cleanup in shutdown handler. Fire-and-forget timer pattern. | Return interval handle, clear in shutdown. |
| F028 | Security | rate-limit-probe.ts:42-66 | Medium | M | OAuth token cached 4 minutes without expiry validation. If token expires mid-cache, stale token causes silent auth failures. | Check token expiry before returning cached value. |
| F029 | Error handling | ipc.ts:79,174,206 | Medium | S | Identical JSON parse error handling at 3 locations with different log context shapes. Inconsistent for log aggregation. | Unify into helper function with consistent context shape. |
| F030 | Error handling | message-loop.ts:389-394 | Low | S | Chat history load failure logged as WARN then silently dropped. Agent appears "forgetful" without user notification. | Consider informing agent that history is unavailable. |
| F031 | Error handling | group-queue.ts:212-220 | Low | S | Process kill error caught with `(err as Error).message` - may be undefined if err is not Error instance. | Use `toErrorMessage()` utility (see F014). |
| F032 | Architectural decay | orchestrator/{mount-security,credential-proxy,credential-pool}.ts | Low | M | Security/credential modules in orchestrator/ folder. Arguably belong in `src/security/` or `src/runtimes/security/`. | Low priority - move when next touching these files. |
| F033 | Resource | db.ts:108-159 | Low | S | Six `catch { /* column already exists */ }` blocks in migrations. If migration fails for OTHER reason, error is swallowed. | Check error message contains "duplicate column" before swallowing. |
| F034 | Test debt | extension-loader.ts, ipc.ts, llm-classifier.ts, dreaming.ts, url-enricher.ts | Low | L | Multiple supporting modules with zero test coverage. Lower risk than message-loop but gaps exist. | Prioritize after F002, F011, F012. |
| F035 | Documentation | webhook server.ts | Low | S | HMAC-SHA256 timing-safe verification exists but README doesn't mention it explicitly. | Add note to README. |

## Top 5: if you fix nothing else, fix these

### 1. F002 - Test message-loop.ts (Critical, L)

The entire system depends on one 1617-LOC file with zero tests. Every feature commit touches it (25 times in 3 months). Any refactoring is currently blind.

**Approach:** Create `message-loop.test.ts` with:
- Mock `getDb()` to return in-memory SQLite
- Mock agent runners to return canned ContainerOutput
- Test: message deduplication, trigger checking, session lifecycle, error recovery
- Start with 5 happy-path integration tests, expand from there

### 2. F001 - Decompose processGroupMessages() (Critical, L)

697-line function doing 6+ distinct jobs. Extract:
```
src/orchestrator/
  trigger-checker.ts    - shouldTriggerAgent() logic (~80 LOC)
  session-manager.ts    - createSession/deleteSession/getOrCreateSession (~100 LOC)
  message-enricher.ts   - URL enrichment, chat history loading (~80 LOC)
  agent-dispatcher.ts   - runAgent() + streaming output handling (~200 LOC)
```
Keep `processGroupMessages()` as thin orchestrator calling these modules.

### 3. F003 + F009 - Fix security patterns (Critical+High, S)

**F003** (5 min fix):
```typescript
// skill-registry/index.ts:344
const VALID_FIELDS = ['success_count', 'failure_count'] as const;
if (!VALID_FIELDS.includes(field)) throw new Error(`Invalid field: ${field}`);
```

**F009** (5 min fix):
```typescript
// whatsapp.ts:91-93
execFile('osascript', ['-e', `display notification "${msg}" with title "ClaudeClaw"`]);
```

### 4. F006 + F007 + F008 - Async I/O on hot paths (High, S)

Three sync calls blocking the event loop in async functions:
```typescript
// llm-classifier.ts:36 and rate-limit-probe.ts:54
// Replace execFileSync with:
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync('security', [...args], { timeout: 5000 });

// message-loop.ts:927
// Replace writeFileSync with:
await fs.promises.writeFile(file, body);
```

### 5. F004 + F010 - Schema validation at IPC boundary (Critical, M)

Add Zod schemas for the 3 IPC message types:
```typescript
// src/orchestrator/ipc-schema.ts
import { z } from 'zod';
export const IpcMessageSchema = z.object({
  type: z.literal('message'),
  chatJid: z.string().max(256),
  text: z.string().max(100_000),
  sender: z.string().optional(),
  timestamp: z.number().optional(),
});
export const IpcTaskSchema = z.object({
  type: z.enum(['task', 'scheduled']),
  taskId: z.string().optional(),
  prompt: z.string().max(100_000),
});
```

## Quick wins

- [ ] F017: Delete duplicate `findChannel()` in outbound-router.ts, import from router.ts (5 min)
- [ ] F021: Remove unused `qrcode` from package.json (1 min)
- [ ] F022: Move `playwright` to devDependencies (1 min)
- [ ] F013: Add `logger.debug()` to empty catch blocks in message-loop.ts:186,:836 (5 min)
- [ ] F008: Replace `writeFileSync` with `await writeFile` in message-loop.ts:927 (2 min)
- [ ] F027: Return setInterval handle from selfheal.ts:290, clear on shutdown (5 min)
- [ ] F026: Add `disableStreaming`, `sequentialMessages` to CLAUDE.md agentConfig example (5 min)
- [ ] F033: Check migration error messages before swallowing in db.ts (10 min)

## Things that look bad but are actually fine

- **Single SQLite connection (db.ts:187)** - Looks like it should be a connection pool, but this is a single-process orchestrator. WAL mode + busy_timeout=5s handles concurrent reads/writes correctly. A pool would add complexity for zero benefit.

- **2-second polling interval (message-loop.ts:1318)** - Looks aggressive, but this is an interactive messaging bot where response latency matters. The poll is a single indexed SELECT, ~0.1ms. Fine.

- **Subquery with double-sort in getNewMessages() (db.ts:433-447)** - Inner query sorts DESC + LIMIT, outer sorts ASC. Looks redundant but correctly implements "get N most recent messages in chronological order." SQLite optimizes this well with the compound index.

- **Multiple HTTP client approaches (F019)** - credential-proxy uses `http` module (needs raw stream piping), llm-classifier uses `fetch` (simple JSON API), url-enricher uses `fetch` (web scraping). Different tools for different jobs. A unified HTTP client would be over-abstraction.

- **Heavy mocking in test files** - `ipc-auth.test.ts` (679 LOC) mocks fs/crypto extensively. Looks like it's testing mocks not code, but the IPC auth system genuinely needs filesystem isolation in tests. The mocking is appropriate here.

- **rate-limit-probe effectively disabled (always returns available)** - Looks broken, but this was an intentional fix (2026-05-05 comment). The probe was generating false positives and blocking agent responses for 12+ hours. Disabling it was the right call; real rate limits are handled by the model-router fallback chain.

- **`dreaming.ts` (423 LOC) with no tests** - System task seeding is a startup-only operation that creates cron entries. Low runtime risk. Tests would be nice but this is correctly low priority.

## Open questions for the maintainer

1. **Is `playwright` in dependencies intentional?** It's declared but never imported. Browser automation goes through MCP `browser-daemon.sh`. Was this for a planned feature, or leftover from before MCP browser?

2. **Should extensions/ be documented differently?** CLAUDE.md shows them in the repo tree but they're per-instance. Is the intent to ship reference extensions in the repo eventually?

3. **What's the plan for the disabled rate-limit-probe?** Currently always returns "available." Is this permanent, or waiting for a better detection approach?

4. **credential-pool.ts vs credential-proxy.ts** - Are both actively used? They seem to serve overlapping purposes (credential management for sandbox agents).

5. **Is `src/orchestrator/container-runner.ts` a dead file?** There's also `src/runtimes/container-runner.ts` (751 LOC). The git churn shows edits to both `src/orchestrator/container-runner.ts` (6 times) and `src/runtimes/container-runner.ts`. Are these the same file after a move, or genuinely separate?

6. **`SELFHEAL_AUTO_APPROVE` env var** - Is auto-approval intended for production, or just dev convenience? If production, the "human must approve" safety boundary documented in CLAUDE.md is bypassable.
