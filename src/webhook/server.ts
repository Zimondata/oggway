import { createServer, IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { logger } from '../orchestrator/logger.js';
import type { MessageIngestion, RegisteredGroup } from '../orchestrator/types.js';
import { dispatchWakeEvent, wakeQueueKey } from '../orchestrator/wake-dispatcher.js';
import type { WakeDispatchDeps } from '../orchestrator/wake-dispatcher.js';
import type { WakeEvent } from '../orchestrator/wake-events.js';

export interface WebhookDeps {
  ingestion: MessageIngestion;
  findGroupByFolder: (folder: string) => { jid: string; name: string } | undefined;
  /** Optional — when present, /webhook/<group>/wake is enabled. */
  wakeDeps?: WakeDispatchDeps & {
    findGroup: (folder: string) => RegisteredGroup | undefined;
    findJid: (folder: string) => string | undefined;
  };
}

// Rate limiting: per-group request counter
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60_000;

function checkRateLimit(groupFolder: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(groupFolder);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(groupFolder, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startWebhookServer(
  port: number,
  secret: string,
  deps: WebhookDeps,
): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Only accept POST /webhook/:groupFolder
    if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const path = req.url.slice('/webhook/'.length).split('?')[0];
    if (!path) {
      sendJson(res, 400, { error: 'Missing group folder' });
      return;
    }

    // Wake events: /webhook/<group>/wake — bypass normal queue, dispatch
    // immediately on a dedicated #wake lane.
    const wakeMatch = path.match(/^([^/]+)\/wake$/);
    const groupFolder = wakeMatch ? wakeMatch[1] : path;
    const isWake = !!wakeMatch;

    // Rate limit (shared between regular webhooks and wake events)
    if (!checkRateLimit(groupFolder)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    const body = await readBody(req);

    const signature = req.headers['x-signature'] as string;
    if (!signature || !verifySignature(secret, body, signature)) {
      sendJson(res, 401, { error: 'Invalid signature' });
      return;
    }

    const group = deps.findGroupByFolder(groupFolder);
    if (!group) {
      sendJson(res, 404, { error: 'Group not found' });
      return;
    }

    // Parse payload
    let payload: { prompt?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { prompt: body };
    }

    if (isWake) {
      if (!deps.wakeDeps) {
        sendJson(res, 503, { error: 'Wake events not configured' });
        return;
      }
      const source = (req.headers['x-wake-source'] as string) || 'unknown';
      const eventType = (req.headers['x-wake-event'] as string) || 'unknown';
      const fullGroup = deps.wakeDeps.findGroup(groupFolder);
      if (!fullGroup) {
        sendJson(res, 404, { error: 'Group lookup failed' });
        return;
      }

      const wakeEvent: WakeEvent = {
        source,
        eventType,
        payload: {
          ...payload,
          // Stash real chat jid so the dispatcher can mark it for the agent.
          _chatJid: group.jid,
        },
        receivedAt: new Date().toISOString(),
      };

      // Fire-and-forget: enqueue on the wake lane and respond immediately.
      const queueKey = wakeQueueKey(group.jid);
      const wakeDeps = deps.wakeDeps;
      wakeDeps.queue.enqueueTask(queueKey, `wake-${Date.now()}`, () =>
        dispatchWakeEvent(fullGroup, wakeEvent, wakeDeps),
      );

      logger.info(
        { groupFolder, source, eventType },
        'Wake event accepted',
      );
      sendJson(res, 202, { status: 'accepted', tag: `${source}.${eventType}` });
      return;
    }

    const prompt = payload.prompt || JSON.stringify(payload);

    const accepted = await deps.ingestion.ingest({
      groupFolder,
      chatJid: group.jid,
      sender: 'webhook',
      senderName: 'Webhook',
      triggerType: 'webhook',
      prompt,
      bypassTrigger: true,
    });

    if (accepted) {
      logger.info({ groupFolder, jid: group.jid }, 'Webhook triggered');
      sendJson(res, 200, { status: 'accepted', group: group.name });
    } else {
      sendJson(res, 200, { status: 'dropped', group: group.name });
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Webhook server listening');
  });

  return server;
}
