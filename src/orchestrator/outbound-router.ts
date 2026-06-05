/**
 * MessageRouter — single outbound delivery service.
 * All output (agent responses, IPC messages, task results, extension output)
 * routes through here. Supports pre/post hooks for extensions.
 */
import {
  Channel,
  MessageRouter,
  OutboundEnvelope,
  OutboundPreHook,
} from './types.js';
import { findChannel, formatOutbound } from './router.js';
import { logger } from './logger.js';

export function createMessageRouter(channels: Channel[]): MessageRouter {
  const preHooks: OutboundPreHook[] = [];
  const postHooks: ((envelope: OutboundEnvelope) => void)[] = [];

  return {
    addPreHook(hook: OutboundPreHook): void {
      preHooks.push(hook);
    },

    addPostHook(hook: (envelope: OutboundEnvelope) => void): void {
      postHooks.push(hook);
    },

    async route(envelope: OutboundEnvelope): Promise<void> {
      let current = envelope;

      // Run pre-hooks sequentially
      for (const hook of preHooks) {
        try {
          const result = await hook(current);
          if (result.action === 'drop') {
            logger.debug(
              { jid: current.chatJid, reason: result.reason },
              'Outbound message dropped by pre-hook',
            );
            return;
          }
          if (result.action === 'modify') {
            current = result.envelope;
          }
        } catch (err) {
          logger.error({ err }, 'Outbound pre-hook error (continuing)');
        }
      }

      // Format (strip internal tags)
      const formatted = formatOutbound(current.text);
      if (!formatted) return;

      // Find channel and deliver
      const channel = channels.find(
        (c) => c.ownsJid(current.chatJid) && c.isConnected(),
      );
      if (!channel) {
        logger.warn(
          { jid: current.chatJid },
          'No connected channel for JID — message not delivered',
        );
        return;
      }

      await channel.sendMessage(current.chatJid, formatted);

      // Store the bot's outgoing reply in the messages DB so the <history>
      // block in subsequent prompts contains the full conversation (both
      // sides). Without this, agent only sees user side of scroll-back.
      try {
        const { storeMessage } = await import('./db.js');
        const ts = new Date().toISOString();
        const id = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        storeMessage({
          id,
          chat_jid: current.chatJid,
          sender: 'bot',
          sender_name: 'GLaDOS',
          content: formatted,
          timestamp: ts,
          is_from_me: true,
          is_bot_message: true,
        });
      } catch (err) {
        logger.debug({ err }, 'Failed to store outbound message in DB');
      }

      // Fire post-hooks (observe only, errors don't affect delivery)
      for (const hook of postHooks) {
        try {
          hook(current);
        } catch (err) {
          logger.error({ err }, 'Outbound post-hook error');
        }
      }
    },

    async send(jid: string, text: string): Promise<void> {
      return this.route({
        chatJid: jid,
        text,
        triggerType: 'extension',
      });
    },
  };
}
