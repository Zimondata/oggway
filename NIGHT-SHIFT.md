# Ночная смена 2026-05-03 (~23:07 Madrid / 14:07 PDT)

## Что починено за смену

### 1. Smart heartbeat — двух-state логика
**Файл:** `agent/runner/src/index.ts`

Был баг: heartbeat в режиме "no SDK events for 90s" → suppress → watchdog SIGKILL даже когда агент в **нормальном idle-wait после result** (ждёт следующее IPC сообщение в streaming-mode). Бот выглядел "лёгшим" хотя он просто корректно ждал.

Добавил флаг `awaitingResult`:
- `true` после `stream.push(prompt)` (новый turn начался)
- `false` после `result` event (turn завершён)
- Heartbeat suppress срабатывает ТОЛЬКО когда `awaitingResult && silent>90s` = реально стоит между push и result
- Idle-wait после result → heartbeat нормально emit'ится → орчестратор `_close` sentinel закрывает gracefully

### 2. Quiet-period debounce — пакетная обработка burst'ов
**Файл:** `src/orchestrator/message-loop.ts` + `src/orchestrator/types.ts`

5-10 сообщений подряд (брейн-дамп голосовыми) ранее обрабатывались по-одному или с пропусками. Теперь:
- На каждом poll-tick проверяется `ageMs = now - newest_message_timestamp`
- Если `ageMs < debounceMs` → `continue` (skip iteration, оставить в DB)
- Когда юзер замолкает на debounce окно → батчим всё в ОДИН `<messages>` блок

**Defaults:**
- 2000ms текст
- 4000ms если среди ожидающих voice/photo/audio/document (Whisper-латентность)

**Override:** `agentConfig.debounceMs`

Заимствовано у Hermes Agent (`HERMES_TELEGRAM_TEXT_BATCH_DELAY_SECONDS=0.6`) и OpenClaw (`debounceMs: 2000`).

### 3. Crash-recovery cursor
**Файл:** `src/orchestrator/message-loop.ts`

Раньше при kill сервиса посреди обработки cursor оставался advanced → сообщения пропускались. Теперь:
- Перед run агента: пишется маркер `in_progress_cursors[<jid>] = previousCursor` в DB
- После успеха: маркер чистится
- На старте сервиса: если маркер есть → откатываем cursor + дропаем session_id (чтобы избежать "уже ответила" галлюцинаций)

### 4. Session drop on error
Любой error path теперь дропает session_id из DB. SDK session JSONL содержащий user input без assistant reply вызывал hallucinations "уже ответила выше" на resume. Long-term context остаётся в `memory/topics/*.md` и `MEMORY.md`.

### 5. Per-run watchdog
**Файл:** `src/orchestrator/group-queue.ts`

- 8-минутный таймер inactivity (resetable через `noteActivity`)
- При срабатывании: `process.kill(-pid, SIGKILL)` — убивает весь process tree (npm wrapper + srt + runner + MCP children) благодаря `detached: true` в spawn
- Test-friendly guard: `if (typeof proc.once === 'function')`

### 6. User-facing fail message
Когда есть consecutive errors после уже-отправленного output — юзер получает "Что-то поломалось после моего предыдущего ответа. Если ты писал что-то ещё — переотправь, я пропустила." Не молчание.

### 7. Forward visibility в Telegram
**Файл:** `src/channels/telegram.ts`

- Diagnostic middleware логирует ВСЕ типы updates (text, photo, voice, story, video_note, animation, poll, dice, venue, contact)
- `forwardPrefix()` вешает `[переслано из канала X]` или `[переслано от Имя]` на forwarded messages
- Catch-all handler ловит unhandled message types (story, video_note и т.д.) — больше silent drops

## Текущее состояние

- Service PID 80647 (`claudeclaw/dist/service.js`)
- Monitor running: `/tmp/cc-monitor.sh` PID 80045 → лог в `/tmp/cc-monitor.log`
- Sandbox runtime active, обрабатывает recovery messages из последнего кикстарта
- Все 6 фиксов в codebase, build чистый
- Tests: 355/357 (2 pre-existing failures про markdown fallback в sendMessage chunking, не от моих фиксов)

## Файлы изменены сегодня

```
src/orchestrator/message-loop.ts   — debounce, crash-recovery cursor, session drop, fail message
src/orchestrator/group-queue.ts    — watchdog kill -pid, test guard
src/orchestrator/types.ts          — debounceMs, sequentialMessages, disableStreaming flags
src/orchestrator/llm-classifier.ts — haiku-based model classifier (NEW)
src/orchestrator/model-router.ts   — default→opus, expanded RU patterns (NEW)
src/orchestrator/db.ts             — deleteSession()
src/runtimes/sandbox-runner.ts     — silent-death detection, detached:true, status:error fix
src/service.ts                     — PID lock for service singleton
src/channels/telegram.ts           — forward visibility, diagnostic middleware, catch-all
agent/runner/src/index.ts          — smart heartbeat with awaitingResult flag
groups/personal/CLAUDE.md          — fetch fallback, sequential queue, vault redirect rules
groups/personal/memory/topics/coverage-7d.md — anti-repeat 7-day log (NEW)
```

## Что НЕ починил (на завтра)

- 2 теста markdown-fallback в `telegram.test.ts:739/762` — нужно поправить мок api.sendMessage чтобы возвращал нормальный shape
- Heartbeat tests для нового awaitingResult flag — нет тестов в runner side
- Excalidraw диаграмма — улучшить если нужно (3 итерации сделано)

## Команды для утра

```bash
# Состояние сервиса
pgrep -fl service.js
tail -30 /Users/pine/my-assistant/claudeclaw/claudeclaw/logs/claudeclaw.log

# Что писал ночной монитор
tail -50 /tmp/cc-monitor.log

# Остановить монитор когда не нужен
pkill -f cc-monitor.sh

# Проверить что нет zombie sandbox
pgrep -af "agent-runner|sandbox-runtime"
```

## Архитектурные паттерны (заимствовано)

См. `02-Projects/ClaudeClaw/message-batching.md` в Obsidian — конкретные источники (Hermes Agent gateway/platforms/telegram.py, OpenClaw docs.openclaw.ai/concepts/messages, n8n templates 2917 + 13070, python-telegram-bot issue #3689).
