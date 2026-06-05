import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'RUNTIME',
  'TZ',
  'TIMEZONE',
  'VAULT_ROOT',
  'OBSIDIAN_VAULT',
  'BRIGHTDATA_API_TOKEN',
  'BRIGHTDATA_ZONE',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'TWITTER_BEARER_TOKEN',
]);

// Apply TZ from .env BEFORE anything reads timezone-aware APIs.
// launchd does not pass shell env vars to services, so without this the
// service falls back to the Mac's system TZ - which is wrong for users
// whose .env explicitly opts into a different one (Europe/Madrid, etc).
const envTz = envConfig.TZ || envConfig.TIMEZONE;
if (envTz && !process.env.TZ) {
  process.env.TZ = envTz;
}

// Same pattern: launchd does not pass shell env, so VAULT_ROOT/OBSIDIAN_VAULT
// from .env must be lifted into process.env so sandbox-runner's safeEnvKeys
// passlist can forward them to the agent (wiki_* MCP tools depend on this).
if (envConfig.VAULT_ROOT && !process.env.VAULT_ROOT) {
  process.env.VAULT_ROOT = envConfig.VAULT_ROOT;
}
if (envConfig.OBSIDIAN_VAULT && !process.env.OBSIDIAN_VAULT) {
  process.env.OBSIDIAN_VAULT = envConfig.OBSIDIAN_VAULT;
}

// Same pattern for third-party API credentials. sandbox-runner.ts safeEnvKeys
// reads these from process.env to forward to the agent for web_unlock and
// twitter MCP tools, but launchd doesn't pass shell env so .env values were
// silently dropped.
const thirdPartyKeys = [
  'BRIGHTDATA_API_TOKEN',
  'BRIGHTDATA_ZONE',
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'TWITTER_BEARER_TOKEN',
] as const;
for (const key of thirdPartyKeys) {
  if (envConfig[key] && !process.env[key]) {
    process.env[key] = envConfig[key];
  }
}

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'ClaudeClaw';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'claudeclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'claudeclaw',
  'sender-allowlist.json',
);
// Code root: where the claudeclaw source/dist lives.
// Derived from this file's location: dist/orchestrator/config.js → ../../
// In developer mode: same as STATE_ROOT.
// In plugin mode: the plugin code directory (different from STATE_ROOT).
const thisDir = path.dirname(new URL(import.meta.url).pathname);
export const CODE_ROOT = path.resolve(thisDir, '..', '..');

// State lives in the current working directory — always.
// In developer mode: cwd is the claudeclaw repo.
// In plugin mode: cwd is whatever directory the user ran `claude` from.
// The directory IS the instance. Multiple instances = multiple directories.
export const STATE_ROOT = process.cwd();

export const STORE_DIR = path.resolve(STATE_ROOT, 'store');
export const GROUPS_DIR = path.resolve(STATE_ROOT, 'groups');
export const LOG_DIR = path.resolve(STATE_ROOT, 'logs');
export const DATA_DIR = path.resolve(STATE_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'claudeclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Webhook server configuration
const webhookEnv = readEnvFile(['WEBHOOK_PORT', 'WEBHOOK_SECRET']);
export const WEBHOOK_PORT = parseInt(
  process.env.WEBHOOK_PORT || webhookEnv.WEBHOOK_PORT || '3100',
  10,
);
export const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || webhookEnv.WEBHOOK_SECRET || '';

// Runtime selection: 'container' (default, Apple Container / Docker) or 'sandbox' (srt)
export const DEFAULT_RUNTIME: 'container' | 'sandbox' =
  (process.env.RUNTIME || envConfig.RUNTIME || 'container') === 'sandbox'
    ? 'sandbox'
    : 'container';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
