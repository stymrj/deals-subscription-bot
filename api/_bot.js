'use strict';

// api/_bot.js — shared lazy bot builder for the Vercel serverless functions.
//
// Both api/webhook.js and api/cron-digest.js need the same thing: a Telegraf
// bot built from the env config + the subscriber store. Serverless functions
// are short-lived and may be re-used across invocations (warm starts), so the
// built bot is cached at module level and re-used — the bot is NEVER
// launched (no bot.launch(), no polling, no local webhook server); the
// webhook function feeds updates in via bot.handleUpdate() and the cron
// function sends via bot.telegram.sendMessage, both of which work without
// launch.
//
// DB contract (worker 1): `initDb(url)` is an ASYNC factory and every store
// method is async. Config carries `config.databaseUrl` (Turso URL, or a
// `file:` fallback for local dev); `config.databasePath` is accepted as a
// fallback so this also works against the pre-worker-1 config shape. The
// `await` below is harmless if a given initDb still returns synchronously.
//
// The store is intentionally NOT closed after a request: closing would break
// reuse of the cached bot on warm invocations, and serverless runtimes
// freeze/reclaim the process anyway.
//
// TEST SEAM (no network, no real credentials):
//   const { getBot, __setTestOverrides, __resetTestOverrides } = require('./_bot');
//   __setTestOverrides({ config, store, initDb, createBot });
//     - config:   replaces require('../src/config') (env config).
//     - store:    replaces the initDb() call entirely (pass a fake async store).
//     - initDb:   replaces the DB factory (e.g. one that throws, to test the
//                 500-on-init-failure path).
//     - createBot: replaces createBot from src/bot.js (rarely needed; the
//                 real createBot is used by default).
//   Any key may be omitted; omitted keys fall back to the real modules.
//   __setTestOverrides() also clears the cached bot; call
//   __resetTestOverrides() after a test to restore production behaviour.
//   Tests must set overrides BEFORE the first getBot() call in that process
//   (or reset them first — setting overrides always drops the cache).

const { createBot } = require('../src/bot');

let cached = null; // Promise<{ bot, store, config, ... }> | null
let testOverrides = null;

function __setTestOverrides(overrides) {
  testOverrides = overrides || null;
  cached = null;
}

function __resetTestOverrides() {
  testOverrides = null;
  cached = null;
}

async function buildBot() {
  const config = (testOverrides && testOverrides.config) || require('../src/config');
  const initDbFn = (testOverrides && testOverrides.initDb) || require('../src/db').initDb;
  const createBotFn = (testOverrides && testOverrides.createBot) || createBot;

  // Worker 1's contract: config.databaseUrl (Turso URL or `file:` fallback).
  const dbUrl = config.databaseUrl || config.databasePath || 'file:./data/subscribers.db';
  const store = (testOverrides && testOverrides.store) || (await initDbFn(dbUrl, config.tursoAuthToken));

  // createBot is a sync factory; it returns { bot, store, config,
  // sendToSubscribers, notifyAdmin }. The bot is NOT launched here.
  return createBotFn({ config, store });
}

function getBot() {
  if (!cached) {
    // On failure drop the cache so a later invocation retries the build
    // instead of re-serving the same rejection.
    cached = buildBot().catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

module.exports = { getBot, __setTestOverrides, __resetTestOverrides };
