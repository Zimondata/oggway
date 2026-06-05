# Install Guide

Установка кастомизированной ветки ClaudeClaw (форк `Zimondata/claudeclaw`) с поддержкой Telegram media (voice/PDF/photo), session continuity на sandbox-runtime, авто-подхватом macOS Keychain credentials и портом `scripts/` из OpenClaw.

Всё личное (чаты, персона, память, креденшлы) лежит в gitignored директориях — репозиторий содержит только код.

---

## Что нужно до старта

**Обязательно:**
- macOS 13+ или Linux (WSL2 на Windows) с 8+ GB RAM
- Node.js 20+
- Git
- Claude Pro/Max подписка (OAuth) или Anthropic API key
- Telegram-аккаунт + возможность создать бота через `@BotFather`

**Для полной функциональности (опционально, но рекомендуется):**
- `ripgrep` (`brew install ripgrep` / `apt install ripgrep`) - нужен sandbox runtime
- `ffmpeg` (`brew install ffmpeg` / `apt install ffmpeg`) - для voice transcription
- `poppler` (`brew install poppler` / `apt install poppler-utils`) - для PDF extraction
- `openai-whisper` (`pip install openai-whisper`) - локальная voice transcription (бесплатно, без OpenAI API)

---

## Быстрая установка (5 минут)

### 1. Клонируй форк

```bash
git clone https://github.com/Zimondata/claudeclaw.git ~/my-assistant/claudeclaw
cd ~/my-assistant/claudeclaw
```

Директория, в которой ты находишься при запуске, ИСТЬ инстанс ClaudeClaw. Несколько директорий = несколько инстансов (personal/work/etc). Все state (`.env`, `store/`, `groups/`, `logs/`) живёт в cwd.

### 2. Установи зависимости

```bash
npm install --legacy-peer-deps
cd agent/runner && npx tsc && cd ..
npm run build
```

`--legacy-peer-deps` нужен потому что `@whiskeysockets/baileys` (WhatsApp) объявляет `sharp` как optional peer, а sharp не собирается на некоторых Node версиях.

### 3. Установи системные инструменты

macOS:
```bash
brew install ripgrep ffmpeg poppler
pip3 install openai-whisper   # или pip install --user
```

Linux:
```bash
sudo apt install ripgrep ffmpeg poppler-utils
pip3 install --user openai-whisper
```

### 4. Аутентификация

**Вариант A — Claude Pro/Max (через keychain, рекомендуется):**

```bash
claude setup-token
```

Следуй инструкции в браузере. Токен сохранится в macOS Keychain (`Claude Code-credentials`) или в `~/.claude/.credentials.json` на Linux. ClaudeClaw автоматически подхватит его.

**Вариант B — API key:**

Создай `.env` в корне проекта:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### 5. Настрой Telegram

Создай бота через `@BotFather` в Telegram (`/newbot`, дай имя и username), скопируй token.

Добавь в `.env`:
```
RUNTIME=sandbox
ASSISTANT_NAME=Andy
TELEGRAM_BOT_TOKEN=<твой_токен>
TIMEZONE=Europe/Madrid
TZ=Europe/Madrid
```

`ASSISTANT_NAME` определяет trigger-pattern (`@Andy` в группах; в direct message не нужен).

### 6. Запусти через setup

```bash
npx tsx setup/index.ts --step environment
```

Проверит установку. Потом:

```bash
# Настроить mount allowlist (пустой = только group dir)
npx tsx setup/index.ts --step mounts -- --empty

# Установить launchd (macOS) или systemd (Linux) сервис
npx tsx setup/index.ts --step service

# Проверить результат
npx tsx setup/index.ts --step verify
```

### 7. Зарегистрируй свой чат с ботом

Напиши боту в Telegram любое сообщение (чтобы Telegram знал о чате). Затем узнай свой chat ID:

```bash
curl -s "https://api.telegram.org/bot$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)/getUpdates" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["result"]; [print(u["message"]["chat"]) for u in d if "message" in u][:1]'
```

Получишь что-то вроде `{"id": 123456789, "type": "private", ...}`. Регистрируй:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "tg:123456789" \
  --name "Me" \
  --folder "personal" \
  --trigger "@Andy" \
  --channel telegram \
  --no-trigger-required \
  --is-main
```

### 8. Запусти

```bash
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.claudeclaw   # macOS
# или
systemctl --user restart claudeclaw-claudeclaw                   # Linux
```

Проверь логи: `tail -f logs/claudeclaw.log`. Напиши боту — должен ответить.

---

## Кастомизация персоны

Агент читает `groups/<folder>/CLAUDE.md` автоматически при каждом запуске SDK (это boot context). Остальные файлы (`SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `AGENTS.md`, `HEARTBEAT.md`) агент читает по необходимости через `Read` tool.

Минимальный `CLAUDE.md`:

```markdown
# Мой ассистент

Ты — личный ассистент в Telegram через бот @<your_bot>. Отвечаешь кратко, по-человечески, на языке собеседника. Memory tools: `memory_save`, `memory_search`, `memory_get`.

## Формат ответов
- 1-3 предложения на простой вопрос
- Без заголовков и списков если юзер явно не просил
- Без "Объясняю:" / "Итог:" / "Подведу итог:"
```

Более богатый setup — смотри `groups/personal/` в форке (там OpenClaw-style воркспейс).

---

## Расширенные возможности

### Scheduled heartbeat

Агент может проактивно проверять задачи по cron:

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at, context_mode) VALUES ('hb_1', 'personal', 'tg:123456789', 'Выполни проверку по HEARTBEAT.md. Молчи если ничего нового.', 'cron', '*/30 7-22 * * *', 'active', datetime('now'), 'group')"
```

Cron `*/30 7-22 * * *` запускает каждые 30 минут с 07:00 до 22:30 (в `TIMEZONE` из `.env`).

### Доступ к Obsidian vault / внешним папкам

Добавь путь в `~/.config/claudeclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {"path": "/path/to/Obsidian/vault", "allowReadWrite": true, "description": "Vault"}
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

Затем добавь mount в группу:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config=json('{\"additionalMounts\":[{\"hostPath\":\"/path/to/vault\",\"containerPath\":\"vault\",\"readonly\":false}]}') WHERE folder='personal'"
```

### Network access для агента (web search, API calls)

В sandbox mode весь outbound-трафик заблокирован кроме `api.anthropic.com`. Чтобы разрешить больше:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET agent_config=json('{\"allowedDomains\":[\"*.google.com\",\"github.com\",\"*.github.com\",\"api.openai.com\"]}') WHERE folder='personal'"
```

**Важно:** не ставь голую звёздочку `*` в `allowedDomains` — srt перестаёт пропускать даже `api.anthropic.com` и всё ложится с 401.

### Playwright для браузерной автоматизации

```bash
npm install playwright
npx playwright install chromium
```

Затем добавь в mount-allowlist и group additionalMounts:

```json
{"path": "/Users/<you>/Library/Caches/ms-playwright", "allowReadWrite": false}
{"path": "/tmp", "allowReadWrite": true}
```

---

## Self-heal (автоматический фикс багов)

Бот обнаруживает баг в ClaudeClaw-коде (не в твоём коде, а в нашем) → пишет incident в `groups/<folder>/incidents/<id>.md` → (опционально) ждёт твоего approve в Telegram → file watcher запускает fixer-Claude как subprocess с `--dangerously-skip-permissions` → тот правит src/, тестирует, коммитит, рестартит сервис, и докладывает в TG.

**Два режима:**

1. **С ручным подтверждением** (default) — бот пишет "обнаружил баг X, скажи 'fix it' для одобрения". Ты одобряешь в TG. Безопаснее.

2. **Auto-approve** — добавь в `.env`:
   ```
   SELFHEAL_AUTO_APPROVE=1
   ```
   Теперь любой incident стартует fixer'а автоматически через ~15 сек после `report_incident`. Полезно если доверяешь боту и не хочешь лишних кликов, но риск — false-positive incidents могут инициировать ненужные правки. Fixer всегда делает `git commit` (не push), так что откат: `git revert HEAD && launchctl kickstart -k ...`.

Для обоих режимов fixer:
- НЕ пушит в remote (ты делаешь вручную когда глянешь diff)
- Держит lock-файл — параллельные фиксы невозможны
- 20-min timeout на subprocess
- Записывает `.FIXED` или `.FAILED` marker в incidents/ + шлёт TG summary

## Remote control из Telegram

Админ-команды идут **в обход агента** — работают даже если агент мёртв (auth issues, sandbox hang, краш). Обрабатывает orchestrator напрямую.

Включение: в `.env` добавь свой Telegram user ID:

```
ADMIN_TELEGRAM_USER_ID=<твой_telegram_id>
```

(в private chat user_id = chat_id; если не знаешь — напиши `/chatid` боту или глянь `curl .../getUpdates`)

Доступные команды:

- `/status` — сервис, БД, git, сессии, uptime
- `/logs [N]` — последние N строк лога (default 30, max 500)
- `/restart` — kickstart сервиса
- `/revert` — git revert HEAD + rebuild + restart (откатить последний fixer)
- `/push` — git push origin main
- `/clear-session` — удалить все сессии (свежая память при следующем turn)
- `/shell <cmd>` — произвольная bash-команда (осторожно, логируется)
- `/help` — список

Non-admin sender'ы молча игнорируются (лог: `Non-admin attempted admin command`).

**Tailscale для полного SSH-доступа:** если хочешь не только команды, а полноценный remote — поставь [Tailscale](https://tailscale.com/) на Mac mini и на твой ноут/телефон (бесплатный tier). Получишь SSH по `tailscale ssh` из любой точки мира без проброса портов.

## Что уже в этом форке (vs upstream sbusso/claudeclaw)

- **Telegram media:** voice transcription (whisper), PDF extraction (pdftotext), photo vision через Read tool
- **Telegram reply-to-message:** при reply бот видит оригинал в `[в ответ на X: "..."]`
- **Session continuity fix:** `~/.claude/projects/` замаунчен writable в sandbox → сессии персистятся
- **Stale session retry:** при `No conversation found` агент автоматически стартует свежую сессию
- **IPC race condition fix:** `stream.push` в try/catch при закрывающемся query
- **macOS Keychain fallback:** если нет токена в `.env`, читается из `security find-generic-password`
- **Memory MCP paths fix:** `memory_save` daily → `memory/daily/YYYY-MM-DD.md`, longterm → `MEMORY.md` (было в корне / в `CLAUDE.md`)
- **Message trimming:** сообщения >20KB обрезаются с маркером, защита от переполнения контекста
- **Broader sandbox read:** убран `denyWrite` на readonly-mount (не ломает nested allowWrite)

---

## Troubleshooting

**Бот не отвечает, в логах `API Error: 401`:**
- `claude setup-token` (перезаписать keychain-токен)
- Или добавить `ANTHROPIC_API_KEY=...` в `.env`

**Бот завис:**
```bash
pkill -f "sandbox-personal"
sqlite3 store/messages.db "DELETE FROM sessions"
launchctl kickstart -k gui/$(id -u)/com.claudeclaw.claudeclaw
```

**`npm install` падает на sharp:**
- Используй `--legacy-peer-deps` — sharp optional peer, skip его

**Бот отвечает в "Claude Code style" с заголовками и списками:**
- Пропиши в `CLAUDE.md` секцию про формат (смотри `groups/personal/CLAUDE.md` в форке как пример)

**Voice/PDF/photo не распознаются:**
- Проверь что `whisper`, `ffmpeg`, `poppler` установлены (`which whisper ffmpeg pdftotext`)
- `/tmp` должен быть в mount allowlist и group additionalMounts

---

## Структура инстанса

```
my-assistant/claudeclaw/
├── .env                    # токены, креденшлы, ASSISTANT_NAME
├── store/messages.db       # SQLite: чаты, сообщения, сессии, scheduled tasks
├── data/                   # IPC, sandbox settings, session .claude/
├── logs/                   # claudeclaw.log, claudeclaw.error.log
└── groups/
    └── personal/           # твой основной чат
        ├── CLAUDE.md       # boot context (автозагрузка)
        ├── SOUL.md         # персона
        ├── USER.md         # про тебя
        ├── MEMORY.md       # long-term память
        ├── AGENTS.md, HEARTBEAT.md, TOOLS.md, WRITING.md, IDENTITY.md
        ├── scripts/        # Python/Bash скрипты доступные агенту
        └── memory/
            ├── daily/      # ежедневные логи YYYY-MM-DD.md
            ├── topics/     # специализированные заметки
            └── prompts/    # промпты для кронов
```
