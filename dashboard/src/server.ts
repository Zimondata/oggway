import express from 'express';
import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { setupChatApi } from './chat-api.js';

const PORT = Number(process.env.DASHBOARD_PORT) || 3201;

// ---------------------------------------------------------------------------
// Database discovery
// ---------------------------------------------------------------------------

function findDb(): string {
  const candidates = [
    resolve(process.cwd(), 'store/messages.db'),
    resolve(process.cwd(), '../store/messages.db'),
    resolve(dirname(import.meta.url.replace('file://', '')), '../../store/messages.db'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Cannot find store/messages.db. Run from ClaudeClaw root or set DB_PATH env var.\nSearched: ${candidates.join(', ')}`
  );
}

const dbPath = process.env.DB_PATH || findDb();
const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = WAL');

/**
 * Project root = parent of store/messages.db.
 * Dashboard server is launched with WorkingDirectory=dashboard/, so cwd-relative
 * lookups like `groups/`, `logs/`, `incidents/` need to climb one level.
 */
const PROJECT_ROOT = dirname(dirname(dbPath));
const GROUPS_ROOT = join(PROJECT_ROOT, 'groups');
const LOGS_ROOT = join(PROJECT_ROOT, 'logs');
const INCIDENTS_ROOT = join(PROJECT_ROOT, 'incidents');

const app = express();

// ---------------------------------------------------------------------------
// CORS middleware (manual, no extra dep)
// ---------------------------------------------------------------------------

app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Serve static files from dist/ in production
// ---------------------------------------------------------------------------

const distDir = resolve(dirname(import.meta.url.replace('file://', '')), '../dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePeriod(period: unknown): { days: number; since: string; prevSince: string } {
  const days = period === '30d' ? 30 : 7;
  const now = Date.now();
  const since = new Date(now - days * 86400000).toISOString();
  const prevSince = new Date(now - days * 2 * 86400000).toISOString();
  return { days, since, prevSince };
}

/** Safe percentage change between two numbers. Returns 0 when prev is 0. */
function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10; // 1 decimal
}

/** Estimate per-token cost based on model name. Returns { inputRate, outputRate } per token. */
function tokenRates(model: string): { inputRate: number; outputRate: number } {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return { inputRate: 15 / 1e6, outputRate: 75 / 1e6 };
  if (m.includes('haiku')) return { inputRate: 0.25 / 1e6, outputRate: 1.25 / 1e6 };
  // default to sonnet
  return { inputRate: 3 / 1e6, outputRate: 15 / 1e6 };
}

// ---------------------------------------------------------------------------
// GET /api/stats?period=7d|30d
// ---------------------------------------------------------------------------

app.get('/api/stats', (req, res) => {
  try {
    const { days, since, prevSince } = parsePeriod(req.query.period);

    // ---- Current period summary ----
    const summary = db
      .prepare(
        `SELECT
          COUNT(*) as totalRuns,
          COALESCE(SUM(estimated_cost_usd), 0) as totalCost,
          COALESCE(SUM(input_tokens + output_tokens), 0) as totalTokens,
          COALESCE(AVG(duration_ms), 0) as avgDuration,
          COUNT(DISTINCT group_folder) as activeGroups,
          COALESCE(SUM(CASE WHEN status = 'success' OR status IS NULL THEN 1 ELSE 0 END), 0) as successCount,
          COALESCE(SUM(cache_read_tokens), 0) as totalCacheReads,
          COALESCE(SUM(cache_creation_tokens), 0) as totalCacheCreation
        FROM agent_runs
        WHERE run_at >= ?`
      )
      .get(since) as Record<string, number>;

    const successRate =
      summary.totalRuns > 0
        ? Math.round((summary.successCount / summary.totalRuns) * 1000) / 10
        : 100;

    // Uptime from first run ever
    const firstRun = db
      .prepare(`SELECT MIN(run_at) as first FROM agent_runs`)
      .get() as { first: string | null };
    const uptimeHours = firstRun?.first
      ? Math.round((Date.now() - new Date(firstRun.first).getTime()) / 3600000 * 10) / 10
      : 0;

    // ---- Previous period (for trends) ----
    const prev = db
      .prepare(
        `SELECT
          COUNT(*) as totalRuns,
          COALESCE(SUM(estimated_cost_usd), 0) as totalCost,
          COALESCE(AVG(duration_ms), 0) as avgDuration
        FROM agent_runs
        WHERE run_at >= ? AND run_at < ?`
      )
      .get(prevSince, since) as Record<string, number>;

    const trends = {
      runsTrend: pctChange(summary.totalRuns, prev.totalRuns),
      costTrend: pctChange(summary.totalCost, prev.totalCost),
      durationTrend: pctChange(summary.avgDuration, prev.avgDuration),
    };

    // ---- Daily breakdown ----
    const daily = db
      .prepare(
        `SELECT
          DATE(run_at) as date,
          COUNT(*) as runs,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
          SUM(CASE WHEN status = 'success' OR status IS NULL THEN 1 ELSE 0 END) as successCount,
          SUM(CASE WHEN status IS NOT NULL AND status != 'success' THEN 1 ELSE 0 END) as errorCount
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY DATE(run_at)
        ORDER BY date`
      )
      .all(since);

    // ---- Daily by model (for stacked charts) ----
    const dailyByModel = db
      .prepare(
        `SELECT
          DATE(run_at) as date,
          model,
          COUNT(*) as runs,
          COALESCE(SUM(estimated_cost_usd), 0) as cost
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY DATE(run_at), model
        ORDER BY date, model`
      )
      .all(since);

    // ---- Groups breakdown ----
    const groups = db
      .prepare(
        `SELECT
          group_folder as folder,
          COUNT(*) as runs,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COALESCE(AVG(duration_ms), 0) as avgDuration,
          ROUND(
            SUM(CASE WHEN status = 'success' OR status IS NULL THEN 1.0 ELSE 0.0 END)
            / COUNT(*) * 100, 1
          ) as successRate,
          MAX(run_at) as lastRunAt
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY group_folder
        ORDER BY cost DESC`
      )
      .all(since);

    // ---- Model breakdown ----
    const modelBreakdown = db
      .prepare(
        `SELECT
          model,
          COUNT(*) as runs,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COALESCE(AVG(duration_ms), 0) as avgDuration,
          COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY model
        ORDER BY cost DESC`
      )
      .all(since);

    // ---- Recent runs ----
    const recentRuns = db
      .prepare(
        `SELECT
          rowid as id,
          group_folder as groupFolder,
          trigger_type as triggerType,
          model,
          input_tokens as inputTokens,
          output_tokens as outputTokens,
          cache_read_tokens as cacheReadTokens,
          cache_creation_tokens as cacheCreationTokens,
          estimated_cost_usd as estimatedCost,
          duration_ms as durationMs,
          turns,
          status,
          run_at as runAt
        FROM agent_runs
        ORDER BY run_at DESC
        LIMIT 20`
      )
      .all();

    // ---- System health ----
    let systemGroups: unknown[] = [];
    try {
      systemGroups = db
        .prepare(
          `SELECT
            rg.folder,
            rg.name,
            rg.runtime,
            rg.is_main as isMain,
            CASE WHEN s.session_id IS NOT NULL THEN 1 ELSE 0 END as hasSession
          FROM registered_groups rg
          LEFT JOIN sessions s ON s.group_folder = rg.folder
          ORDER BY rg.is_main DESC, rg.name`
        )
        .all();
    } catch {
      // sessions or registered_groups table may not exist
    }

    let scheduledTasks: unknown[] = [];
    try {
      scheduledTasks = db
        .prepare(
          `SELECT
            id,
            group_folder as groupFolder,
            prompt,
            schedule_value as scheduleValue,
            status,
            next_run as nextRun,
            last_run as lastRun
          FROM scheduled_tasks
          ORDER BY next_run ASC`
        )
        .all();
    } catch {
      // table may not exist
    }

    res.json({
      summary: {
        totalRuns: summary.totalRuns,
        totalCost: summary.totalCost,
        totalTokens: summary.totalTokens,
        avgDuration: summary.avgDuration,
        activeGroups: summary.activeGroups,
        uptimeHours,
        successRate,
        totalCacheReads: summary.totalCacheReads,
        totalCacheCreation: summary.totalCacheCreation,
      },
      trends,
      daily,
      dailyByModel,
      groups,
      modelBreakdown,
      recentRuns,
      systemHealth: {
        groups: systemGroups,
        scheduledTasks,
      },
    });
  } catch (err) {
    console.error('GET /api/stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/costs?period=7d|30d
// ---------------------------------------------------------------------------

app.get('/api/costs', (req, res) => {
  try {
    const { since } = parsePeriod(req.query.period);

    // ---- Daily cost with input/output/cache breakdown ----
    const dailyCost = db
      .prepare(
        `SELECT
          DATE(run_at) as date,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COALESCE(SUM(input_tokens), 0) as inputTokens,
          COALESCE(SUM(output_tokens), 0) as outputTokens,
          COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
          COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
          model
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY DATE(run_at), model
        ORDER BY date`
      )
      .all(since) as Array<{
        date: string;
        cost: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        model: string;
      }>;

    // Aggregate per-day with estimated cost breakdown
    const dailyMap = new Map<
      string,
      { date: string; cost: number; inputCost: number; outputCost: number; cacheCost: number }
    >();
    for (const row of dailyCost) {
      const rates = tokenRates(row.model);
      const inputCost = row.inputTokens * rates.inputRate;
      const outputCost = row.outputTokens * rates.outputRate;
      // cache reads are cheaper (typically 10% of input price)
      const cacheCost = row.cacheReadTokens * rates.inputRate * 0.1;

      const existing = dailyMap.get(row.date) || {
        date: row.date,
        cost: 0,
        inputCost: 0,
        outputCost: 0,
        cacheCost: 0,
      };
      existing.cost += row.cost;
      existing.inputCost += inputCost;
      existing.outputCost += outputCost;
      existing.cacheCost += cacheCost;
      dailyMap.set(row.date, existing);
    }

    // ---- By model ----
    const byModel = db
      .prepare(
        `SELECT
          model,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COUNT(*) as runs,
          COALESCE(SUM(input_tokens), 0) as inputTokens,
          COALESCE(SUM(output_tokens), 0) as outputTokens,
          COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY model
        ORDER BY cost DESC`
      )
      .all(since);

    // ---- By group ----
    const byGroup = db
      .prepare(
        `SELECT
          group_folder as folder,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COUNT(*) as runs
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY group_folder
        ORDER BY cost DESC`
      )
      .all(since);

    // ---- By trigger ----
    const byTrigger = db
      .prepare(
        `SELECT
          trigger_type as triggerType,
          COALESCE(SUM(estimated_cost_usd), 0) as cost,
          COUNT(*) as runs
        FROM agent_runs
        WHERE run_at >= ?
        GROUP BY trigger_type
        ORDER BY cost DESC`
      )
      .all(since);

    // ---- Cache stats ----
    const cacheRow = db
      .prepare(
        `SELECT
          COALESCE(SUM(input_tokens), 0) as totalInput,
          COALESCE(SUM(cache_read_tokens), 0) as totalCacheRead,
          COALESCE(SUM(cache_creation_tokens), 0) as totalCacheCreation
        FROM agent_runs
        WHERE run_at >= ?`
      )
      .get(since) as { totalInput: number; totalCacheRead: number; totalCacheCreation: number };

    const totalInputPlusCacheRead = cacheRow.totalInput + cacheRow.totalCacheRead;
    const hitRate =
      totalInputPlusCacheRead > 0
        ? Math.round((cacheRow.totalCacheRead / totalInputPlusCacheRead) * 1000) / 10
        : 0;

    // ---- Cost per message ----
    let messageCount = 0;
    try {
      const msgRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM messages WHERE timestamp >= ? AND is_from_me = 0`
        )
        .get(since) as { cnt: number };
      messageCount = msgRow.cnt;
    } catch {
      // messages table may not exist
    }

    const totalCostRow = db
      .prepare(`SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM agent_runs WHERE run_at >= ?`)
      .get(since) as { total: number };

    const costPerMessage = messageCount > 0 ? totalCostRow.total / messageCount : 0;

    res.json({
      dailyCost: Array.from(dailyMap.values()),
      byModel,
      byGroup,
      byTrigger,
      cacheStats: {
        totalInput: cacheRow.totalInput,
        totalCacheRead: cacheRow.totalCacheRead,
        totalCacheCreation: cacheRow.totalCacheCreation,
        hitRate,
      },
      costPerMessage: Math.round(costPerMessage * 10000) / 10000,
    });
  } catch (err) {
    console.error('GET /api/costs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/incidents
// ---------------------------------------------------------------------------

app.get('/api/incidents', (_req, res) => {
  try {
    const incidentsDir = resolve(process.cwd(), 'incidents');
    if (!existsSync(incidentsDir)) {
      res.json({ incidents: [] });
      return;
    }

    const files = readdirSync(incidentsDir).filter(
      (f) => f.endsWith('.md')
    );

    const incidents = files.map((filename) => {
      const filePath = join(incidentsDir, filename);
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);

      // Parse id from filename: e.g., "2026-05-08T12-00-00-title-slug.md" or "incident-123.APPROVED.md"
      const id = filename.replace(/\.(APPROVED\.)?md$/, '');

      // Determine status
      const isApproved = filename.includes('.APPROVED.');
      const isFixed = content.includes('## Fix Applied') || content.includes('FIXED');
      let status: string = 'open';
      if (isFixed) status = 'fixed';
      else if (isApproved) status = 'approved';

      // Parse frontmatter-style fields from content
      const getField = (name: string): string => {
        // Try "**Field:** value" format
        const boldMatch = content.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, 'i'));
        if (boldMatch) return boldMatch[1].trim();
        // Try "Field: value" format
        const simpleMatch = content.match(new RegExp(`^${name}:\\s*(.+)`, 'im'));
        if (simpleMatch) return simpleMatch[1].trim();
        // Try "## Field\nvalue" format
        const sectionMatch = content.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i'));
        if (sectionMatch) return sectionMatch[1].trim();
        return '';
      };

      return {
        id,
        title: getField('Title') || getField('title') || id,
        symptoms: getField('Symptoms') || getField('symptoms'),
        proposedFix: getField('Proposed Fix') || getField('proposed_fix') || getField('Proposed fix'),
        status,
        createdAt: stat.birthtime.toISOString(),
        approvedAt: isApproved ? stat.mtime.toISOString() : null,
        fixedAt: isFixed ? stat.mtime.toISOString() : null,
      };
    });

    // Sort newest first
    incidents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({ incidents });
  } catch (err) {
    console.error('GET /api/incidents error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/conversations?group=xxx&limit=20
// ---------------------------------------------------------------------------

app.get('/api/conversations', (req, res) => {
  try {
    const groupFilter = req.query.group as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);

    let query: string;
    const params: unknown[] = [];

    if (groupFilter) {
      // Join with registered_groups to filter by folder
      query = `
        SELECT
          m.chat_jid as chatJid,
          COALESCE(rg.name, m.chat_jid) as chatName,
          rg.folder as channel,
          (SELECT content FROM messages m2 WHERE m2.chat_jid = m.chat_jid ORDER BY m2.timestamp DESC LIMIT 1) as lastMessage,
          COUNT(*) as messageCount,
          MAX(m.timestamp) as lastMessageTime
        FROM messages m
        LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE rg.folder = ?
        GROUP BY m.chat_jid
        ORDER BY lastMessageTime DESC
        LIMIT ?
      `;
      params.push(groupFilter, limit);
    } else {
      query = `
        SELECT
          m.chat_jid as chatJid,
          COALESCE(rg.name, m.chat_jid) as chatName,
          rg.folder as channel,
          (SELECT content FROM messages m2 WHERE m2.chat_jid = m.chat_jid ORDER BY m2.timestamp DESC LIMIT 1) as lastMessage,
          COUNT(*) as messageCount,
          MAX(m.timestamp) as lastMessageTime
        FROM messages m
        LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        GROUP BY m.chat_jid
        ORDER BY lastMessageTime DESC
        LIMIT ?
      `;
      params.push(limit);
    }

    const conversations = db.prepare(query).all(...params);
    res.json({ conversations });
  } catch (err) {
    console.error('GET /api/conversations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  try {
    // Quick DB check
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', dbPath, uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'error', dbPath, error: 'Database unreachable' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/groups — registered groups with CLAUDE.md preview + activity
// ---------------------------------------------------------------------------

app.get('/api/groups', (_req, res) => {
  try {
    const groupsRoot = GROUPS_ROOT;
    const folders = existsSync(groupsRoot)
      ? readdirSync(groupsRoot).filter((f) => {
          const p = join(groupsRoot, f);
          return statSync(p).isDirectory() && !f.startsWith('.');
        })
      : [];

    let registered: Array<{
      folder: string;
      name: string;
      runtime: string | null;
      isMain: number;
      requiresTrigger: number;
      agentConfig: string | null;
      addedAt: string;
    }> = [];
    try {
      registered = db
        .prepare(
          `SELECT folder, name, runtime, is_main as isMain,
                  requires_trigger as requiresTrigger,
                  agent_config as agentConfig, added_at as addedAt
           FROM registered_groups`
        )
        .all() as typeof registered;
    } catch {}

    const regByFolder = new Map(registered.map((r) => [r.folder, r]));

    const groupList = folders.map((folder) => {
      const folderPath = join(groupsRoot, folder);
      const claudePath = join(folderPath, 'CLAUDE.md');
      const memoryPath = join(folderPath, 'memory');

      const meta = regByFolder.get(folder);

      let claudeBytes = 0;
      let claudeFirstLine = '';
      let claudePreview = '';
      if (existsSync(claudePath)) {
        const stat = statSync(claudePath);
        claudeBytes = stat.size;
        const head = readFileSync(claudePath, 'utf-8').slice(0, 2000);
        claudePreview = head;
        const firstHeading = head.match(/^#\s+(.+)$/m);
        claudeFirstLine = firstHeading ? firstHeading[1].trim() : '';
      }

      let memoryFiles = 0;
      if (existsSync(memoryPath)) {
        try {
          const walk = (p: string): number => {
            let n = 0;
            for (const e of readdirSync(p)) {
              const full = join(p, e);
              const s = statSync(full);
              if (s.isDirectory()) n += walk(full);
              else if (e.endsWith('.md') || e.endsWith('.json')) n += 1;
            }
            return n;
          };
          memoryFiles = walk(memoryPath);
        } catch {}
      }

      let totalRuns = 0;
      let totalCost = 0;
      let lastRunAt: string | null = null;
      try {
        const r = db
          .prepare(
            `SELECT COUNT(*) as n,
                    COALESCE(SUM(estimated_cost_usd), 0) as cost,
                    MAX(run_at) as last
             FROM agent_runs WHERE group_folder = ?`
          )
          .get(folder) as { n: number; cost: number; last: string | null };
        totalRuns = r.n;
        totalCost = r.cost;
        lastRunAt = r.last;
      } catch {}

      let agentConfig: unknown = null;
      if (meta?.agentConfig) {
        try { agentConfig = JSON.parse(meta.agentConfig); } catch {}
      }

      return {
        folder,
        name: meta?.name || claudeFirstLine || folder,
        runtime: meta?.runtime || 'sandbox',
        isMain: !!meta?.isMain,
        requiresTrigger: meta?.requiresTrigger !== 0,
        registered: !!meta,
        addedAt: meta?.addedAt || null,
        claudeMdBytes: claudeBytes,
        claudeMdPreview: claudePreview,
        memoryFiles,
        totalRuns,
        totalCost,
        lastRunAt,
        agentConfig,
      };
    });

    groupList.sort((a, b) => Number(b.isMain) - Number(a.isMain) || b.totalRuns - a.totalRuns);

    res.json({ groups: groupList });
  } catch (err) {
    console.error('GET /api/groups error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tasks — kanban-style aggregate (scheduled / running / done / failed)
// ---------------------------------------------------------------------------

app.get('/api/tasks', (_req, res) => {
  try {
    let scheduled: unknown[] = [];
    try {
      scheduled = db
        .prepare(
          `SELECT id, group_folder as groupFolder, prompt, schedule_type as scheduleType,
                  schedule_value as scheduleValue, next_run as nextRun, last_run as lastRun,
                  last_result as lastResult, status, model, context_mode as contextMode,
                  created_at as createdAt
           FROM scheduled_tasks
           ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                    next_run ASC NULLS LAST`
        )
        .all();
    } catch {}

    // Recent runs split by status (in last 24h)
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const recent = db
      .prepare(
        `SELECT rowid as id, group_folder as groupFolder, trigger_type as triggerType,
                model, status, run_at as runAt, duration_ms as durationMs, turns,
                estimated_cost_usd as estimatedCost
         FROM agent_runs
         WHERE run_at >= ?
         ORDER BY run_at DESC
         LIMIT 100`
      )
      .all(since24h) as Array<{ status: string; runAt: string; durationMs: number }>;

    const running = recent.filter((r) => {
      // a run "in progress" = no terminal status AND less than 10min old
      const isTerminal = ['success', 'error', 'failed', 'timeout'].includes((r.status || '').toLowerCase());
      const ageMs = Date.now() - new Date(r.runAt).getTime();
      return !isTerminal && ageMs < 600000;
    });
    const done = recent.filter((r) => (r.status || '').toLowerCase() === 'success').slice(0, 30);
    const failed = recent.filter((r) => {
      const s = (r.status || '').toLowerCase();
      return s === 'error' || s === 'failed' || s === 'timeout';
    }).slice(0, 30);

    // Open incidents
    let openIncidents: Array<{ id: string; title: string; status: string; createdAt: string }> = [];
    try {
      const incidentsDir = INCIDENTS_ROOT;
      if (existsSync(incidentsDir)) {
        const files = readdirSync(incidentsDir).filter((f) => f.endsWith('.md'));
        openIncidents = files.map((f) => {
          const fp = join(incidentsDir, f);
          const stat = statSync(fp);
          const id = f.replace(/\.(APPROVED\.)?md$/, '');
          const isApproved = f.includes('.APPROVED.');
          const content = readFileSync(fp, 'utf-8');
          const isFixed = content.includes('## Fix Applied') || content.includes('FIXED');
          let status = 'open';
          if (isFixed) status = 'fixed';
          else if (isApproved) status = 'approved';
          const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/\*\*Title:\*\*\s*(.+)/i);
          const title = titleMatch ? titleMatch[1].trim() : id;
          return { id, title, status, createdAt: stat.birthtime.toISOString() };
        }).filter((i) => i.status !== 'fixed').slice(0, 30);
      }
    } catch {}

    res.json({
      scheduled,
      running,
      done,
      failed,
      incidents: openIncidents,
      counts: {
        scheduled: scheduled.length,
        running: running.length,
        done: done.length,
        failed: failed.length,
        incidents: openIncidents.length,
      },
    });
  } catch (err) {
    console.error('GET /api/tasks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/memory/tree?group=personal — recursive tree of groups/<g>/memory/
// ---------------------------------------------------------------------------

app.get('/api/memory/tree', (req, res) => {
  try {
    const group = (req.query.group as string) || 'personal';
    if (!/^[a-zA-Z0-9_-]+$/.test(group)) {
      res.status(400).json({ error: 'Invalid group name' });
      return;
    }
    const groupRoot = join(GROUPS_ROOT, group);
    if (!existsSync(groupRoot)) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    type Node = { name: string; path: string; type: 'dir' | 'file'; size?: number; mtime?: string; children?: Node[] };
    const walk = (absPath: string, relPath: string): Node[] => {
      const out: Node[] = [];
      let entries: string[] = [];
      try { entries = readdirSync(absPath); } catch { return out; }
      for (const name of entries.sort()) {
        if (name.startsWith('.')) continue;
        const abs = join(absPath, name);
        const rel = relPath ? `${relPath}/${name}` : name;
        let stat;
        try { stat = statSync(abs); } catch { continue; }
        if (stat.isDirectory()) {
          out.push({ name, path: rel, type: 'dir', children: walk(abs, rel) });
        } else {
          out.push({
            name,
            path: rel,
            type: 'file',
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      }
      return out;
    };

    const tree: Node[] = [];
    const claudeMd = join(groupRoot, 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const stat = statSync(claudeMd);
      tree.push({ name: 'CLAUDE.md', path: 'CLAUDE.md', type: 'file', size: stat.size, mtime: stat.mtime.toISOString() });
    }
    const memoryRoot = join(groupRoot, 'memory');
    if (existsSync(memoryRoot)) {
      tree.push({ name: 'memory', path: 'memory', type: 'dir', children: walk(memoryRoot, 'memory') });
    }
    // Also surface other top-level *.md files (SOUL.md, USER.md, etc.)
    for (const name of readdirSync(groupRoot).sort()) {
      if (name === 'CLAUDE.md' || name === 'memory' || name.startsWith('.')) continue;
      const abs = join(groupRoot, name);
      let stat;
      try { stat = statSync(abs); } catch { continue; }
      if (stat.isFile() && name.endsWith('.md')) {
        tree.push({ name, path: name, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() });
      }
    }

    res.json({ group, tree });
  } catch (err) {
    console.error('GET /api/memory/tree error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/memory/file?group=personal&path=memory/topics/foo.md
// ---------------------------------------------------------------------------

app.get('/api/memory/file', (req, res) => {
  try {
    const group = (req.query.group as string) || 'personal';
    const relPath = (req.query.path as string) || '';
    if (!/^[a-zA-Z0-9_-]+$/.test(group)) {
      res.status(400).json({ error: 'Invalid group name' });
      return;
    }
    // Path traversal guard
    if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const groupRoot = join(GROUPS_ROOT, group);
    const target = resolve(groupRoot, relPath);
    if (!target.startsWith(groupRoot + '/') && target !== groupRoot) {
      res.status(403).json({ error: 'Path escapes group root' });
      return;
    }
    if (!existsSync(target)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const stat = statSync(target);
    if (!stat.isFile()) {
      res.status(400).json({ error: 'Not a file' });
      return;
    }
    if (stat.size > 1024 * 1024) {
      res.status(413).json({ error: 'File too large (>1MB)' });
      return;
    }
    const content = readFileSync(target, 'utf-8');
    res.json({ path: relPath, size: stat.size, mtime: stat.mtime.toISOString(), content });
  } catch (err) {
    console.error('GET /api/memory/file error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cron — scheduled_tasks with humanized schedule
// ---------------------------------------------------------------------------

app.get('/api/cron', (_req, res) => {
  try {
    let tasks: Array<Record<string, unknown>> = [];
    try {
      tasks = db
        .prepare(
          `SELECT id, group_folder as groupFolder, prompt, schedule_type as scheduleType,
                  schedule_value as scheduleValue, next_run as nextRun, last_run as lastRun,
                  last_result as lastResult, status, model, context_mode as contextMode,
                  created_at as createdAt, chat_jid as chatJid
           FROM scheduled_tasks
           ORDER BY status DESC, next_run ASC NULLS LAST`
        )
        .all() as typeof tasks;
    } catch {}

    res.json({ tasks });
  } catch (err) {
    console.error('GET /api/cron error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/logs?file=claudeclaw.log&tail=200
// ---------------------------------------------------------------------------

app.get('/api/logs', (req, res) => {
  try {
    const fileName = (req.query.file as string) || 'claudeclaw.log';
    if (!/^[a-zA-Z0-9_.-]+\.log$/.test(fileName)) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    const tail = Math.min(Math.max(Number(req.query.tail) || 200, 10), 2000);
    const logsRoot = LOGS_ROOT;
    const target = join(logsRoot, fileName);
    if (!target.startsWith(logsRoot + '/')) {
      res.status(403).json({ error: 'Path escape' });
      return;
    }
    if (!existsSync(target)) {
      res.status(404).json({ error: 'Log not found' });
      return;
    }
    const stat = statSync(target);
    // Read last ~512KB to extract tail without slurping the whole file
    const maxRead = Math.min(stat.size, 512 * 1024);
    const buf = Buffer.alloc(maxRead);
    const fd = openSync(target, 'r');
    readSync(fd, buf, 0, maxRead, stat.size - maxRead);
    closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    const tailLines = lines.slice(-tail);

    // List all available log files
    const files = readdirSync(logsRoot)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const s = statSync(join(logsRoot, f));
        return { name: f, size: s.size, mtime: s.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));

    res.json({
      file: fileName,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      lines: tailLines,
      files,
    });
  } catch (err) {
    console.error('GET /api/logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin: self-restart (localhost only)
// launchd KeepAlive=true respawns the process with the latest dist-server build.
// Lets the agent (running inside sandbox) refresh dashboard code without external kill.
// ---------------------------------------------------------------------------

app.post('/api/admin/restart', (req, res) => {
  const remote = req.socket.remoteAddress || '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLocal) {
    res.status(403).json({ error: 'forbidden: localhost only' });
    return;
  }
  res.json({ ok: true, restarting: true, pid: process.pid });
  // Give the response a tick to flush, then exit so launchd respawns us.
  setTimeout(() => process.exit(0), 100);
});

// ---------------------------------------------------------------------------
// Chat API (topics, messages, status, logs)
// ---------------------------------------------------------------------------

setupChatApi(app, dbPath);

// ---------------------------------------------------------------------------
// SPA fallback - serve index.html for non-API routes (production)
// ---------------------------------------------------------------------------

if (existsSync(distDir)) {
  // Express 5 requires named param for catch-all
  app.get('/{*path}', (_req, res) => {
    const indexPath = join(distDir, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Dashboard API running on http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
});
