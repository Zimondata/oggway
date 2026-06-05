/**
 * Stdio MCP Server for ClaudeClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

// Runtime-agnostic: sandbox sets CLAUDECLAW_IPC_DIR, container uses /workspace/ipc
const IPC_DIR = process.env.CLAUDECLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.CLAUDECLAW_CHAT_JID!;
const groupFolder = process.env.CLAUDECLAW_GROUP_FOLDER!;
const isMain = process.env.CLAUDECLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'claudeclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Memory tools — lightweight, file-based, QMD-upgradeable
// ---------------------------------------------------------------------------

const WORKSPACE_GROUP = process.env.CLAUDECLAW_GROUP_DIR || '/workspace/group';

/** Recursively find .md files under a directory */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

// Try QMD (BM25 + ranking). Returns formatted text or null on any failure.
async function qmdSearch(query: string, maxResults: number): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('qmd', ['search', query, '-c', 'memory', '-n', String(maxResults), '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(null); }, 5000);
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) return resolve(null);
      try {
        const arr = JSON.parse(stdout) as Array<{ file: string; score: number; title?: string; snippet?: string }>;
        if (!Array.isArray(arr) || arr.length === 0) return resolve(null);
        const lines = arr.map((r) => {
          const rel = (r.file || '').replace(/^qmd:\/\/memory\//, '').replace(/^qmd:\/\/[^/]+\//, '');
          const pct = Math.round((r.score || 0) * 100);
          const snip = (r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300);
          return `${rel} (${pct}%): ${snip}`;
        });
        resolve(`Found ${arr.length} matches (qmd BM25):\n\n${lines.join('\n\n')}`);
      } catch {
        resolve(null);
      }
    });
  });
}

server.tool(
  'memory_search',
  `Search across all memory files (CLAUDE.md, daily logs, topics, archived conversations) for matching content. Uses qmd BM25 ranking when available, falls back to grep. Returns ranked matches with file paths and context. Use this to recall past decisions, facts, or conversation details.`,
  {
    query: z.string().describe('Search query — keywords or phrase to find in memory files'),
    max_results: z.number().default(20).describe('Maximum number of matching lines to return'),
  },
  async (args) => {
    // Try qmd first (BM25 + scoring). Falls back silently on any failure.
    const qmdResult = await qmdSearch(args.query, args.max_results);
    if (qmdResult) {
      return { content: [{ type: 'text' as const, text: qmdResult }] };
    }

    // Fallback: legacy grep over markdown files
    const searchDirs = [WORKSPACE_GROUP];
    const allFiles = searchDirs.flatMap(findMarkdownFiles);

    if (allFiles.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memory files found.' }] };
    }

    const queryLower = args.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);
    const results: { file: string; line: number; text: string; score: number }[] = [];

    for (const filePath of allFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const relPath = path.relative(WORKSPACE_GROUP, filePath);

        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          // Score: count how many query terms match
          const score = queryTerms.filter((t) => lineLower.includes(t)).length;
          if (score > 0) {
            results.push({ file: relPath, line: i + 1, text: lines[i].trim(), score });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by score descending, take top N
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, args.max_results);

    if (top.length === 0) {
      return { content: [{ type: 'text' as const, text: `No matches found for "${args.query}".` }] };
    }

    const formatted = top
      .map((r) => `${r.file}:${r.line}: ${r.text}`)
      .join('\n');

    return {
      content: [{ type: 'text' as const, text: `Found ${top.length} matches (grep fallback, of ${results.length} total):\n\n${formatted}` }],
    };
  },
);

server.tool(
  'memory_save',
  `Save a fact/note to AGENT'S OWN persistent memory (memory/, NOT user-facing content).

⚠️ THIS IS FOR AGENT WORKING MEMORY ONLY. For content meant for the user to read later (video summaries, research notes, articles, project documentation, references) use the Write tool with a path under the Obsidian vault (/Users/pine/Library/Mobile Documents/iCloud~md~obsidian/Documents/Myvault/, typically 04-Resources/<topic>-<date>.md or 02-Projects/<project>/<note>.md).

Categories below are for INTERNAL agent memory:
• "daily" — append to today's daily log (memory/daily/YYYY-MM-DD.md). For transient agent state, action log, daily events YOU performed.
• "topic" — append to memory/topics/{topic}.md. For ROLLING/CALIBRATION state YOU need (lessons-learned, coverage logs, ongoing-task tracking). NOT for user content like video summaries.
• "longterm" — append to MEMORY.md (curated, loaded every session). For durable facts about the user, your role, available tools.

Rule of thumb: if the user might want to read this in 3 months → vault via Write. If it's data you yourself need to reference next session → memory_save.`,
  {
    content: z.string().describe('The fact, note, or decision to save'),
    category: z.enum(['daily', 'topic', 'longterm']).describe('Where to save: daily log, topic file, or long-term MEMORY.md'),
    topic: z.string().optional().describe('Topic name (required when category="topic", e.g., "project-alpha", "user-preferences")'),
  },
  async (args) => {
    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];
    let filePath: string;
    let label: string;

    if (args.category === 'daily') {
      filePath = path.join(WORKSPACE_GROUP, 'memory', 'daily', `${date}.md`);
      label = `memory/daily/${date}.md`;
    } else if (args.category === 'topic') {
      if (!args.topic) {
        return { content: [{ type: 'text', text: 'Error: topic name is required when category="topic". Provide a topic parameter.' }] };
      }
      const safeTopic = args.topic.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      filePath = path.join(WORKSPACE_GROUP, 'memory', 'topics', `${safeTopic}.md`);
      label = `memory/topics/${safeTopic}.md`;
    } else {
      filePath = path.join(WORKSPACE_GROUP, 'MEMORY.md');
      label = 'MEMORY.md';
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Add header if file is new
    if (!fs.existsSync(filePath)) {
      if (args.category === 'daily') {
        fs.writeFileSync(filePath, `# Memory — ${date}\n\n`);
      } else if (args.category === 'topic' && args.topic) {
        fs.writeFileSync(filePath, `# ${args.topic}\n\n`);
      }
    }

    fs.appendFileSync(filePath, `- [${timestamp.split('T')[1].split('.')[0]}] ${args.content}\n`);

    return {
      content: [{ type: 'text' as const, text: `Saved to ${label}` }],
    };
  },
);

server.tool(
  'memory_get',
  `Read a specific memory file. Returns empty text if the file doesn't exist (no error). Use for reading daily logs, topic files, or the main CLAUDE.md.`,
  {
    file: z.string().describe('Relative path from group root, e.g., "memory/2026-03-21.md", "memory/topics/project-alpha.md", "CLAUDE.md"'),
  },
  async (args) => {
    // Prevent directory traversal
    const normalized = path.normalize(args.file);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return {
        content: [{ type: 'text' as const, text: '' }],
      };
    }

    const filePath = path.join(WORKSPACE_GROUP, normalized);

    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: 'text' as const, text: '' }],
      };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: '' }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Wiki tools — Karpathy LLM Wiki pattern read path (Obsidian vault)
// ---------------------------------------------------------------------------

const VAULT_ROOT = process.env.VAULT_ROOT || process.env.OBSIDIAN_VAULT || '';

/**
 * Resolve a topic query to candidate wiki page paths inside the vault.
 * Path-first heuristic ordered by canonical wiki layer:
 *   05-People/<topic>.md
 *   04-Resources/concepts/<topic>.md
 *   10-MOC/MOC-<topic>.md  /  10-MOC/<topic>.md
 *   09-Decisions/*<topic>*.md
 * Falls back to filename substring match across vault.
 */
function resolveWikiPaths(vault: string, topic: string): string[] {
  const out: string[] = [];
  const safe = topic.trim();
  const candidates = [
    path.join(vault, '05-People', `${safe}.md`),
    path.join(vault, '04-Resources', 'concepts', `${safe}.md`),
    path.join(vault, '10-MOC', `MOC-${safe}.md`),
    path.join(vault, '10-MOC', `${safe}.md`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) out.push(c);
  }
  // Fuzzy fallback: filename contains topic (case-insensitive)
  if (out.length === 0) {
    const all = findMarkdownFiles(vault);
    const needle = safe.toLowerCase();
    for (const f of all) {
      const base = path.basename(f, '.md').toLowerCase();
      if (base === needle || base.includes(needle)) out.push(f);
      if (out.length >= 5) break;
    }
  }
  return out;
}

/** Extract `[[wikilinks]]` from page body for 1-hop expansion. */
function extractWikilinks(body: string): string[] {
  const set = new Set<string>();
  const re = /\[\[([^\]|]+?)(\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    set.add(m[1].trim());
  }
  return Array.from(set);
}

server.tool(
  'wiki_read',
  `Read a wiki page from the Obsidian vault using Karpathy LLM Wiki pattern.

Resolution order (path-first - 80% of queries hit here):
1. 05-People/<topic>.md      - entity pages (one file = one person)
2. 04-Resources/concepts/<topic>.md - frameworks/methods/ideas
3. 10-MOC/MOC-<topic>.md     - Maps of Content
4. Fuzzy filename match across vault

Returns the page content plus list of 1-hop wikilinks for further navigation.
If multiple candidates match, returns all of them.

Use BEFORE memory_search for any topic that should have a canonical wiki page (people, projects, concepts, decisions). memory_search is grep fallback for unstructured notes.`,
  {
    topic: z.string().describe('Topic to look up: person name, project name, concept, or MOC topic. E.g. "Btchit", "ClaudeClaw", "local-ai-vram", "Health"'),
    expand_links: z.boolean().default(false).describe('If true, also fetch first 200 chars of each linked page for context'),
  },
  async (args) => {
    if (!VAULT_ROOT || !fs.existsSync(VAULT_ROOT)) {
      return { content: [{ type: 'text' as const, text: 'wiki_read: VAULT_ROOT env var not set or directory missing. Set VAULT_ROOT in .env to the Obsidian vault path.' }] };
    }

    const matches = resolveWikiPaths(VAULT_ROOT, args.topic);
    if (matches.length === 0) {
      return { content: [{ type: 'text' as const, text: `No wiki page found for "${args.topic}". Try memory_search as grep fallback, or create the page.` }] };
    }

    const sections: string[] = [];
    for (const filePath of matches) {
      try {
        const body = fs.readFileSync(filePath, 'utf-8');
        const rel = path.relative(VAULT_ROOT, filePath);
        sections.push(`### ${rel}\n\n${body}`);

        if (args.expand_links) {
          const links = extractWikilinks(body);
          if (links.length > 0) {
            const linkPreviews: string[] = [];
            for (const link of links.slice(0, 8)) {
              const linkPaths = resolveWikiPaths(VAULT_ROOT, link);
              if (linkPaths.length > 0) {
                try {
                  const preview = fs.readFileSync(linkPaths[0], 'utf-8').slice(0, 200);
                  linkPreviews.push(`- [[${link}]]: ${preview.replace(/\n/g, ' ')}...`);
                } catch { /* skip */ }
              }
            }
            if (linkPreviews.length > 0) {
              sections.push(`#### Linked refs (1-hop)\n\n${linkPreviews.join('\n')}`);
            }
          }
        }
      } catch (e) {
        sections.push(`### ${filePath}\n\n[read error: ${(e as Error).message}]`);
      }
    }

    return { content: [{ type: 'text' as const, text: sections.join('\n\n---\n\n') }] };
  },
);

server.tool(
  'wiki_search',
  `Grep-search across the Obsidian vault. Returns matching lines with file paths.
Use for unstructured queries that don't map cleanly to a person/concept/MOC. For canonical lookups (person, project, concept) use wiki_read first - it's faster and more focused.`,
  {
    query: z.string().describe('Search query - keywords or phrase'),
    max_results: z.number().default(20).describe('Maximum matching lines to return'),
  },
  async (args) => {
    if (!VAULT_ROOT || !fs.existsSync(VAULT_ROOT)) {
      return { content: [{ type: 'text' as const, text: 'wiki_search: VAULT_ROOT env var not set.' }] };
    }
    const allFiles = findMarkdownFiles(VAULT_ROOT);
    if (allFiles.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No vault files found.' }] };
    }
    const queryLower = args.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);
    const results: { file: string; line: number; text: string; score: number }[] = [];
    for (const filePath of allFiles) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const relPath = path.relative(VAULT_ROOT, filePath);
        for (let i = 0; i < lines.length; i++) {
          const lineLower = lines[i].toLowerCase();
          const score = queryTerms.filter((t) => lineLower.includes(t)).length;
          if (score > 0) {
            results.push({ file: relPath, line: i + 1, text: lines[i].trim(), score });
          }
        }
      } catch { /* skip */ }
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, args.max_results);
    if (top.length === 0) {
      return { content: [{ type: 'text' as const, text: `No vault matches for "${args.query}".` }] };
    }
    const formatted = top.map((r) => `${r.file}:${r.line}: ${r.text}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Vault matches (${top.length} of ${results.length}):\n\n${formatted}` }] };
  },
);

server.tool(
  'wiki_index',
  `Read the vault catalog (_index.md) - lists all canonical wiki pages by category (People, Concepts, MOC, Decisions). Use as starting point when topic is unclear.`,
  {},
  async () => {
    if (!VAULT_ROOT) {
      return { content: [{ type: 'text' as const, text: 'wiki_index: VAULT_ROOT not set.' }] };
    }
    const indexPath = path.join(VAULT_ROOT, '_index.md');
    if (!fs.existsSync(indexPath)) {
      return { content: [{ type: 'text' as const, text: 'wiki_index: _index.md not found in vault root. Bootstrap vault first.' }] };
    }
    return { content: [{ type: 'text' as const, text: fs.readFileSync(indexPath, 'utf-8') }] };
  },
);

// ---------------------------------------------------------------------------
// Grip System — confidence scoring with decay for long-term memory
// ---------------------------------------------------------------------------

const GRIP_INDEX_PATH = path.join(WORKSPACE_GROUP, 'memory', 'topics', 'grip-index.md');

server.tool(
  'memory_grip',
  `Confirm or adjust the "grip" (confidence 1-5) on a fact in long-term memory.

The Grip System tracks how firmly we hold each fact:
  5 = ironclad, confirmed many times
  4 = solid, confirmed recently
  3 = default for new facts
  2 = getting stale, not confirmed in a while
  1 = about to drop, needs confirmation or removal
  0 = dropped by weekly Grip Sweep

Use this when you reference a MEMORY.md fact and it turns out correct (grip_boost),
or when you discover a fact is outdated/wrong (set grip to 1 or remove it).

The weekly GRIP-SWEEP task automatically rusts (decrements) entries not confirmed in 14+ days.`,
  {
    fact: z.string().describe('Short identifier of the fact (must match an entry in grip-index.md)'),
    action: z.enum(['boost', 'set', 'add']).describe('boost = +1 (max 5), set = override to specific value, add = register new fact'),
    grip: z.number().optional().describe('Required for "set" and "add" actions. Grip value 1-5'),
    section: z.string().optional().describe('MEMORY.md section this fact belongs to (for "add" action)'),
  },
  async (args) => {
    fs.mkdirSync(path.dirname(GRIP_INDEX_PATH), { recursive: true });

    const today = new Date().toISOString().split('T')[0];

    // Read existing index
    let lines: string[] = [];
    if (fs.existsSync(GRIP_INDEX_PATH)) {
      lines = fs.readFileSync(GRIP_INDEX_PATH, 'utf-8').split('\n');
    } else {
      lines = ['# Grip Index', '# grip | last-confirmed | fact | section', ''];
    }

    if (args.action === 'add') {
      const gripVal = Math.min(5, Math.max(1, args.grip ?? 3));
      lines.push(`${gripVal} | ${today} | ${args.fact} | ${args.section || 'unknown'}`);
      fs.writeFileSync(GRIP_INDEX_PATH, lines.join('\n'));
      return { content: [{ type: 'text' as const, text: `Added "${args.fact}" with grip ${gripVal}` }] };
    }

    // Find matching line
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#') || !lines[i].includes('|')) continue;
      const parts = lines[i].split('|').map(s => s.trim());
      if (parts.length < 3) continue;

      // Match by substring of fact field
      if (parts[2].toLowerCase().includes(args.fact.toLowerCase())) {
        let currentGrip = parseInt(parts[0], 10) || 3;

        if (args.action === 'boost') {
          currentGrip = Math.min(5, currentGrip + 1);
        } else if (args.action === 'set') {
          currentGrip = Math.min(5, Math.max(0, args.grip ?? currentGrip));
        }

        lines[i] = `${currentGrip} | ${today} | ${parts[2]} | ${parts[3] || 'unknown'}`;
        found = true;
        fs.writeFileSync(GRIP_INDEX_PATH, lines.join('\n'));
        return { content: [{ type: 'text' as const, text: `Grip on "${parts[2]}" ${args.action === 'boost' ? 'boosted to' : 'set to'} ${currentGrip}` }] };
      }
    }

    if (!found) {
      return { content: [{ type: 'text' as const, text: `Fact "${args.fact}" not found in grip-index. Use action="add" to register it first.` }] };
    }

    return { content: [{ type: 'text' as const, text: 'Done' }] };
  },
);

// ---------------------------------------------------------------------------
// Self-heal — report & approve incidents, processed by orchestrator
// ---------------------------------------------------------------------------

const INCIDENTS_DIR = path.join(WORKSPACE_GROUP, 'incidents');

server.tool(
  'report_incident',
  `Report a bug in ClaudeClaw itself (not a user error, not a domain issue). Use this when you believe the orchestrator/channel/runner code has a defect — e.g. you see the same unexpected error across multiple attempts, a tool behaves inconsistently with its docs, or a capability that should work is failing for reasons outside a user's control.

Writes an incident file. The user must separately approve with approve_incident(id) before any fix runs. A fixer-Claude then edits src/, runs tests, commits, restarts the service, and reports back.

Do NOT use for:
- User asked you to do something you can't / shouldn't (that's a conversation, not an incident)
- External services are down (Garmin API 503) — that's not our code
- You don't have a tool and need to install it — just install it`,
  {
    title: z.string().describe('Short one-line summary of the bug'),
    symptoms: z.string().describe('What you observe — errors, wrong behavior, what you expected vs what happened'),
    reproduction: z.string().describe('How to reproduce — exact steps or conditions that trigger it'),
    proposed_fix: z.string().describe('Your best guess at the fix — which file(s), what change, why'),
    logs: z.string().optional().describe('Relevant log excerpts, stack traces, error messages (paste verbatim)'),
  },
  async (args) => {
    fs.mkdirSync(INCIDENTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = path.join(INCIDENTS_DIR, `${id}.md`);

    const body = [
      `# Incident ${id}`,
      '',
      `**Group:** ${groupFolder}  `,
      `**Chat:** ${chatJid}  `,
      `**Reported:** ${new Date().toISOString()}  `,
      `**Status:** pending_approval`,
      '',
      `## Title`,
      args.title,
      '',
      `## Symptoms`,
      args.symptoms,
      '',
      `## Reproduction`,
      args.reproduction,
      '',
      `## Proposed fix`,
      args.proposed_fix,
      '',
    ];
    if (args.logs) {
      body.push('## Logs', '```', args.logs, '```', '');
    }
    fs.writeFileSync(filePath, body.join('\n'));

    return {
      content: [{ type: 'text' as const, text: `Incident ${id} saved. Tell the user: "Zaregistriroval incident ${id}. Approve s komandoy approve_incident('${id}') — ya togda pozovu fixer-Claude; on pochinit, protestiruet, zadeployit i doložit."` }],
    };
  },
);

server.tool(
  'approve_incident',
  `Approve an incident for automatic repair. Call this only when the USER explicitly agreed to the fix ("fix it", "go", "делай", "да", "поехали" as a clear response to your incident report). Writes an .APPROVED marker. The orchestrator file-watcher then spawns a fixer-Claude process with full repo write access — it will edit src/, run tests, commit, restart the service, and report back.

NEVER self-approve. The user must be the one saying yes.`,
  {
    id: z.string().describe('The incident id from report_incident (e.g. "2026-04-17T09-15-03-0000Z-abc123")'),
  },
  async (args) => {
    const mdPath = path.join(INCIDENTS_DIR, `${args.id}.md`);
    if (!fs.existsSync(mdPath)) {
      return {
        content: [{ type: 'text' as const, text: `Incident ${args.id} not found.` }],
        isError: true,
      };
    }
    const approvedPath = path.join(INCIDENTS_DIR, `${args.id}.APPROVED`);
    fs.writeFileSync(approvedPath, new Date().toISOString());
    return {
      content: [{ type: 'text' as const, text: `Incident ${args.id} approved. Fixer-Claude starts within ~15s; you'll get a Telegram update when it finishes (or fails).` }],
    };
  },
);

server.tool(
  'list_incidents',
  `List recent incidents in this group, with their status (pending, approved, fixed, failed).`,
  {
    max: z.number().default(10).describe('Max number of incidents to list'),
  },
  async (args) => {
    if (!fs.existsSync(INCIDENTS_DIR)) {
      return { content: [{ type: 'text' as const, text: 'No incidents yet.' }] };
    }
    const entries = fs.readdirSync(INCIDENTS_DIR);
    const ids = new Set<string>();
    for (const name of entries) {
      const match = name.match(/^(.+?)\.(md|APPROVED|FIXED|FAILED)$/);
      if (match) ids.add(match[1]);
    }
    const rows = Array.from(ids)
      .sort()
      .reverse()
      .slice(0, args.max)
      .map((id) => {
        const has = (suffix: string) => fs.existsSync(path.join(INCIDENTS_DIR, `${id}.${suffix}`));
        const status = has('FIXED') ? 'fixed' : has('FAILED') ? 'failed' : has('APPROVED') ? 'approved' : 'pending';
        return `${id} — ${status}`;
      });
    return {
      content: [{ type: 'text' as const, text: rows.length ? rows.join('\n') : 'No incidents yet.' }],
    };
  },
);

// ---------------------------------------------------------------------------
// Skills — capture and recall reusable approaches across runs
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.join(WORKSPACE_GROUP, 'skills');

interface SkillFrontmatter {
  id?: string;
  name?: string;
  version?: number;
  utility_score?: number;
  success_count?: number;
  failure_count?: number;
  created_at?: string;
  updated_at?: string;
}

function parseSkillFile(filePath: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;
    const fm: SkillFrontmatter = {};
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1] as keyof SkillFrontmatter;
      const value = kv[2].trim();
      if (key === 'utility_score' || key === 'version' || key === 'success_count' || key === 'failure_count') {
        (fm as Record<string, number | string>)[key] = Number(value);
      } else {
        (fm as Record<string, number | string>)[key] = value;
      }
    }
    return { frontmatter: fm, body: match[2] };
  } catch {
    return null;
  }
}

function listSkillFiles(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(SKILLS_DIR, f));
}

server.tool(
  'skill_save',
  `Save a reusable skill from a non-trivial task you just solved. ONLY call when ALL of the following are true:
- Task took >5 turns
- You used >2 different tools (e.g., Bash + Read + Edit, not just WebSearch)
- The approach is reusable for similar future problems

Skills are merged on duplicate name or near-identical problem (first 200 chars). Don't worry about overwriting — duplicates auto-merge with version bump.`,
  {
    name: z.string().describe('Short kebab-case identifier (e.g., "sandbox-network-debug", "tacx-bluetooth-pairing"). Lowercase, alphanumeric+hyphens only.'),
    problem: z.string().describe('What problem this skill solves. Frame as a recognizable situation an agent will encounter again.'),
    approach: z.string().describe('Concrete steps that worked. Include commands, file paths, settings — enough that future-you can re-execute without re-research.'),
    gotchas: z.string().optional().describe('Pitfalls, error messages, things you tried first that did not work, edge cases. Optional but valuable.'),
    files_touched: z.array(z.string()).optional().describe('Specific file paths involved (e.g., ["src/orchestrator/db.ts", ".env"]). Optional.'),
  },
  async (args) => {
    const data = {
      type: 'skill_save',
      groupFolder,
      name: args.name,
      problem: args.problem,
      approach: args.approach,
      gotchas: args.gotchas,
      filesTouched: args.files_touched,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{
        type: 'text' as const,
        text: `Skill "${args.name}" save requested. Will be persisted to skills/${args.name}.md (or merged into existing).`,
      }],
    };
  },
);

server.tool(
  'skill_search',
  `Search this group's skill library for skills relevant to a query. Returns top matches ranked by query match + utility score. Use at the start of a task to recall prior approaches.`,
  {
    query: z.string().describe('Description of what you are trying to do (e.g., "debug sandbox network", "set up tacx trainer")'),
    top_k: z.number().default(3).describe('Maximum number of skills to return'),
  },
  async (args) => {
    const files = listSkillFiles();
    if (files.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No skills saved yet.' }] };
    }
    const queryLower = args.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length >= 3);
    if (queryTerms.length === 0) {
      return { content: [{ type: 'text' as const, text: 'Query too short — use 3+ character terms.' }] };
    }

    const scored: { name: string; score: number; matchCount: number; utility: number; body: string; id: string }[] = [];
    for (const filePath of files) {
      const parsed = parseSkillFile(filePath);
      if (!parsed) continue;
      const text = (parsed.body + ' ' + (parsed.frontmatter.name ?? '')).toLowerCase();
      const matchCount = queryTerms.filter((t) => text.includes(t)).length;
      if (matchCount === 0) continue;
      const utility = parsed.frontmatter.utility_score ?? 1.0;
      scored.push({
        name: parsed.frontmatter.name ?? path.basename(filePath, '.md'),
        id: parsed.frontmatter.id ?? '',
        score: matchCount + utility * 0.1,
        matchCount,
        utility,
        body: parsed.body.trim(),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, args.top_k);
    if (top.length === 0) {
      return { content: [{ type: 'text' as const, text: `No skills match "${args.query}".` }] };
    }

    const formatted = top
      .map((s) => `## ${s.name} (utility: ${s.utility.toFixed(2)}, id: ${s.id})\n${s.body}`)
      .join('\n\n---\n\n');
    return { content: [{ type: 'text' as const, text: `Found ${top.length} skills:\n\n${formatted}` }] };
  },
);

server.tool(
  'skill_list',
  `List all skills saved in this group, ordered by utility score. Use to audit what's saved.`,
  {},
  async () => {
    const files = listSkillFiles();
    if (files.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No skills saved yet.' }] };
    }
    const entries = files
      .map((filePath) => {
        const parsed = parseSkillFile(filePath);
        if (!parsed) return null;
        const fm = parsed.frontmatter;
        return {
          name: fm.name ?? path.basename(filePath, '.md'),
          utility: fm.utility_score ?? 1.0,
          version: fm.version ?? 1,
          successes: fm.success_count ?? 0,
          failures: fm.failure_count ?? 0,
          updatedAt: fm.updated_at ?? '',
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.utility - a.utility);

    const rows = entries.map(
      (e) => `- ${e.name} (v${e.version}) — utility ${e.utility.toFixed(2)}, ${e.successes}/${e.successes + e.failures} success, updated ${e.updatedAt.split('T')[0]}`,
    );
    return { content: [{ type: 'text' as const, text: `Skills (${entries.length}):\n${rows.join('\n')}` }] };
  },
);

// ---------------------------------------------------------------------------
// Service control — restart the orchestrator (main group only)
// ---------------------------------------------------------------------------

server.tool(
  'restart_service',
  `Restart the ClaudeClaw orchestrator service. Main group only.

Use this AFTER you have edited source files in src/ or agent/runner/src/ to apply your changes. The service exits cleanly and launchd / systemd auto-respawns it (KeepAlive). Active sandbox runs are aborted; queued tasks resume after restart.

The orchestrator handles the build step before exit, so set rebuild=true (default) when you've changed TypeScript. Set rebuild=false only if you know the dist/ output is already current (e.g. just toggled a setting).

Reasons should be specific: the value goes into logs and serves as the audit trail. Examples: "applied multi-model routing fix", "wired skill_save dedup".`,
  {
    reason: z.string().describe('Short why-string for the audit log (e.g. "applied browser MCP fix"). Required.'),
    rebuild: z.boolean().default(true).describe('Run `npm run build` before exit. Set false only if dist/ is already up-to-date.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'restart_service is restricted to the main control group.' }],
        isError: true,
      };
    }
    const data = {
      type: 'restart_service',
      reason: args.reason,
      rebuild: args.rebuild,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{
        type: 'text' as const,
        text: `Restart requested: ${args.reason}${args.rebuild ? ' (with rebuild)' : ' (no rebuild)'}. Service will exit in ~3s and launchd will respawn it.`,
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Subagent delegation — spawn a child agent for a discrete task
// ---------------------------------------------------------------------------

const SUBAGENT_RESULTS_DIR = path.join(IPC_DIR, 'subagent-results');

server.tool(
  'delegate_task',
  `Spawn a child agent (subagent) to handle a discrete task in isolation. Returns the child's structured result. Main group only.

When to use:
- Parallel research (3 subagents search different regions independently)
- Specialised sub-roles (one debugs, one writes content)
- Batch operations where each item needs its own cost cap
- Long-running task you want to execute without blocking the parent

Inheritance:
- Subagent gets your group folder (shared memory + skills)
- Same credentials and allowed domains as you
- Fresh isolated session (no parent conversation history)

Limits:
- Max recursion depth 3 (subagent of subagent of subagent allowed; deeper rejected)
- Hard wall-clock timeout via timeout_minutes (default 10)`,
  {
    prompt: z.string().describe('What the subagent should do. Be specific — it has no parent conversation context.'),
    model: z.enum(['haiku', 'sonnet', 'opus']).optional().describe('Force a model. Otherwise auto-routed by content.'),
    max_turns: z.number().default(15).describe('Maximum turns in the subagent run'),
    timeout_minutes: z.number().default(10).describe('Wall-clock timeout in minutes'),
    inherit_skills: z.boolean().default(true).describe('Make parent skill registry visible to subagent'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'delegate_task is restricted to the main control group.' }],
        isError: true,
      };
    }

    const subagentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'delegate_task',
      subagentId,
      parentGroupFolder: groupFolder,
      parentChatJid: chatJid,
      prompt: args.prompt,
      model: args.model,
      maxTurns: args.max_turns,
      timeoutMinutes: args.timeout_minutes,
      inheritSkills: args.inherit_skills,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);

    // Wait for the result file written by the host. Poll every second up to
    // (timeout_minutes + 1) so we don't return before the child can finish.
    const resultFile = path.join(SUBAGENT_RESULTS_DIR, `${subagentId}.json`);
    const maxWaitMs = (args.timeout_minutes + 1) * 60 * 1000;
    const pollMs = 1000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (fs.existsSync(resultFile)) {
        try {
          const raw = fs.readFileSync(resultFile, 'utf-8');
          const parsed = JSON.parse(raw) as { status: string; output: string; error?: string; durationMs: number; turns?: number };
          // Cleanup result file once consumed
          try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
          if (parsed.status === 'error') {
            return {
              content: [{ type: 'text' as const, text: `Subagent ${subagentId} failed: ${parsed.error || 'unknown error'}\n\nPartial output: ${parsed.output || '(none)'}` }],
              isError: true,
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: `Subagent ${subagentId} completed (${parsed.durationMs}ms, ${parsed.turns ?? '?'} turns):\n\n${parsed.output}`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Subagent ${subagentId}: failed to read result file: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [{ type: 'text' as const, text: `Subagent ${subagentId}: timed out waiting for result after ${args.timeout_minutes} minutes.` }],
      isError: true,
    };
  },
);

// ===========================================================================
// HELPER TOOLS — cheap haiku-powered "scouts" the main agent (opus) can call
// for trivial parsing/extraction/classification. These are NOT for thinking
// or writing — they exist so opus can offload mechanical text-shuffling
// without spawning a full subagent. Each call ~$0.0001, ~300-700ms.
// ===========================================================================

const HAIKU_MODEL = 'claude-haiku-4-5';
const HELPER_TIMEOUT_MS = 8_000;

async function callHaiku(systemPrompt: string, userPrompt: string, maxTokens = 800): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let token = apiKey;
  let isApiKey = !!apiKey;
  if (!token) {
    // OAuth token from env (sandbox passes it via CLAUDE_CODE_OAUTH_TOKEN)
    token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
    isApiKey = false;
  }
  if (!token) return null;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (isApiKey) {
    headers['x-api-key'] = token;
  } else {
    headers['authorization'] = `Bearer ${token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HELPER_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content?.[0]?.text || '').trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

server.tool(
  'helper_extract',
  `Extract structured items from a chunk of text using Haiku (fast/cheap scout). Use this when YOU (Opus) need to pull URLs, dates, people, action items, or topics out of a chat dump or long message — instead of doing it yourself in a turn.

Input: any text. Output: bullet list of the requested items, one per line.

Use cases:
- "From this 50-message chat, extract all URLs the user shared"
- "Pull all dates mentioned in this voice transcript"
- "List action items from these bullet notes"
- "What topics did the user complain about in the last 100 lines?"

DON'T use for: writing, summarising opinions, judgment calls. For those, do it yourself.`,
  {
    text: z.string().describe('The source text to scan'),
    extract: z.string().describe('What to extract: "urls", "dates", "people", "action items", "topics", or any specific category like "github repos mentioned"'),
  },
  async (args) => {
    const system = `You are an extraction scout. Scan the user-provided text and return ONLY items matching the requested category, one per line, no commentary, no headers, no numbering. If nothing matches, reply with single dash "-".`;
    const userPrompt = `Extract: ${args.extract}\n\n--- TEXT ---\n${args.text.slice(0, 20000)}`;
    const result = await callHaiku(system, userPrompt, 600);
    if (result == null) {
      return {
        content: [{ type: 'text' as const, text: 'helper_extract failed (network or auth). Do the extraction yourself.' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: result }] };
  },
);

server.tool(
  'helper_summarize',
  `Compress long text to a short summary using Haiku. Use this when YOU (Opus) need to fit a long document into your reasoning context but don't need every word.

Input: long text + target length. Output: terse summary preserving facts.

Use cases:
- "Summarise this 5000-word transcript to 200 words for context"
- "Boil this user voice rant down to its 3 actionable points"
- "TL;DR this article so I can decide if it's worth deep-reading"

The summary is for YOUR reasoning, not user output. After getting it, decide what to do (write to vault, reply to user, etc).`,
  {
    text: z.string().describe('Text to compress'),
    target_words: z.number().default(150).describe('Approximate target length in words (default 150)'),
    focus: z.string().optional().describe('Optional angle: "key decisions", "risks", "action items", etc'),
  },
  async (args) => {
    const focusHint = args.focus ? ` Focus on: ${args.focus}.` : '';
    const system = `You are a compression scout. Summarise the user-provided text in approximately ${args.target_words} words.${focusHint} Preserve concrete facts, names, numbers, decisions. Drop pleasantries and repetition. Plain prose, no headers.`;
    const userPrompt = args.text.slice(0, 50000);
    const maxTokens = Math.max(200, Math.min(2000, Math.round(args.target_words * 4)));
    const result = await callHaiku(system, userPrompt, maxTokens);
    if (result == null) {
      return {
        content: [{ type: 'text' as const, text: 'helper_summarize failed (network or auth). Do the summary yourself.' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: result }] };
  },
);

server.tool(
  'helper_classify',
  `Pick ONE category from a fixed list that best fits the input, using Haiku. Use this when YOU (Opus) need to route/triage but don't need to defend the choice.

Input: text + category list. Output: exactly one category name.

Use cases:
- "Is this user message a question, a complaint, or a request?"
- "Does this voice transcript belong to: health / content / work / personal?"
- "Which folder in vault should this note go to: 02-Projects / 03-Areas / 04-Resources?"

If none of the categories fit cleanly, the helper returns "OTHER".`,
  {
    text: z.string().describe('Text to classify'),
    categories: z.array(z.string()).min(2).max(8).describe('Candidate categories (2-8). One will be chosen.'),
  },
  async (args) => {
    const cats = args.categories.join(' | ');
    const system = `You are a classifier scout. Read the user text and pick exactly ONE category from the provided list that best fits. Reply with just the chosen category name, nothing else. If none fit, reply with "OTHER".`;
    const userPrompt = `Categories: ${cats}\n\n--- TEXT ---\n${args.text.slice(0, 10000)}`;
    const result = await callHaiku(system, userPrompt, 30);
    if (result == null) {
      return {
        content: [{ type: 'text' as const, text: 'helper_classify failed (network or auth). Decide yourself.' }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: result }] };
  },
);

server.tool(
  'send_document',
  `Send a file (markdown, PDF, image, etc) to the user's chat as a Telegram document attachment. Use this when the user asks for "скинь файлом", "пришли markdown", "send the file", etc.

The file path must be absolute and accessible. Vault and group folder paths work directly. After this tool succeeds the file appears in chat as a downloadable document.

Example use cases:
- User asks "скинь мне в чат README markdown" → send_document({path: "/path/to/README.md"})
- User asks for a transcript file → send_document({path: ".../youtube-transcript.md", caption: "Транскрипт за 20 минут"})
- Generated report → send_document({path: ".../report-2026-05-05.md"})

Don't use for: short text replies (use send_message), images you've just generated and want to describe (just describe in text — Telegram won't preview markdown anyway).`,
  {
    path: z.string().describe('Absolute path to the file to send'),
    caption: z.string().optional().describe('Optional short caption shown above the file in chat (max ~1000 chars)'),
  },
  async (args) => {
    if (!fs.existsSync(args.path)) {
      return {
        content: [{ type: 'text' as const, text: `send_document failed: file not found at ${args.path}` }],
        isError: true,
      };
    }
    const data: Record<string, string | undefined> = {
      type: 'document',
      chatJid,
      filePath: args.path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: `Document queued: ${args.path}${args.caption ? ` (caption: "${args.caption.slice(0, 60)}")` : ''}` }] };
  },
);

// ===========================================================================
// TODO TOOL — persistent task list that survives context compression.
// Pattern from Hermes Agent. The killer feature: after context compaction
// the orchestrator re-injects active items so you NEVER lose your plan.
// ===========================================================================

const TODO_FILE = path.join(process.env.CLAUDECLAW_GROUP_DIR || '/workspace/group', '.todos.json');

interface TodoFileFmt {
  next_id: number;
  todos: Array<{
    id: number;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    created_at: string;
    updated_at: string;
  }>;
}

function readTodos(): TodoFileFmt {
  if (!fs.existsSync(TODO_FILE)) return { next_id: 1, todos: [] };
  try {
    const raw = fs.readFileSync(TODO_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.todos || !Array.isArray(parsed.todos)) {
      return { next_id: 1, todos: [] };
    }
    return parsed;
  } catch {
    return { next_id: 1, todos: [] };
  }
}

function writeTodos(data: TodoFileFmt): void {
  fs.mkdirSync(path.dirname(TODO_FILE), { recursive: true });
  const tmp = `${TODO_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, TODO_FILE);
}

server.tool(
  'todo',
  `Your persistent task list. Survives context compaction (orchestrator re-injects active items after every compression event).

Use this for any task with 3+ steps OR work spanning multiple turns. Without it, after a long conversation the model loses the plan when context gets compressed.

Rules:
- Only ONE item can be in_progress at a time. If you set a new one, the previous in_progress becomes pending automatically.
- Mark items completed AS SOON as you finish them — don't batch.
- Statuses: pending | in_progress | completed | cancelled.
- Items without explicit id are appended; with id they update existing.

Examples:
- New plan: todo({ todos: [{content: "Find Hermes source"}, {content: "Read telegram.py"}, {content: "Write comparison doc"}] })
- Start task 1: todo({ todos: [{id: 1, status: "in_progress"}], merge: true })
- Mark done + start next: todo({ todos: [{id: 1, status: "completed"}, {id: 2, status: "in_progress"}], merge: true })

Returns the full current list after the update.`,
  {
    todos: z.array(z.object({
      id: z.number().optional().describe('Existing todo id (when updating)'),
      content: z.string().optional().describe('Task description (required for new items)'),
      status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional().describe('Default: pending'),
    })).describe('List of items to set or update'),
    merge: z.boolean().default(false).describe('false = replace entire list. true = update by id, append new ones, keep others.'),
  },
  async (args) => {
    try {
      const file = readTodos();
      const now = new Date().toISOString();

      if (!args.merge) {
        file.todos = [];
      }

      let existingInProgress = file.todos.find((t) => t.status === 'in_progress');

      for (const update of args.todos) {
        const st = (update.status as 'pending' | 'in_progress' | 'completed' | 'cancelled') || 'pending';

        if (update.id !== undefined && args.merge) {
          const idx = file.todos.findIndex((t) => t.id === update.id);
          if (idx >= 0) {
            if (st === 'in_progress' && existingInProgress && existingInProgress.id !== update.id) {
              existingInProgress.status = 'pending';
              existingInProgress.updated_at = now;
            }
            file.todos[idx] = {
              ...file.todos[idx],
              content: update.content ?? file.todos[idx].content,
              status: update.status ?? file.todos[idx].status,
              updated_at: now,
            };
            if (st === 'in_progress') existingInProgress = file.todos[idx];
            continue;
          }
        }

        if (!update.content) continue;
        if (st === 'in_progress' && existingInProgress) {
          existingInProgress.status = 'pending';
          existingInProgress.updated_at = now;
        }
        const newTodo = {
          id: file.next_id++,
          content: update.content,
          status: st,
          created_at: now,
          updated_at: now,
        };
        file.todos.push(newTodo);
        if (st === 'in_progress') existingInProgress = newTodo;
      }

      writeTodos(file);

      const summary = file.todos.length === 0
        ? '(no todos)'
        : file.todos
            .map((t) => {
              const m = { pending: '[ ]', in_progress: '[→]', completed: '[x]', cancelled: '[-]' }[t.status];
              return `${m} #${t.id} ${t.content} (${t.status})`;
            })
            .join('\n');
      return {
        content: [{ type: 'text' as const, text: `Todos updated:\n${summary}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `todo tool failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'web_unlock',
  `Fetch a URL through BrightData Web Unlocker. Use as a fallback when WebFetch returns empty/blocked content (Cloudflare, JS-only SPA, geo-block, login wall). Bypasses captcha + JS rendering. Returns the raw HTML/text body.

Order of preference:
1. WebFetch (free, fast)
2. browser_navigate (real Chromium with cookies, free)
3. web_unlock (paid, last resort but most reliable)

Costs ~0.001 USD per call — don't spam, but don't refuse to use it either when other options failed.`,
  {
    url: z.string().describe('The URL to fetch'),
    format: z.enum(['raw', 'markdown']).default('raw').describe('"raw" returns the full HTML; "markdown" returns BrightData-rendered markdown when supported.'),
  },
  async (args) => {
    const token = process.env.BRIGHTDATA_API_TOKEN;
    const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
    if (!token) {
      return {
        content: [{
          type: 'text' as const,
          text: 'web_unlock not configured: BRIGHTDATA_API_TOKEN is missing in .env. Tell the user to add it (Web Unlocker zone token from brightdata.com).',
        }],
        isError: true,
      };
    }
    // Use curl via spawn instead of Node fetch: the sandbox redirects
    // /etc/resolv.conf to 127.0.0.1 with no listener, breaking c-ares DNS for
    // Node fetch. macOS getaddrinfo (used by curl) bypasses resolv.conf and
    // resolves correctly. See incident 2026-05-10/dns-sandbox.
    try {
      const body = JSON.stringify({ zone, url: args.url, format: args.format });
      const result = await new Promise<{ status: number; body: string; stderr: string }>((resolve, reject) => {
        const proc = spawn('curl', [
          '-sS',
          '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-H', `Authorization: Bearer ${token}`,
          '--data-binary', '@-',
          '-w', '\n__HTTP_STATUS__:%{http_code}',
          '--max-time', '60',
          'https://api.brightdata.com/request',
        ]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`curl exit ${code}: ${stderr || stdout}`));
            return;
          }
          const m = stdout.match(/^([\s\S]*)\n__HTTP_STATUS__:(\d{3})$/);
          if (!m) {
            resolve({ status: 0, body: stdout, stderr });
            return;
          }
          resolve({ status: parseInt(m[2], 10), body: m[1], stderr });
        });
        proc.stdin.write(body);
        proc.stdin.end();
      });
      if (result.status < 200 || result.status >= 300) {
        return {
          content: [{
            type: 'text' as const,
            text: `web_unlock failed: HTTP ${result.status}\n${result.body.slice(0, 500)}`,
          }],
          isError: true,
        };
      }
      const MAX = 80_000;
      const truncated = result.body.length > MAX
        ? result.body.slice(0, MAX) + `\n\n[truncated, total ${result.body.length} chars]`
        : result.body;
      return { content: [{ type: 'text' as const, text: truncated }] };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `web_unlock error: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
