/**
 * DesktopChannel — HTTP/SSE channel for Agent Drive desktop app.
 *
 * Exposes a local HTTP server (default port 3202) that Agent Drive connects to:
 *   POST /api/message          — send user message to orchestrator
 *   GET  /api/stream/:topicId  — SSE stream for agent responses
 *   GET  /api/topics           — list registered desktop topics
 *   POST /api/topics           — register a new topic
 *   GET  /api/health           — health check
 *
 * JID format: desktop:<topicId>
 * No external dependencies — uses Node built-in http module.
 */
import http from 'http';
import { randomUUID } from 'crypto';

import {
  registerChannel,
  ChannelOpts,
} from '../orchestrator/channel-registry.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import type {
  Channel,
  SentMessageInfo,
  OnInboundMessage,
  RegisteredGroup,
} from '../orchestrator/types.js';

const JID_PREFIX = 'desktop:';

interface SSEClient {
  topicId: string;
  res: http.ServerResponse;
}

export class DesktopChannel implements Channel {
  name = 'desktop';
  capabilities = { supportsEdit: true };

  private server: http.Server | null = null;
  private clients: SSEClient[] = [];
  private onMessage: OnInboundMessage;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private port: number;
  private connected = false;

  constructor(port: number, opts: ChannelOpts) {
    this.port = port;
    this.onMessage = opts.onMessage;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    const server = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve();
      });
    });

    this.server = server;
    this.connected = true;
    logger.info({ port: this.port }, 'DesktopChannel HTTP server started');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<SentMessageInfo> {
    const topicId = jid.replace(JID_PREFIX, '');
    const messageId = randomUUID();

    this.broadcastSSE(topicId, {
      type: 'message',
      id: messageId,
      topicId,
      role: 'assistant',
      content: text,
      timestamp: new Date().toISOString(),
    });

    return { messageId };
  }

  async editMessage(
    jid: string,
    messageId: string | number,
    text: string,
  ): Promise<void> {
    const topicId = jid.replace(JID_PREFIX, '');

    this.broadcastSSE(topicId, {
      type: 'message-edit',
      id: String(messageId),
      topicId,
      content: text,
      timestamp: new Date().toISOString(),
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const topicId = jid.replace(JID_PREFIX, '');
    this.broadcastSSE(topicId, { type: 'typing', topicId, isTyping });
  }

  async disconnect(): Promise<void> {
    // Close all SSE connections
    for (const client of this.clients) {
      client.res.end();
    }
    this.clients = [];

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.connected = false;
    logger.info('DesktopChannel stopped');
  }

  // --- Internal ---

  private broadcastSSE(topicId: string, data: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const alive: SSEClient[] = [];

    for (const client of this.clients) {
      if (client.topicId !== topicId && client.topicId !== '*') continue;
      try {
        client.res.write(payload);
        alive.push(client);
      } catch {
        // client disconnected
      }
    }

    // Also keep clients for other topics
    for (const client of this.clients) {
      if (client.topicId === topicId || client.topicId === '*') continue;
      alive.push(client);
    }

    this.clients = alive;
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // CORS for Tauri webview
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      this.handleHealth(res);
    } else if (req.method === 'GET' && pathname.startsWith('/api/stream/')) {
      const topicId = pathname.replace('/api/stream/', '');
      this.handleSSE(topicId, res);
    } else if (req.method === 'GET' && pathname === '/api/topics') {
      this.handleListTopics(res);
    } else if (req.method === 'POST' && pathname === '/api/message') {
      this.handleIncomingMessage(req, res);
    } else if (req.method === 'POST' && pathname === '/api/topics') {
      this.handleCreateTopic(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  }

  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        channel: 'desktop',
        clients: this.clients.length,
      }),
    );
  }

  private handleSSE(topicId: string, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected', topicId })}\n\n`);

    const client: SSEClient = { topicId, res };
    this.clients.push(client);

    req_cleanup(res, () => {
      this.clients = this.clients.filter((c) => c !== client);
    });
  }

  private handleListTopics(res: http.ServerResponse): void {
    const groups = this.registeredGroups();
    const desktopTopics = Object.entries(groups)
      .filter(([, g]) => {
        // Find groups whose chat_jid starts with desktop:
        // We check the folder name for desktop topics
        return g.folder.startsWith('desktop_topic_');
      })
      .map(([, g]) => ({
        id: g.folder.replace('desktop_topic_', ''),
        name: g.name,
        folder: g.folder,
      }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ topics: desktopTopics }));
  }

  private async handleIncomingMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let parsed: { topicId: string; content: string; sender?: string };

    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    if (!parsed.topicId || !parsed.content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'topicId and content required' }));
      return;
    }

    const jid = JID_PREFIX + parsed.topicId;
    const messageId = randomUUID();

    // Deliver to orchestrator
    this.onMessage(jid, {
      id: messageId,
      chat_jid: jid,
      sender: parsed.sender || 'desktop-user',
      sender_name: parsed.sender || 'User',
      content: parsed.content,
      timestamp: new Date().toISOString(),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messageId }));
  }

  private async handleCreateTopic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let parsed: { name: string; id?: string };

    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    if (!parsed.name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name required' }));
      return;
    }

    const topicId = parsed.id || randomUUID().slice(0, 8);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        topicId,
        jid: JID_PREFIX + topicId,
        folder: `desktop_topic_${topicId}`,
      }),
    );
  }
}

// --- Helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function req_cleanup(res: http.ServerResponse, cb: () => void): void {
  res.on('close', cb);
  res.on('error', cb);
}

// --- Self-register ---

const env = readEnvFile(['DESKTOP_PORT']);
const DESKTOP_PORT = parseInt(env.DESKTOP_PORT || '3202', 10);

// Always register — Agent Drive connects when available
registerChannel('desktop', (opts) => {
  return new DesktopChannel(DESKTOP_PORT, opts);
});
