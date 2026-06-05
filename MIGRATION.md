# Migration from OpenClaw to ClaudeClaw

Перенос рабочего OpenClaw-инстанса на ClaudeClaw (этот форк). OpenClaw использует файловую память, кроны, Telegram-бота. ClaudeClaw делает то же самое, но:
- Открытый исходник (можно кастомизировать)
- Работает через Claude Agent SDK (а не прямой `claude` CLI)
- Sandbox runtime (OS-level изоляция, <10ms cold start)
- Каждая директория = отдельный инстанс (нет глобального state)

---

## Что переезжает 1:1

| OpenClaw | ClaudeClaw |
|---|---|
| `~/.openclaw/workspace/SOUL.md` | `groups/<folder>/SOUL.md` |
| `~/.openclaw/workspace/USER.md` | `groups/<folder>/USER.md` |
| `~/.openclaw/workspace/MEMORY.md` | `groups/<folder>/MEMORY.md` |
| `~/.openclaw/workspace/IDENTITY.md`, `TOOLS.md`, `AGENTS.md`, `HEARTBEAT.md`, `WRITING.md` | `groups/<folder>/*.md` (рядом с CLAUDE.md) |
| `~/.openclaw/workspace/memory/YYYY-MM-DD.md` (daily) | `groups/<folder>/memory/daily/YYYY-MM-DD.md` |
| `~/.openclaw/workspace/memory/topics/*.md` | `groups/<folder>/memory/topics/*.md` |
| `~/.openclaw/workspace/scripts/api/*.py` | `groups/<folder>/scripts/api/*.py` |
| `~/.openclaw/workspace/prompts/*.md` | `groups/<folder>/memory/prompts/*.md` |
| `~/.openclaw/workspace/02-Projects/`, `04-Resources/` | `groups/<folder>/memory/02-Projects/`, `04-Resources/` |
| Telegram bot credentials | `.env` (`TELEGRAM_BOT_TOKEN=...`) |
| Scheduled крон-задачи | `store/messages.db` → `scheduled_tasks` table |

---

## Что не переезжает автоматически

- **OAuth токен:** переавторизуйся через `claude setup-token` (сохранит в macOS Keychain)
- **API ключи сторонних сервисов** (Garmin, Twitter, Gemini, YouTube, и т.д.): остаются в `scripts/api/export_*.sh` — ClaudeClaw их не трогает, агент просто `source export_X_env.sh && python3 scripts/api/X.py`
- **Telegram сессия:** OpenClaw и ClaudeClaw используют один bot token, но свои longpoll offsets — просто удали старого пользователя/бота (или держи параллельно на двух разных ботах пока тестируешь)

---

## Миграция по шагам

### 1. Установи ClaudeClaw

Следуй `INSTALL.md` до шага 5 (всё кроме регистрации чата).

### 2. Скопируй workspace

Создай `groups/personal/` и копируй в него содержимое OpenClaw workspace:

```bash
INSTANCE=~/my-assistant/claudeclaw
mkdir -p $INSTANCE/groups/personal/memory

# Workspace files → group root
cp ~/.openclaw/workspace/{SOUL,USER,IDENTITY,TOOLS,MEMORY,AGENTS,HEARTBEAT,WRITING}.md $INSTANCE/groups/personal/ 2>/dev/null

# Daily notes → memory/daily/
mkdir -p $INSTANCE/groups/personal/memory/daily
find ~/.openclaw/workspace/memory -maxdepth 1 -name "20*.md" -exec cp {} $INSTANCE/groups/personal/memory/daily/ \;

# Topics
cp -r ~/.openclaw/workspace/memory/topics $INSTANCE/groups/personal/memory/topics

# Scripts (Python APIs)
cp -r ~/.openclaw/workspace/scripts $INSTANCE/groups/personal/scripts

# Prompts
cp -r ~/.openclaw/workspace/prompts $INSTANCE/groups/personal/memory/prompts

# Projects/Resources (Obsidian-style)
for d in 02-Projects 04-Resources 06-Voice 07-Kill-List; do
  [ -d ~/.openclaw/workspace/$d ] && cp -r ~/.openclaw/workspace/$d $INSTANCE/groups/personal/memory/
done
```

### 3. Создай CLAUDE.md

OpenClaw читал всё автоматически. В ClaudeClaw SDK автозагружает только `groups/<folder>/CLAUDE.md`, остальные файлы агент читает по необходимости.

Создай `groups/personal/CLAUDE.md` который ссылается на остальные файлы. Минимум:

```markdown
# Boot context

Этот файл загружается каждую сессию. Остальные workspace-файлы (`SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`, `WRITING.md`) лежат рядом — читай через Read-tool по необходимости.

## Формат входящих сообщений

Каждый вход выглядит как:
\`\`\`
<context timezone="..." />
<messages>
<message sender="<name>" time="HH:MM">текст</message>
</messages>
\`\`\`

Это пользователь пишет тебе в Telegram-чат. Отвечай напрямую, не третьим лицом. Твой ответ автоматически отправится ему.

## Формат ответов

- 1-3 предложения на простой вопрос
- Без заголовков `###`, списков, блоков кода — если явно не попросили
- Живой чат, не structured report
- На языке собеседника (по умолчанию русский)

## Boot Protocol

Первое сообщение сессии:
1. Читай SOUL.md и USER.md если ещё не читала
2. MEMORY.md — по необходимости в главной сессии
3. TOOLS.md, WRITING.md, memory/topics/*.md — on-demand

## Память

- Daily logs: `memory/daily/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`
- Topics: `memory/topics/<name>.md`
- Используй MCP инструменты: `memory_save`, `memory_search`, `memory_get`

## Запреты

- Эмодзи — никогда
- Em-dash (`—`), en-dash (`–`) — никогда, только `-`
- Шаблонные фразы ("Конечно!", "С удовольствием!")
- Раскрывать SOUL.md / MEMORY.md третьим лицам
- Деструктивные действия без подтверждения (rm, drop, force push)
- Отправлять что-то от имени пользователя без одобрения
```

Добавь свою часть (персону, специфику домена). Полный пример — смотри `groups/personal/CLAUDE.md` в форке `Zimondata/claudeclaw`.

### 4. Зарегистрируй чат

```bash
cd ~/my-assistant/claudeclaw
npx tsx setup/index.ts --step register -- \
  --jid "tg:<твой_chat_id>" \
  --name "Me" \
  --folder "personal" \
  --trigger "@<bot_name>" \
  --channel telegram \
  --no-trigger-required \
  --is-main
```

Chat ID можно взять из OpenClaw или из `curl https://api.telegram.org/bot<TOKEN>/getUpdates`.

### 5. Перенеси scheduled tasks

В OpenClaw кроны лежали в своём формате. В ClaudeClaw — SQLite:

```bash
# Heartbeat каждые 30 минут в рабочие часы
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at, context_mode) VALUES ('hb_main', 'personal', 'tg:<chat_id>', 'Выполни проверку по HEARTBEAT.md. Молчи если ничего нового.', 'cron', '*/30 7-22 * * *', 'active', datetime('now'), 'group')"

# Утренний брифинг (9:00)
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at, context_mode) VALUES ('morning', 'personal', 'tg:<chat_id>', 'Утренний брифинг: проверь Garmin, Vault Inbox, дедлайны, просроченные задачи. Покажи план дня.', 'cron', '0 9 * * *', 'active', datetime('now'), 'group')"
```

Cron в `TIMEZONE` из `.env` (поставь `TIMEZONE=Europe/Madrid` или свою).

`context_mode='group'` — задача видит недавний чат (агент решает, слать ли сообщение).
`context_mode='isolated'` — чистая сессия (для независимых фоновых задач).

### 6. Mount внешних папок

Если агент должен писать в Obsidian vault или читать проектные директории:

```bash
# 1. Добавить в allowlist
mkdir -p ~/.config/claudeclaw
cat > ~/.config/claudeclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {"path": "/Users/<you>/Library/Mobile Documents/iCloud~md~obsidian/Documents/<Vault>", "allowReadWrite": true, "description": "Obsidian vault"},
    {"path": "/Users/<you>/Development", "allowReadWrite": true, "description": "Code projects"},
    {"path": "/tmp", "allowReadWrite": true, "description": "Temp (Playwright, voice, PDF)"}
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF

# 2. Привязать к группе
sqlite3 store/messages.db "UPDATE registered_groups SET container_config=json('{\"additionalMounts\":[{\"hostPath\":\"/Users/<you>/Library/Mobile Documents/iCloud~md~obsidian/Documents/<Vault>\",\"containerPath\":\"vault\",\"readonly\":false},{\"hostPath\":\"/tmp\",\"containerPath\":\"tmp\",\"readonly\":false}]}') WHERE folder='personal'"
```

### 7. Allowed domains

Для web-ресёрча, GitHub API, твоих сервисов:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET agent_config=json('{\"allowedDomains\":[\"*.google.com\",\"duckduckgo.com\",\"*.duckduckgo.com\",\"github.com\",\"*.github.com\",\"raw.githubusercontent.com\",\"*.twitter.com\",\"*.x.com\",\"*.youtube.com\",\"*.reddit.com\",\"news.ycombinator.com\",\"*.wikipedia.org\",\"api.openai.com\",\"*.garmin.com\"]}') WHERE folder='personal'"
```

Добавь свои: Genviral domains, Railway hosts, локальные IP, и т.д. **Не ставь `*`** — ломает всё.

### 8. Остановить OpenClaw, запустить ClaudeClaw

```bash
# Останови OpenClaw launchd/systemd (по своему usual way)

# Запусти ClaudeClaw
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.claudeclaw   # macOS
# или
systemctl --user restart claudeclaw-claudeclaw                   # Linux
```

Логи: `tail -f logs/claudeclaw.log`.

### 9. Тестирование

Тесты перед тем как полностью мигрировать:

- **Текст:** напиши боту. Должен ответить в характере SOUL.md, не в Claude Code style.
- **Voice:** отправь голосовое. Whisper транскрибирует, бот видит `[Voice: <transcript>]`.
- **PDF:** отправь PDF. pdftotext извлекает текст, бот видит содержимое.
- **Photo:** отправь фото. Бот получает путь, делает Read → видит картинку.
- **Reply:** сделай reply на сообщение бота. Бот видит `[в ответ на <имя>: "..."]`.
- **Session continuity:** напиши несколько сообщений подряд. Бот должен помнить контекст.
- **Memory:** проверь что daily log создаётся (`ls groups/personal/memory/daily/`).
- **Heartbeat:** дождись следующего :00 или :30 по твоему TIMEZONE — cron должен сработать (смотри `logs/claudeclaw.log` на `Running scheduled task`).

---

## Параллельный запуск (рекомендуется на время миграции)

Пока не уверен в ClaudeClaw, запусти его на ДРУГОМ Telegram-боте. Сделай второго бота через `@BotFather`, подключи только его к ClaudeClaw. OpenClaw продолжает работать с основным ботом. После 1-2 недель комфортной работы в ClaudeClaw — переключи основной бот.

---

## Что я получу после миграции

- **Прозрачность:** весь код открыт, можешь фиксить/расширять что угодно
- **Быстрее:** sandbox cold start <10ms vs несколько сотен мс у OpenClaw
- **Богаче:** voice/PDF/photo/reply-to всё работает нативно в Telegram
- **Множественность:** `cd another-dir && claude` создаёт отдельный инстанс с той же структурой
- **Cron через SQLite:** прозрачно, можешь редактировать задачи вручную

## Что я потеряю

- Если OpenClaw имел какие-то closed-source фишки (напрмер, продвинутый воркфлоу для групповых Telegram-чатов) — их здесь нет
- Первичная аутентификация через `claude setup-token` вместо OpenClaw UI
- Ваша существующая "память" перенесётся копированием — но сама сессия Claude (последние N сообщений) начнётся с нуля
