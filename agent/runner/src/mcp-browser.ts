/**
 * Browser MCP server.
 *
 * Connects to a long-running Chromium daemon over CDP (started by
 * scripts/browser-daemon.sh) and exposes structured browser tools to
 * the agent. The daemon lives outside the sandbox so the browser has
 * full network access; the agent stays sandboxed and only reaches
 * localhost (where this MCP listens).
 *
 * The daemon URL defaults to http://localhost:9222 and is overridable
 * via CLAUDECLAW_BROWSER_CDP_URL.
 *
 * Tools are kebab-style and operate on the active page (first tab in
 * the first context). They reuse the existing daemon session, so any
 * cookies/logins established interactively by the user persist.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const CDP_URL = process.env.CLAUDECLAW_BROWSER_CDP_URL || 'http://localhost:9222';

let browser: Browser | null = null;
let activeContext: BrowserContext | null = null;
let activePage: Page | null = null;

function logErr(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-browser] ${prefix}: ${msg}\n`);
  return msg;
}

async function ensurePage(): Promise<Page> {
  if (activePage && !activePage.isClosed()) return activePage;

  if (!browser || !browser.isConnected()) {
    browser = await chromium.connectOverCDP(CDP_URL);
  }
  const contexts = browser.contexts();
  activeContext = contexts[0] ?? (await browser.newContext());
  const pages = activeContext.pages();
  activePage = pages.find((p) => !p.isClosed()) ?? (await activeContext.newPage());

  // Bring tab into focus so the user can watch the agent work.
  try { await activePage.bringToFront(); } catch { /* tab may have closed */ }
  return activePage;
}

function describeError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  let hint = '';
  if (msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED')) {
    hint = `\n\nBrowser daemon does not appear to be running at ${CDP_URL}. Start it from the project root: ./scripts/browser-daemon.sh start`;
  }
  return {
    content: [{ type: 'text' as const, text: `browser tool failed: ${msg}${hint}` }],
    isError: true,
  };
}

const server = new McpServer({
  name: 'claudeclaw-browser',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

server.tool(
  'browser_navigate',
  `Navigate the active tab to a URL. Waits until the page reaches "domcontentloaded". Returns the final URL and short page title.`,
  {
    url: z.string().describe('Absolute URL (e.g., https://connect.garmin.com)'),
    wait_until: z
      .enum(['domcontentloaded', 'load', 'networkidle'])
      .default('domcontentloaded')
      .describe('Which load state to wait for. networkidle is slowest but most complete.'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      await page.goto(args.url, { waitUntil: args.wait_until, timeout: 30_000 });
      const title = await page.title();
      return { content: [{ type: 'text' as const, text: `Navigated to ${page.url()}\nTitle: ${title}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_url',
  `Return the current URL and page title of the active tab.`,
  {},
  async () => {
    try {
      const page = await ensurePage();
      const title = await page.title().catch(() => '');
      return { content: [{ type: 'text' as const, text: `${page.url()}\n${title}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Page inspection
// ---------------------------------------------------------------------------

server.tool(
  'browser_text',
  `Return visible text content of the page or a specific element. Use this to read the page like a screen reader. For very large pages prefer browser_snapshot or pass a selector.`,
  {
    selector: z.string().optional().describe('Optional CSS selector to scope the text extraction. Omit for whole page body text.'),
    max_chars: z.number().default(8000).describe('Truncate text after this many characters.'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      const text = args.selector
        ? await page.locator(args.selector).first().innerText({ timeout: 5_000 })
        : await page.evaluate(() => document.body?.innerText || '');
      const out = text.length > args.max_chars
        ? `${text.slice(0, args.max_chars)}\n\n[truncated ${text.length - args.max_chars} chars]`
        : text;
      return { content: [{ type: 'text' as const, text: out || '(empty)' }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_snapshot',
  `Return an ARIA snapshot of the page — a YAML-ish text representation of accessible roles, names, and refs. More reliable than raw HTML for finding clickable elements and form fields. Use to discover what's on the page before clicking/filling.`,
  {
    selector: z.string().default('body').describe('Root selector to snapshot. Default body covers the whole page.'),
    max_chars: z.number().default(12_000).describe('Truncate snapshot after this many characters.'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      const snap = await page.locator(args.selector).first().ariaSnapshot({ mode: 'ai' });
      const truncated = snap.length > args.max_chars
        ? `${snap.slice(0, args.max_chars)}\n[... truncated ${snap.length - args.max_chars} chars]`
        : snap;
      return { content: [{ type: 'text' as const, text: truncated }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

server.tool(
  'browser_click',
  `Click an element. Selector can be a CSS selector OR Playwright text= / role= locator (e.g. "text=Sign in", "role=button[name=Submit]").`,
  {
    selector: z.string().describe('CSS selector or Playwright locator string'),
    timeout_ms: z.number().default(10_000).describe('Max time to wait for the element to be actionable'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      await page.locator(args.selector).first().click({ timeout: args.timeout_ms });
      return { content: [{ type: 'text' as const, text: `Clicked ${args.selector}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_fill',
  `Type a value into an input or textarea. Selector matches the same way as browser_click. Use this for login forms, search boxes, etc.`,
  {
    selector: z.string().describe('CSS selector or Playwright locator string for the field'),
    value: z.string().describe('Text to type into the field. Replaces existing content.'),
    timeout_ms: z.number().default(10_000).describe('Max time to wait for the field'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      await page.locator(args.selector).first().fill(args.value, { timeout: args.timeout_ms });
      return { content: [{ type: 'text' as const, text: `Filled ${args.selector}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_press',
  `Press a single keyboard key on the active page. Useful for "Enter" to submit a form, "Tab" to move focus, etc. Use Playwright key names (Enter, Escape, ArrowDown, Control+A, etc).`,
  {
    key: z.string().describe('Key name, e.g. "Enter", "Tab", "Escape", "Control+A"'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      await page.keyboard.press(args.key);
      return { content: [{ type: 'text' as const, text: `Pressed ${args.key}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_wait',
  `Wait for an element matching the selector to appear (or a fixed duration). Useful after navigation or clicking when content loads asynchronously.`,
  {
    selector: z.string().optional().describe('CSS / Playwright selector to wait for'),
    timeout_ms: z.number().default(15_000).describe('Max wait in milliseconds'),
    sleep_ms: z.number().optional().describe('If set, just sleep this many ms (no selector wait). Use sparingly.'),
  },
  async (args) => {
    try {
      const page = await ensurePage();
      if (args.sleep_ms) {
        await page.waitForTimeout(args.sleep_ms);
        return { content: [{ type: 'text' as const, text: `Slept ${args.sleep_ms}ms` }] };
      }
      if (!args.selector) {
        return { content: [{ type: 'text' as const, text: 'No selector or sleep_ms provided — nothing to wait for.' }] };
      }
      await page.locator(args.selector).first().waitFor({ timeout: args.timeout_ms });
      return { content: [{ type: 'text' as const, text: `Found ${args.selector}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

server.tool(
  'browser_new_tab',
  `Open a new tab and switch to it as the active page. Optionally navigate to a URL.`,
  {
    url: z.string().optional().describe('Optional URL to load in the new tab'),
  },
  async (args) => {
    try {
      if (!browser || !browser.isConnected()) {
        browser = await chromium.connectOverCDP(CDP_URL);
      }
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      activeContext = ctx;
      activePage = await ctx.newPage();
      if (args.url) await activePage.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      try { await activePage.bringToFront(); } catch { /* ignored */ }
      return { content: [{ type: 'text' as const, text: `New tab open${args.url ? ` at ${activePage.url()}` : ''}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_list_tabs',
  `List all open tabs with their index, URL, and title. Useful to switch between them with browser_select_tab.`,
  {},
  async () => {
    try {
      if (!browser || !browser.isConnected()) {
        browser = await chromium.connectOverCDP(CDP_URL);
      }
      const lines: string[] = [];
      let i = 0;
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (page.isClosed()) continue;
          const title = await page.title().catch(() => '');
          const isActive = page === activePage;
          lines.push(`${isActive ? '*' : ' '} [${i}] ${page.url()}  —  ${title}`);
          i++;
        }
      }
      return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : 'No open tabs.' }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_select_tab',
  `Switch the active tab by its index from browser_list_tabs.`,
  {
    index: z.number().describe('Tab index from browser_list_tabs'),
  },
  async (args) => {
    try {
      if (!browser || !browser.isConnected()) {
        browser = await chromium.connectOverCDP(CDP_URL);
      }
      const allPages: Page[] = [];
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (!page.isClosed()) allPages.push(page);
        }
      }
      const target = allPages[args.index];
      if (!target) {
        return { content: [{ type: 'text' as const, text: `No tab at index ${args.index}. ${allPages.length} tabs open.` }], isError: true };
      }
      activePage = target;
      activeContext = target.context();
      try { await target.bringToFront(); } catch { /* ignored */ }
      return { content: [{ type: 'text' as const, text: `Switched to tab ${args.index}: ${target.url()}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

server.tool(
  'browser_close_tab',
  `Close the active tab. The next tab in the list becomes active. If no tabs remain, a blank one is opened.`,
  {},
  async () => {
    try {
      const page = await ensurePage();
      const ctx = page.context();
      await page.close();
      const remaining = ctx.pages().filter((p) => !p.isClosed());
      activePage = remaining[0] ?? (await ctx.newPage());
      activeContext = ctx;
      return { content: [{ type: 'text' as const, text: `Closed tab. Now on ${activePage.url()}` }] };
    } catch (err) {
      return describeError(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mcp-browser] connected to CDP at ${CDP_URL}\n`);

process.on('SIGTERM', async () => {
  try { await browser?.close(); } catch (err) { logErr('shutdown', err); }
  process.exit(0);
});
