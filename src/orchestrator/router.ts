import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// For XML text content (between tags) — `"` is legal here, only &/</> need escaping.
// Using full escapeXml would produce ugly &quot; in chat history visible to the agent.
export function escapeXmlContent(s: string): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MAX_MESSAGE_CHARS = 20000;

function truncateContent(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  const kept = content.slice(0, MAX_MESSAGE_CHARS);
  const dropped = content.length - MAX_MESSAGE_CHARS;
  return `${kept}\n\n[... truncated ${dropped} chars to fit context ...]`;
}

function renderMsgLine(
  m: {
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me?: boolean;
  },
  timezone: string,
): string {
  const displayTime = formatLocalTime(m.timestamp, timezone);
  const content = truncateContent(m.content);
  const sender = m.is_from_me ? 'GLaDOS' : m.sender_name;
  return `<message sender="${escapeXml(sender)}" time="${escapeXml(displayTime)}">${escapeXmlContent(content)}</message>`;
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  history?: Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me?: boolean;
  }>,
): string {
  const newLines = messages.map((m) => renderMsgLine(m, timezone));
  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  const instructions = [
    '<!-- IMPORTANT: Read each NEW message carefully by its actual content.',
    '     Do not assume a new message is about a previously discussed topic.',
    '     If a message contains [Voice: ...] read the transcript inside it -',
    '     two voice messages can have completely different topics even if',
    '     sent close in time. Never claim "уже сделала" or "already done"',
    '     unless the new message text actually matches what you completed.',
    '     The <history> block below contains EARLIER messages in this chat',
    '     (read-only, for context). The <messages> block is what you must',
    '     respond to. If user references "видео из прошлого" / "то что я',
    '     писал утром" — search history for it. -->',
  ].join('\n');

  let historyBlock = '';
  if (history && history.length > 0) {
    const histLines = history.map((m) => renderMsgLine(m, timezone));
    historyBlock = `<history previousMessages="${history.length}">\n${histLines.join('\n')}\n</history>\n`;
  }

  let messageCountReminder = '';
  if (newLines.length >= 2) {
    messageCountReminder =
      `\n<!-- IMPORTANT: Read each NEW message carefully by its actual content.\n` +
      `     Do not assume a new message is about a previously discussed topic.\n` +
      `     If a message contains [Voice: ...] read the transcript inside it -\n` +
      `     two voice messages can have completely different topics even if\n` +
      `     sent close in time. Never claim "уже сделала" or "already done"\n` +
      `     unless the new message text actually matches what you completed.\n` +
      `     The <history> block below contains EARLIER messages in this chat\n` +
      `     (read-only, for context). The <messages> block is what you must\n` +
      `     respond to. If user references "видео из прошлого" / "то что я\n` +
      `     писал утром" — search history for it. -->`;
  }

  return `${header}${instructions}\n${historyBlock}<messages>\n${newLines.join('\n')}\n</messages>${messageCountReminder}`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Strip internal tags from a possibly-incomplete streaming chunk.
 * Drops complete <internal>...</internal> blocks AND truncates any unclosed
 * <internal> at end-of-text (so partials never leak hidden content).
 * Also drops a stray closing </internal> with no preceding open tag.
 */
export function stripInternalTagsStreaming(text: string): string {
  let s = text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
  const openIdx = s.lastIndexOf('<internal>');
  if (openIdx !== -1) s = s.slice(0, openIdx);
  s = s.replace(/<\/internal>/g, '');
  return decodeHtmlEntities(s).trim();
}

// Agents sometimes emit HTML entities (&quot;, &amp;, etc.) in plain-text
// output - likely cargo-culted from the <history>/<message> XML wrappers
// around prompt content. Decode them back to literals before sending to
// the user and before persisting, otherwise the next turn sees its own
// escaped output in history and reinforces the pattern (feedback loop).
export function decodeHtmlEntities(s: string): string {
  if (!s) return s;
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return decodeHtmlEntities(text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
