import type { Express, Response } from 'express';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

interface SSEClient {
  res: Response;
  topicId: string;
  lastTs: string;
}

// ---------------------------------------------------------------------------
// Setup chat tables + routes
// ---------------------------------------------------------------------------

export function setupChatApi(app: Express, dbPath: string) {
  // Read-write connection for chat features (separate from readonly analytics)
  const rw = new Database(dbPath, { readonly: false });
  rw.pragma('journal_mode = WAL');

  // Readonly connection for reading messages
  const ro = new Database(dbPath, { readonly: true });
  ro.pragma('journal_mode = WAL');

  // Create dashboard-specific tables
  rw.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      system_context TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS message_topics (
      message_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      PRIMARY KEY (message_id, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_topics_topic ON message_topics(topic_id);
  `);

  // Seed default topics if empty
  const topicCount = ro.prepare('SELECT COUNT(*) as cnt FROM dashboard_topics').get() as { cnt: number };
  if (topicCount.cnt === 0) {
    const insert = rw.prepare(
      'INSERT INTO dashboard_topics (id, name, category, icon, system_context, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const defaults = [
      ['general', 'General', '', 'MessageSquare', '', 0],
      ['health-physical', 'Physical', 'Health', 'Heart', 'Context: physical health, training, sleep, Garmin data', 10],
      ['health-mental', 'Mental', 'Health', 'Brain', 'Context: mental health, anxiety, stress, MentorOS', 11],
      ['health-bju', 'BJU Tracking', 'Health', 'Apple', 'Context: nutrition tracking, calories, protein, macros', 12],
      ['coding-claudeclaw', 'ClaudeClaw', 'Coding', 'Terminal', 'Context: ClaudeClaw bot development, orchestrator, fixes', 20],
      ['coding-agentdrive', 'Agent Drive', 'Coding', 'Monitor', 'Context: Agent Drive desktop app, Tauri, React, chat UI', 21],
      ['content-telegram', 'Telegram @datapine', 'Content', 'Send', 'Context: Telegram channel posts, datapine style', 30],
      ['content-youtube', 'YouTube', 'Content', 'Play', 'Context: YouTube content, video scripts, thumbnails', 31],
      ['content-instagram', 'Instagram', 'Content', 'Image', 'Context: Instagram content, reels, stories', 32],
      ['orchestrator', 'Orchestrator', '', 'Layers', 'Context: high-level planning, cross-topic coordination', 99],
    ];
    const tx = rw.transaction(() => {
      for (const [id, name, category, icon, ctx, order] of defaults) {
        insert.run(id, name, category, icon, ctx, order);
      }
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // GET /api/topics
  // -------------------------------------------------------------------------
  app.get('/api/topics', (_req, res) => {
    try {
      const topics = ro.prepare(
        'SELECT id, name, category, icon, system_context, sort_order, created_at FROM dashboard_topics ORDER BY sort_order, name'
      ).all();
      res.json({ topics });
    } catch (err) {
      console.error('GET /api/topics error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/topics
  // -------------------------------------------------------------------------
  app.post('/api/topics', (req, res) => {
    try {
      const { id, name, category, icon, system_context, sort_order } = req.body;
      if (!id || !name) {
        res.status(400).json({ error: 'id and name required' });
        return;
      }
      rw.prepare(
        'INSERT OR REPLACE INTO dashboard_topics (id, name, category, icon, system_context, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, name, category || '', icon || '', system_context || '', sort_order || 0);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/topics error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/chat/messages - messages from ClaudeClaw's main pipeline
  // -------------------------------------------------------------------------
  app.get('/api/chat/messages', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const before = req.query.before as string | undefined;
      const topicId = req.query.topic as string | undefined;
      const chatJid = 'tg:263349181'; // personal group JID

      let query: string;
      const params: unknown[] = [];

      if (topicId && topicId !== 'general') {
        // Filter by topic - only show messages tagged with this topic
        if (before) {
          query = `
            SELECT m.id, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me, m.is_bot_message
            FROM messages m
            INNER JOIN message_topics mt ON mt.message_id = m.id
            WHERE m.chat_jid = ? AND mt.topic_id = ? AND m.timestamp < ?
            ORDER BY m.timestamp DESC
            LIMIT ?
          `;
          params.push(chatJid, topicId, before, limit);
        } else {
          query = `
            SELECT m.id, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me, m.is_bot_message
            FROM messages m
            INNER JOIN message_topics mt ON mt.message_id = m.id
            WHERE m.chat_jid = ? AND mt.topic_id = ?
            ORDER BY m.timestamp DESC
            LIMIT ?
          `;
          params.push(chatJid, topicId, limit);
        }
      } else {
        // General: show all messages
        if (before) {
          query = `
            SELECT id, sender, sender_name, content, timestamp, is_from_me, is_bot_message
            FROM messages
            WHERE chat_jid = ? AND timestamp < ?
            ORDER BY timestamp DESC
            LIMIT ?
          `;
          params.push(chatJid, before, limit);
        } else {
          query = `
            SELECT id, sender, sender_name, content, timestamp, is_from_me, is_bot_message
            FROM messages
            WHERE chat_jid = ?
            ORDER BY timestamp DESC
            LIMIT ?
          `;
          params.push(chatJid, limit);
        }
      }

      const messages = ro.prepare(query).all(...params);
      // Reverse to chronological order
      messages.reverse();

      res.json({ messages });
    } catch (err) {
      console.error('GET /api/chat/messages error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/chat/send - insert message into ClaudeClaw pipeline
  // -------------------------------------------------------------------------
  app.post('/api/chat/send', (req, res) => {
    try {
      const { content, topicId } = req.body;
      if (!content) {
        res.status(400).json({ error: 'content required' });
        return;
      }

      const chatJid = 'tg:263349181';
      const msgId = `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timestamp = new Date().toISOString();

      // Prepend topic context if available
      let finalContent = content;
      if (topicId && topicId !== 'general') {
        const topic = ro.prepare('SELECT system_context, name FROM dashboard_topics WHERE id = ?').get(topicId) as { system_context: string; name: string } | undefined;
        if (topic?.system_context) {
          finalContent = `[Topic: ${topic.name}] ${content}`;
        }
      }

      // Insert into ClaudeClaw's messages table
      rw.prepare(
        'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(msgId, chatJid, 'Btchit', 'Btchit', finalContent, timestamp, 0, 0);

      // Tag message with topic
      if (topicId && topicId !== 'general') {
        rw.prepare('INSERT OR IGNORE INTO message_topics (message_id, topic_id) VALUES (?, ?)').run(msgId, topicId);
      }

      res.json({ ok: true, id: msgId, timestamp });
    } catch (err) {
      console.error('POST /api/chat/send error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/chat/tag - tag existing messages with a topic (bulk)
  // -------------------------------------------------------------------------
  app.post('/api/chat/tag', (req, res) => {
    try {
      const { messageIds, topicId } = req.body;
      if (!messageIds?.length || !topicId) {
        res.status(400).json({ error: 'messageIds and topicId required' });
        return;
      }
      const insert = rw.prepare('INSERT OR IGNORE INTO message_topics (message_id, topic_id) VALUES (?, ?)');
      const tx = rw.transaction(() => {
        for (const id of messageIds) {
          insert.run(id, topicId);
        }
      });
      tx();
      res.json({ ok: true, tagged: messageIds.length });
    } catch (err) {
      console.error('POST /api/chat/tag error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/chat/stream - SSE stream of new messages for a topic
  // -------------------------------------------------------------------------
  const sseClients: SSEClient[] = [];

  app.get('/api/chat/stream', (req, res) => {
    const topicId = (req.query.topic as string) || 'general';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', topicId })}\n\n`);
    res.flushHeaders?.();

    // Start lastTs at "now" so we only get messages created after connection.
    const client: SSEClient = { res, topicId, lastTs: new Date().toISOString() };
    sseClients.push(client);

    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch { /* dead */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const idx = sseClients.indexOf(client);
      if (idx >= 0) sseClients.splice(idx, 1);
    });
  });

  // Single poll loop pushes new messages to all subscribed clients.
  // 500ms latency is acceptable for chat; lighter than per-client setInterval.
  const chatJidGlobal = 'tg:263349181';
  setInterval(() => {
    if (sseClients.length === 0) return;
    for (const client of sseClients) {
      try {
        let rows: Array<{ id: string; timestamp: string }>;
        if (client.topicId === 'general') {
          rows = ro.prepare(
            `SELECT id, sender, sender_name, content, timestamp, is_from_me, is_bot_message
             FROM messages
             WHERE chat_jid = ? AND timestamp > ?
             ORDER BY timestamp ASC LIMIT 50`
          ).all(chatJidGlobal, client.lastTs) as Array<{ id: string; timestamp: string }>;
        } else {
          rows = ro.prepare(
            `SELECT m.id, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me, m.is_bot_message
             FROM messages m
             INNER JOIN message_topics mt ON mt.message_id = m.id
             WHERE m.chat_jid = ? AND mt.topic_id = ? AND m.timestamp > ?
             ORDER BY m.timestamp ASC LIMIT 50`
          ).all(chatJidGlobal, client.topicId, client.lastTs) as Array<{ id: string; timestamp: string }>;
        }
        for (const msg of rows) {
          try { client.res.write(`data: ${JSON.stringify({ type: 'message', data: msg })}\n\n`); } catch { /* dead */ }
          if (msg.timestamp > client.lastTs) client.lastTs = msg.timestamp;
        }
      } catch (err) {
        console.error('SSE poll error:', err);
      }
    }
  }, 500);

  // -------------------------------------------------------------------------
  // POST /api/chat/auto-classify - classify recent messages into topics
  // -------------------------------------------------------------------------
  app.post('/api/chat/auto-classify', (_req, res) => {
    try {
      const chatJid = 'tg:263349181';
      // Get untagged messages
      const untagged = ro.prepare(`
        SELECT m.id, m.content, m.is_bot_message, m.timestamp
        FROM messages m
        LEFT JOIN message_topics mt ON mt.message_id = m.id
        WHERE m.chat_jid = ? AND mt.message_id IS NULL AND m.content IS NOT NULL
        ORDER BY m.timestamp DESC
        LIMIT 500
      `).all(chatJid) as Array<{ id: string; content: string; is_bot_message: number; timestamp: string }>;

      const insert = rw.prepare('INSERT OR IGNORE INTO message_topics (message_id, topic_id) VALUES (?, ?)');

      // Keyword-based classification
      const rules: Array<{ topic: string; patterns: RegExp[] }> = [
        { topic: 'health-bju', patterns: [/\b(ккал|калори|бжу|протеин|белок|жир|углевод|порц|грамм|еда|завтрак|обед|ужин|перекус|макрос|nutrition|calories)\b/i, /\b(К:\d|Б:\d|Ж:\d|У:\d)/] },
        { topic: 'health-physical', patterns: [/\b(тренировк|Garmin|пульс|сон|sleep|deep sleep|REM|Body Battery|шаг|steps|баня|холодн|вес\s*\d|кг|heart rate|HRV|stress|recovery)\b/i] },
        { topic: 'health-mental', patterns: [/\b(тревог|anxiety|стресс|паник|MentorOS|ACT|DBT|worry|check.?in|настроен|mentall?)\b/i] },
        { topic: 'coding-claudeclaw', patterns: [/\b(ClaudeClaw|orchestrator|message.?loop|container|sandbox|agent.?run|group.?queue|webhook|MCP|ipc|launchd)\b/i] },
        { topic: 'coding-agentdrive', patterns: [/\b(Agent.?Drive|Tauri|desktop.?app|LobeChat)\b/i] },
        { topic: 'content-telegram', patterns: [/\b(пост|datapine|канал|телеграм.?пост|draft|драфт|контент.?план)\b/i, /\b@datapine\b/] },
        { topic: 'content-youtube', patterns: [/\b(youtube|видео|ролик|сценарий|thumbnail|ютуб)\b/i] },
        { topic: 'content-instagram', patterns: [/\b(instagram|инстаграм|reels?|stories|story)\b/i] },
      ];

      let classified = 0;
      const tx = rw.transaction(() => {
        for (const msg of untagged) {
          const content = msg.content || '';
          for (const rule of rules) {
            if (rule.patterns.some(p => p.test(content))) {
              insert.run(msg.id, rule.topic);
              classified++;
              break;
            }
          }
        }
      });
      tx();

      res.json({ ok: true, total: untagged.length, classified });
    } catch (err) {
      console.error('POST /api/chat/auto-classify error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/bot-status - check if ClaudeClaw service is running
  // -------------------------------------------------------------------------
  app.get('/api/bot-status', (_req, res) => {
    try {
      const stateRoot = resolve(dbPath, '../..');
      const pidFile = resolve(stateRoot, 'store/service.pid');

      let pid: number | null = null;
      let alive = false;

      if (existsSync(pidFile)) {
        pid = Number(readFileSync(pidFile, 'utf-8').trim());
        // Check if process is running (signal 0 = existence check)
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e: unknown) {
          // EPERM = process exists but we lack permission (still alive)
          // ESRCH = no such process (dead)
          alive = (e as NodeJS.ErrnoException).code === 'EPERM';
        }
      }

      // Secondary alive signals (covers stale PID after unclean restart):
      // 1. Log file written in last 10 min (service writes on poll/dispatch/heartbeat)
      // 2. Bot message sent in last 10 min (only running service sends these)
      // 3. Agent run completed in last 10 min
      if (!alive) {
        const logFile = resolve(stateRoot, 'logs/claudeclaw.log');
        try {
          if (existsSync(logFile)) {
            const logStat = statSync(logFile);
            if (Date.now() - logStat.mtimeMs < 600_000) {
              alive = true;
            }
          }
        } catch {}
      }
      if (!alive) {
        try {
          const recentActivity = ro.prepare(
            `SELECT 1 FROM messages
             WHERE is_bot_message = 1 AND timestamp >= datetime('now', '-10 minutes')
             LIMIT 1`
          ).get();
          if (recentActivity) alive = true;
        } catch {}
      }
      if (!alive) {
        try {
          const recentRun = ro.prepare(
            "SELECT 1 FROM agent_runs WHERE run_at >= datetime('now', '-10 minutes') LIMIT 1"
          ).get();
          if (recentRun) alive = true;
        } catch {}
      }

      // Last agent run
      const lastRun = ro.prepare(
        'SELECT run_at, status, duration_ms, turns, model FROM agent_runs ORDER BY run_at DESC LIMIT 1'
      ).get() as { run_at: string; status: string; duration_ms: number; turns: number; model: string } | undefined;

      // Queue depth (messages not yet processed - approximation)
      const pendingMessages = ro.prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE is_bot_message = 0 AND is_from_me = 0
         AND timestamp > COALESCE((SELECT MAX(run_at) FROM agent_runs), '2000-01-01')`
      ).get() as { cnt: number };

      // Active session
      const session = ro.prepare(
        "SELECT session_id FROM sessions WHERE group_folder = 'personal'"
      ).get() as { session_id: string } | undefined;

      res.json({
        alive,
        pid,
        lastRun: lastRun || null,
        pendingMessages: pendingMessages.cnt,
        hasSession: !!session?.session_id,
      });
    } catch (err) {
      console.error('GET /api/bot-status error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/logs?lines=100 - tail log file
  // -------------------------------------------------------------------------
  app.get('/api/logs', (req, res) => {
    try {
      const stateRoot = resolve(dbPath, '../..');
      const logFile = resolve(stateRoot, 'logs/claudeclaw.log');
      const lines = Math.min(Number(req.query.lines) || 100, 500);

      if (!existsSync(logFile)) {
        res.json({ lines: [], file: logFile, exists: false });
        return;
      }

      const content = readFileSync(logFile, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const lastN = allLines.slice(-lines);

      // Strip ANSI escape codes
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

      // Parse pino JSON logs into readable format
      const parsed = lastN.map((line) => {
        const clean = stripAnsi(line);
        try {
          const obj = JSON.parse(clean);
          return {
            time: obj.time ? new Date(obj.time).toISOString() : '',
            level: obj.level <= 20 ? 'debug' : obj.level <= 30 ? 'info' : obj.level <= 40 ? 'warn' : 'error',
            msg: obj.msg || '',
            raw: clean,
          };
        } catch {
          // Non-JSON lines (pino-pretty output or plain text)
          const timeMatch = clean.match(/\[(\d{2}:\d{2}:\d{2}\.\d+)\]/);
          const levelMatch = clean.match(/\b(INFO|WARN|ERROR|DEBUG|FATAL)\b/);
          const msgMatch = clean.match(/(?:INFO|WARN|ERROR|DEBUG|FATAL)\s*(?:\(\d+\):)?\s*(.*)/);
          return {
            time: timeMatch ? timeMatch[1] : '',
            level: (levelMatch?.[1] || 'info').toLowerCase(),
            msg: msgMatch?.[1] || clean,
            raw: clean,
          };
        }
      });

      res.json({ lines: parsed, file: logFile, exists: true });
    } catch (err) {
      console.error('GET /api/logs error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
