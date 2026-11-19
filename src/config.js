'use strict';

/**
 * Single place that reads env config. All secrets come from env only —
 * never hardcode BOT_TOKEN or ADMIN_ID here.
 *
 * Required env (no defaults):
 *   BOT_TOKEN, ADMIN_ID
 * Optional env (defaults shown):
 *   MIN_DISCOUNT=50, DIGEST_TOP_PER_STORE=5, DIGEST_HOUR_IST=9,
 *   BOT_MODE=polling, PORT=3000, DATABASE_PATH=./data/subscribers.db,
 *   WEBHOOK_URL='' (webhook mode only), FEED_URLS='' (blank = built-in 9-store list),
 *   TURSO_DATABASE_URL='' (blank = local file fallback), TURSO_AUTH_TOKEN=''
 *
 * The subscription is free: there is no payment flow, no plan, no expiry.
 *
 * Database URL resolution (config.databaseUrl):
 *   - TURSO_DATABASE_URL set -> used as-is (Turso libsql:// / https:// URL,
 *     or a file: URL).
 *   - otherwise -> `file:<DATABASE_PATH>` (local dev fallback).
 * On Vercel (BOT_MODE=webhook) Turso is required: the local file does not
 * persist between serverless invocations.
 */

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer env var: ${name}=${v}`);
  return n;
}

const tursoUrl = process.env.TURSO_DATABASE_URL || '';
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || '';
const databasePath = process.env.DATABASE_PATH || './data/subscribers.db';

const config = {
  // Secrets — required, no defaults.
  botToken: required('BOT_TOKEN'),
  adminId: Number.parseInt(required('ADMIN_ID'), 10),

  // Digest.
  minDiscount: int('MIN_DISCOUNT', 50),
  digestTopPerStore: int('DIGEST_TOP_PER_STORE', 5),
  digestHourIst: int('DIGEST_HOUR_IST', 9),

  // Runtime.
  botMode: process.env.BOT_MODE || 'polling',
  port: int('PORT', 3000),
  databasePath,

  // Turso (Vercel / production). Blank = local file fallback (see databaseUrl).
  tursoUrl,
  tursoAuthToken,
  databaseUrl: tursoUrl || `file:${databasePath}`,

  // Webhook mode only: public base URL, e.g. https://my-bot.onrender.com
  // (no trailing slash). The bot registers <WEBHOOK_URL>/telegram.
  webhookUrl: (process.env.WEBHOOK_URL || '').replace(/\/$/, ''),

  // Optional override for deal-feed URLs (comma-separated Store=url pairs).
  // Blank = built-in list of the 9 scanner repos' `feed` branches.
  feedUrls: process.env.FEED_URLS || '',
};

if (Number.isNaN(config.adminId)) {
  throw new Error('Invalid integer env var: ADMIN_ID');
}

if (config.botMode === 'webhook' && !config.webhookUrl) {
  throw new Error('BOT_MODE=webhook requires WEBHOOK_URL to be set (public base URL, no trailing slash).');
}
if (config.botMode !== 'polling' && config.botMode !== 'webhook') {
  throw new Error(`Invalid BOT_MODE: ${config.botMode} (use polling or webhook)`);
}

// Webhook / Vercel mode needs Turso — a local SQLite file does not persist
// on Vercel between serverless invocations.
if (config.botMode === 'webhook' && !config.tursoUrl) {
  throw new Error('BOT_MODE=webhook requires TURSO_DATABASE_URL to be set (local file does not persist on Vercel).');
}

// A remote Turso URL needs an auth token; file: URLs never need one.
const isRemoteTursoUrl =
  config.tursoUrl.startsWith('libsql://') || config.tursoUrl.startsWith('https://');
if (isRemoteTursoUrl && !config.tursoAuthToken) {
  throw new Error('TURSO_DATABASE_URL is a remote Turso URL but TURSO_AUTH_TOKEN is not set.');
}

module.exports = config;
