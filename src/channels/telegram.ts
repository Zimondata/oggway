import https from 'https';
import fs from 'fs';
import { Api, Bot, GrammyError } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../orchestrator/config.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import {
  registerChannel,
  ChannelOpts,
} from '../orchestrator/channel-registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../orchestrator/types.js';
import {
  transcribeAudio,
  extractPdfText,
  downloadTelegramFile,
  cleanupTempFile,
} from './telegram-media.js';
import {
  isAdminCommand,
  isAdminSender,
  isAdminConfigured,
  handleAdminCommand,
} from './telegram-admin.js';
import { getMessageById } from '../orchestrator/db.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Returns retry_after seconds if the error is a Telegram 429 flood-control
 * error, otherwise null. Defaults to 1s if the server didn't specify.
 */
function floodRetryAfter(err: unknown): number | null {
  if (err instanceof GrammyError && err.error_code === 429) {
    const ra = err.parameters?.retry_after;
    return typeof ra === 'number' && ra > 0 ? ra : 1;
  }
  return null;
}

function isParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /parse|markdown|entity|byte offset/i.test(msg);
}

/**
 * Build a "[в ответ на NAME: "..."]\n" prefix when a Telegram message is a
 * reply to another message, so the agent knows exactly what the user is
 * responding to. Resolves the quoted text from the reply's own text/caption,
 * else the stored DB content (transcript/OCR/file path), else a placeholder.
 *
 * Shared by the text handler and the non-text paths (voice/photo/doc/etc.) so
 * replies work regardless of message type — previously this lived only inside
 * the message:text handler. Returns '' when the message is not a reply.
 */
function buildReplyPrefix(replyTo: any, chatJid: string): string {
  if (!replyTo) return '';

  let original: string = replyTo.text || replyTo.caption || '';

  if (!original) {
    // Look up real content from DB by message_id
    try {
      const stored = getMessageById(String(replyTo.message_id), chatJid);
      if (stored?.content) {
        original = stored.content;
      }
    } catch (err) {
      logger.debug({ err }, 'reply_to lookup failed');
    }
  }

  // Last-resort placeholder if DB lookup also empty
  if (!original) {
    original =
      (replyTo.voice && '[voice message — transcript not stored yet]') ||
      (replyTo.photo && '[photo]') ||
      (replyTo.document &&
        `[document: ${replyTo.document.file_name || 'file'}]`) ||
      (replyTo.video && '[video]') ||
      (replyTo.audio && '[audio]') ||
      '[message]';
  }

  const fromName = replyTo.from?.is_bot
    ? ASSISTANT_NAME
    : replyTo.from?.first_name || replyTo.from?.username || 'someone';
  const quote = original.length > 800 ? original.slice(0, 800) + '…' : original;
  return `[в ответ на ${fromName}: "${quote}"]\n`;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 *
 * Distinguishes parse errors (downgrade to plain text once) from flood-control
 * 429s (wait retry_after and retry WITHOUT downgrading formatting). Returns
 * null only after genuinely failing — caller must treat null as a lost message.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<{ message_id: number } | null> {
  let parseMode: 'Markdown' | undefined = 'Markdown';
  // attempts cover: initial send, one plain-text downgrade, plus flood retries
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const sent = await api.sendMessage(chatId, text, {
        ...options,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return { message_id: sent.message_id };
    } catch (err) {
      const retryAfter = floodRetryAfter(err);
      if (retryAfter !== null && attempt < 3) {
        logger.warn(
          { chatId, retryAfter },
          'Telegram 429 flood control, retrying after delay',
        );
        await sleep(retryAfter * 1000 + 500);
        continue;
      }
      if (parseMode && isParseError(err)) {
        logger.debug(
          { err },
          'Markdown send failed, falling back to plain text',
        );
        parseMode = undefined;
        continue;
      }
      logger.error(
        { err, chatId },
        'Telegram sendMessage failed — message lost',
      );
      return null;
    }
  }
  logger.error(
    { chatId },
    'Telegram sendMessage exhausted retries — message lost',
  );
  return null;
}

async function editTelegramMessage(
  api: Pick<Api, 'editMessageText'>,
  chatId: string | number,
  messageId: number,
  text: string,
): Promise<void> {
  let parseMode: 'Markdown' | undefined = 'Markdown';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.editMessageText(chatId, messageId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return;
    } catch (err) {
      const retryAfter = floodRetryAfter(err);
      if (retryAfter !== null && attempt < 3) {
        logger.warn(
          { chatId, messageId, retryAfter },
          'Telegram 429 on edit, retrying after delay',
        );
        await sleep(retryAfter * 1000 + 500);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      // "message is not modified" is fine — user-side text didn't change
      if (/not modified/i.test(msg)) return;
      if (parseMode && isParseError(err)) {
        // Markdown may break mid-stream; retry as plain text
        parseMode = undefined;
        continue;
      }
      logger.debug(
        { err: msg, chatId, messageId },
        'Telegram editMessageText failed',
      );
      return;
    }
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  capabilities = { supportsEdit: true };

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Diagnostic middleware: log every incoming update so we can see what
    // gets dropped (forwards, stories, polls, etc.) when handler routing
    // misses. Keeps the line short to not flood the log.
    // Guard for test mocks that don't implement .use().
    if (typeof (this.bot as any).use === 'function')
      this.bot.use(async (ctx, next) => {
        try {
          const u: any = ctx.update;
          const m = u?.message || u?.edited_message || u?.channel_post;
          if (m) {
            const fields: string[] = [];
            if (m.text) fields.push(`text:${String(m.text).length}c`);
            if (m.caption) fields.push(`caption:${String(m.caption).length}c`);
            if (m.photo) fields.push('photo');
            if (m.video) fields.push('video');
            if (m.video_note) fields.push('video_note');
            if (m.voice) fields.push('voice');
            if (m.audio) fields.push('audio');
            if (m.document)
              fields.push(
                `doc:${m.document.file_name || m.document.mime_type || '?'}`,
              );
            if (m.sticker) fields.push('sticker');
            if (m.animation) fields.push('animation');
            if (m.location) fields.push('location');
            if (m.contact) fields.push('contact');
            if (m.poll) fields.push('poll');
            if (m.story) fields.push('story');
            if (m.dice) fields.push('dice');
            if (m.venue) fields.push('venue');
            if (m.forward_origin)
              fields.push(`forward:${m.forward_origin.type || '?'}`);
            if (m.reply_to_message) fields.push('reply');
            if (m.via_bot) fields.push(`via_bot:${m.via_bot.username}`);
            if (fields.length === 0) fields.push('UNKNOWN');
            logger.info(
              {
                chatId: m.chat?.id,
                from: m.from?.username || m.from?.id,
                kinds: fields.join(','),
              },
              'TG update received',
            );
          } else if (u) {
            const updateKinds = Object.keys(u).filter((k) => k !== 'update_id');
            logger.info({ updateKinds }, 'TG non-message update received');
          }
        } catch (err) {
          logger.debug({ err }, 'TG diagnostic middleware error');
        }
        await next();
      });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Admin commands bypass the agent entirely — handled by orchestrator.
      // This is critical: if the agent is dead (auth, sandbox hang, etc),
      // admin commands still work so the user can recover.
      if (isAdminConfigured() && isAdminCommand(ctx.message.text)) {
        const senderId = ctx.from?.id?.toString() || '';
        if (!isAdminSender(senderId)) {
          logger.warn({ senderId }, 'Non-admin attempted admin command');
          return;
        }
        const reply = await handleAdminCommand(ctx.message.text);
        const chunks: string[] = [];
        // Telegram hard limit is 4096 chars per message
        for (let i = 0; i < reply.length; i += 3800) {
          chunks.push(reply.slice(i, i + 3800));
        }
        for (const chunk of chunks) {
          await ctx
            .reply(`\`\`\`\n${chunk}\n\`\`\``, { parse_mode: 'Markdown' })
            .catch(async () => {
              // Fallback to plain text if markdown escaping fails
              await ctx.reply(chunk);
            });
        }
        return;
      }

      // Skip other commands (they're for future bot.command handlers)
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;

      // Prepend forward prefix so the agent knows this came from elsewhere
      // (channel post, another user, hidden user) instead of treating it as
      // user's own writing.
      const fwd = forwardPrefix(ctx.message);
      if (fwd) content = `${fwd}${content}`;

      // If this is a reply to another message, prepend a quote so the agent
      // has the exact text the user is responding to (beyond its own session
      // memory). For voice/photo/doc, look up the ACTUAL stored content
      // (transcript, OCR, file path) from DB instead of the "[voice message]"
      // placeholder — that's what OpenClaude does and what makes "I'm replying
      // to that voice" work.
      const replyPrefix = buildReplyPrefix(
        ctx.message.reply_to_message,
        chatJid,
      );
      if (replyPrefix) content = `${replyPrefix}${content}`;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    // Build a "[forwarded from ...]" prefix when the message was forwarded.
    // Telegram exposes this via `forward_origin` (newer API) or legacy
    // `forward_from` / `forward_from_chat`. Without this prefix the agent
    // can't tell apart "user typed text" vs "user forwarded a post".
    const forwardPrefix = (msg: any): string => {
      if (!msg) return '';
      const o = msg.forward_origin;
      if (o) {
        if (o.type === 'channel') {
          const name = o.chat?.title || o.chat?.username || 'канал';
          return `[переслано из канала ${name}${o.message_id ? ` #${o.message_id}` : ''}] `;
        }
        if (o.type === 'user') {
          const u = o.sender_user;
          const name = u?.first_name || u?.username || 'пользователь';
          return `[переслано от ${name}] `;
        }
        if (o.type === 'hidden_user') {
          return `[переслано от ${o.sender_user_name || 'скрытого пользователя'}] `;
        }
        if (o.type === 'chat') {
          return `[переслано из чата ${o.sender_chat?.title || ''}] `;
        }
        return `[переслано (${o.type})] `;
      }
      // Legacy fields (older grammy/TG)
      if (msg.forward_from_chat?.title) {
        return `[переслано из канала ${msg.forward_from_chat.title}] `;
      }
      if (msg.forward_from?.first_name) {
        return `[переслано от ${msg.forward_from.first_name}] `;
      }
      if (msg.forward_sender_name) {
        return `[переслано от ${msg.forward_sender_name}] `;
      }
      return '';
    };

    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const fwd = forwardPrefix(ctx.message);
      const replyPrefix = buildReplyPrefix(
        ctx.message.reply_to_message,
        chatJid,
      );

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${replyPrefix}${fwd}${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Transcribe voice/audio using local whisper before delivering to agent
    const transcribeAndStore = async (
      ctx: any,
      fallback: string,
      suffix: string,
      mediaKind: string,
    ) => {
      try {
        const file = await ctx.getFile();
        if (!file.file_path) {
          storeNonText(ctx, fallback);
          return;
        }
        const localPath = await downloadTelegramFile(
          this.botToken,
          file.file_path,
          suffix,
        );
        if (!localPath) {
          storeNonText(ctx, fallback);
          return;
        }
        try {
          const transcript = await transcribeAudio(localPath);
          if (transcript) {
            logger.info(
              { mediaKind, length: transcript.length },
              'Telegram audio transcribed',
            );
            storeNonText(ctx, `[${mediaKind}: ${transcript}]`);
          } else {
            storeNonText(ctx, fallback);
          }
        } finally {
          cleanupTempFile(localPath);
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), mediaKind },
          'Telegram transcription path failed',
        );
        storeNonText(ctx, fallback);
      }
    };

    // Download photo to /tmp so the agent can Read it as an image (Claude
    // Code's Read tool natively handles jpg/png/gif → vision content block).
    this.bot.on('message:photo', async (ctx) => {
      try {
        const file = await ctx.getFile();
        if (!file.file_path) {
          storeNonText(ctx, '[Photo]');
          return;
        }
        const ext = file.file_path.split('.').pop() || 'jpg';
        const localPath = await downloadTelegramFile(
          this.botToken,
          file.file_path,
          `.${ext}`,
        );
        if (!localPath) {
          storeNonText(ctx, '[Photo]');
          return;
        }
        logger.info(
          { localPath, caption: ctx.message.caption },
          'Telegram photo saved',
        );
        storeNonText(
          ctx,
          `[Photo saved to ${localPath} — use Read tool to see it]`,
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Telegram photo download failed',
        );
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      transcribeAndStore(ctx, '[Voice message]', '.ogg', 'Voice'),
    );
    this.bot.on('message:audio', (ctx) =>
      transcribeAndStore(ctx, '[Audio]', '.mp3', 'Audio'),
    );
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      const mime = ctx.message.document?.mime_type || '';
      const lowerName = name.toLowerCase();
      const isPdf = mime === 'application/pdf' || lowerName.endsWith('.pdf');
      const TEXT_EXTS = [
        '.md',
        '.txt',
        '.json',
        '.csv',
        '.yaml',
        '.yml',
        '.log',
        '.ts',
        '.js',
        '.py',
        '.rb',
        '.go',
        '.rs',
        '.php',
        '.html',
        '.css',
        '.sh',
        '.sql',
      ];
      const isText =
        !isPdf &&
        (mime.startsWith('text/') ||
          TEXT_EXTS.some((e) => lowerName.endsWith(e)));
      if (!isPdf && !isText) {
        storeNonText(ctx, `[Document: ${name}]`);
        return;
      }
      try {
        const file = await ctx.getFile();
        if (!file.file_path) {
          storeNonText(ctx, `[Document: ${name}]`);
          return;
        }
        if (isPdf) {
          const localPath = await downloadTelegramFile(
            this.botToken,
            file.file_path,
            '.pdf',
          );
          if (!localPath) {
            storeNonText(ctx, `[Document: ${name}]`);
            return;
          }
          try {
            const text = await extractPdfText(localPath);
            if (text) {
              logger.info(
                { name, length: text.length },
                'Telegram PDF extracted',
              );
              storeNonText(ctx, `[PDF: ${name}]\n${text}`);
            } else {
              storeNonText(ctx, `[Document: ${name}]`);
            }
          } finally {
            cleanupTempFile(localPath);
          }
        } else {
          const dotIdx = lowerName.lastIndexOf('.');
          const ext = dotIdx >= 0 ? lowerName.slice(dotIdx) : '.txt';
          const localPath = await downloadTelegramFile(
            this.botToken,
            file.file_path,
            ext,
          );
          if (!localPath) {
            storeNonText(ctx, `[Document: ${name}]`);
            return;
          }
          try {
            const MAX_BYTES = 200 * 1024;
            const stat = fs.statSync(localPath);
            const fd = fs.openSync(localPath, 'r');
            try {
              const readLen = Math.min(stat.size, MAX_BYTES);
              const buf = Buffer.alloc(readLen);
              fs.readSync(fd, buf, 0, readLen, 0);
              let text = buf.toString('utf8');
              if (stat.size > MAX_BYTES) {
                text += `\n\n[truncated: file is ${stat.size} bytes, showing first ${MAX_BYTES}]`;
              }
              logger.info(
                { name, length: text.length, fullSize: stat.size },
                'Telegram text document inlined',
              );
              storeNonText(ctx, `[Document: ${name}]\n${text}`);
            } finally {
              fs.closeSync(fd);
            }
          } finally {
            cleanupTempFile(localPath);
          }
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), name },
          'Telegram document path failed',
        );
        storeNonText(ctx, `[Document: ${name}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));
    this.bot.on('message:video_note', (ctx) =>
      transcribeAndStore(ctx, '[Video note (round)]', '.mp4', 'Video note'),
    );
    this.bot.on('message:animation', (ctx) =>
      storeNonText(ctx, '[Animation/GIF]'),
    );
    this.bot.on('message:poll', (ctx) => {
      const q = ctx.message.poll?.question || '';
      const opts = (ctx.message.poll?.options || [])
        .map((o: any) => `- ${o.text}`)
        .join('\n');
      storeNonText(ctx, `[Poll: ${q}\n${opts}]`);
    });
    this.bot.on('message:dice', (ctx) => {
      const e = ctx.message.dice?.emoji || '';
      const v = ctx.message.dice?.value ?? '';
      storeNonText(ctx, `[Dice ${e} = ${v}]`);
    });
    this.bot.on('message:venue', (ctx) => {
      const v = ctx.message.venue;
      storeNonText(ctx, `[Venue: ${v?.title || ''} — ${v?.address || ''}]`);
    });
    // Forwarded story (TG Stories) — has no text or media; capture forward origin.
    this.bot.on('message:story', (ctx) => {
      const origin: any = (ctx.message as any).forward_origin;
      const tag =
        origin?.type === 'channel'
          ? `канал ${origin?.chat?.title || origin?.chat?.username || '?'}`
          : origin?.type === 'user'
            ? `${origin?.sender_user?.first_name || origin?.sender_user?.username || '?'}`
            : 'неизвестный';
      storeNonText(ctx, `[Story forwarded from ${tag}]`);
    });
    // Catch-all fallback: any message that didn't match a specific handler
    // gets stored with a description. Prevents silent drops on new TG types.
    this.bot.on('message', (ctx) => {
      const m: any = ctx.message;
      // If we have nothing identifiable, store a note so the user sees the
      // bot at least acknowledged something arrived.
      const fields: string[] = [];
      if (m.text) return; // already handled by message:text
      if (
        m.photo ||
        m.video ||
        m.voice ||
        m.audio ||
        m.document ||
        m.sticker ||
        m.location ||
        m.contact ||
        m.video_note ||
        m.animation ||
        m.poll ||
        m.dice ||
        m.venue ||
        m.story
      )
        return; // already handled
      if (m.caption) fields.push(`caption: ${m.caption.slice(0, 200)}`);
      if (m.via_bot) fields.push(`via @${m.via_bot.username}`);
      if (m.forward_origin)
        fields.push(
          `forwarded from ${m.forward_origin?.chat?.title || m.forward_origin?.sender_user?.first_name || m.forward_origin?.type}`,
        );
      const desc = fields.length
        ? fields.join(' | ')
        : 'unknown TG message type';
      logger.warn(
        { messageId: m.message_id, chatId: m.chat?.id },
        `Unhandled TG message: ${desc}`,
      );
      storeNonText(ctx, `[Unhandled TG message: ${desc}]`);
    });

    // Handle errors gracefully. grammY's error boundary catches
    // middleware errors; without explicit logging these are swallowed.
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling. grammY long-polling has built-in reconnect, but
    // network gaps can cause 5-10 minute silences with no error logged.
    // We pass a short polling timeout so grammY re-establishes the
    // connection faster after transient network issues (default is 30s).
    return new Promise<void>((resolve) => {
      this.bot!.start({
        // Shorter timeout = faster recovery from network blips.
        // Default 30s means a dropped connection stalls for 30s before
        // grammY notices. 10s = max 10s gap instead of 30s+.
        timeout: 10,
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
  ): Promise<{ messageId?: number } | void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      let firstMessageId: number | undefined;
      let anyFailed = false;
      if (text.length <= MAX_LENGTH) {
        const sent = await sendTelegramMessage(this.bot.api, numericId, text);
        firstMessageId = sent?.message_id;
        if (sent === null) anyFailed = true;
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const sent = await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
          if (i === 0) firstMessageId = sent?.message_id;
          if (sent === null) anyFailed = true;
        }
      }
      if (anyFailed) {
        logger.error(
          { jid, length: text.length },
          'Telegram message FAILED to deliver',
        );
      } else {
        logger.info({ jid, length: text.length }, 'Telegram message sent');
      }
      return firstMessageId !== undefined
        ? { messageId: firstMessageId }
        : undefined;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, 'sendDocument: file not found');
      throw new Error(`File not found: ${filePath}`);
    }
    const numericId = jid.replace(/^tg:/, '');
    try {
      const { InputFile } = await import('grammy');
      const file = new InputFile(filePath);
      await this.bot.api.sendDocument(
        numericId,
        file,
        caption ? { caption } : {},
      );
      logger.info({ jid, filePath }, 'Telegram document sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram document');
      throw err;
    }
  }

  async editMessage(
    jid: string,
    messageId: string | number,
    text: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    const numericId = jid.replace(/^tg:/, '');
    const numMsgId =
      typeof messageId === 'string' ? parseInt(messageId, 10) : messageId;
    if (!Number.isFinite(numMsgId)) return;
    // Telegram editMessageText also has 4096 char limit. For longer streams
    // we keep the visible draft below the cap and emit overflow as a NEW
    // message at flush time (handled by the streaming caller).
    const MAX_LENGTH = 4096;
    const trimmed =
      text.length > MAX_LENGTH
        ? text.slice(0, MAX_LENGTH - 30) + '\n…(continues below)'
        : text;
    await editTelegramMessage(this.bot.api, numericId, numMsgId, trimmed);
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
