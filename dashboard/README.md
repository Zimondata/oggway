# ClaudeClaw Dashboard

Web dashboard for monitoring agent activity, cost tracking, and system health.

## Quick Start

```bash
cd dashboard
npm install
npm run dev
```

In a separate terminal, start the API server:

```bash
npx tsx src/server.ts
```

Then open http://localhost:3200

## What it shows

- **Stats cards** - total runs, cost, tokens, avg duration, active groups, uptime
- **Activity chart** - daily agent runs over 7/30 days
- **Group breakdown** - cost and activity per registered group
- **Recent runs** - last 20 agent executions with full details

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | auto-detected | Path to ClaudeClaw's `store/messages.db` |
| `DASHBOARD_PORT` | 3201 | API server port |

The dashboard reads the SQLite database in read-only mode. It does not modify any data.

## Tech Stack

- **Frontend:** React 19, Vite, Tailwind CSS v4, Recharts
- **Backend:** Express 5, better-sqlite3 (read-only)
- **No external services** - reads directly from ClaudeClaw's SQLite store
