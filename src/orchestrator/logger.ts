import pino from 'pino';
import { resolve } from 'path';

// Hermes-style rotation: agent.log (info+, big rotation), errors.log (warn+, small).
// pino-roll handles size-based rotation + retention count (count = backups).
// Secrets redacted via pino's built-in redact paths.

const LOGS_DIR = resolve(process.cwd(), 'logs');
const ROOT_LEVEL = process.env.LOG_LEVEL || 'info';

// Allow tests / one-off dev runs to keep the old pretty-console behavior.
// In service mode (launchd) we always rotate to files.
const PRETTY_CONSOLE = process.env.CLAUDECLAW_LOG_PRETTY === '1';

const targets: pino.TransportTargetOptions[] = PRETTY_CONSOLE
  ? [{ target: 'pino-pretty', level: ROOT_LEVEL, options: { colorize: true } }]
  : [
      {
        target: 'pino-roll',
        level: ROOT_LEVEL,
        options: {
          file: resolve(LOGS_DIR, 'agent.log'),
          size: '100m',
          limit: { count: 5 },
          mkdir: true,
        },
      },
      {
        target: 'pino-roll',
        level: 'warn',
        options: {
          file: resolve(LOGS_DIR, 'errors.log'),
          size: '20m',
          limit: { count: 3 },
          mkdir: true,
        },
      },
    ];

export const logger = pino({
  level: ROOT_LEVEL,
  redact: {
    paths: [
      'token',
      'apiKey',
      'api_key',
      'bearer',
      'authorization',
      'Authorization',
      'password',
      'secret',
      '*.token',
      '*.apiKey',
      '*.api_key',
      '*.bearer',
      '*.password',
      '*.secret',
      '*.authorization',
      '*.Authorization',
      'env.TWITTER_BEARER_TOKEN',
      'env.ANTHROPIC_API_KEY',
      'env.OPENAI_API_KEY',
      'env.TELEGRAM_BOT_TOKEN',
      'env.SLACK_BOT_TOKEN',
      'env.SLACK_APP_TOKEN',
      'env.WEBHOOK_SECRET',
      'env.BRIGHTDATA_TOKEN',
    ],
    censor: '[REDACTED]',
  },
  transport: { targets },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
