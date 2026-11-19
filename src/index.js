'use strict';

// LOCAL-DEV ENTRY POINT ONLY.
// Vercel does NOT use index.js — on Vercel the bot runs serverless via
// api/webhook.js (Telegram webhook) + api/cron-digest.js (15-min digest endpoint),
// built by another worker. `npm run dev` / `npm start` here means polling
// mode (BOT_MODE=polling, the default); webhook mode below is kept for a
// 24/7 non-Vercel server only.

require('dotenv').config();
const config = require('./config');
const { initDb } = require('./db');
const { createBot } = require('./bot');

// src/jobs.js (worker 2) exports startJobs(bot, db, config) -> { digestJob, stop() }.
// In webhook mode startJobs schedules nothing (see jobs.js); the digest is
// then triggered by GitHub Actions calling the /api/cron-digest endpoint.
const { startJobs } = require('./jobs');

async function main() {
  // New async store factory (Turso contract): initDb(url) returns a Promise.
  // config.databaseUrl is the Turso/libsql URL (worker 1); fall back to a
  // local file URL derived from the legacy databasePath for local dev.
  const databaseUrl = config.databaseUrl || `file:${config.databasePath}`;
  const store = await initDb(databaseUrl, config.tursoAuthToken);
  const { bot, sendToSubscribers, notifyAdmin } = createBot({ config, store });

  const jobs = startJobs(bot, store, config);

  if (config.botMode === 'webhook') {
    // Telegraf wants the bare domain (no protocol); the webhook path is /telegram.
    const domain = new URL(config.webhookUrl).hostname;
    await bot.launch({
      webhook: { domain, port: config.port, hookPath: '/telegram' },
    });
    console.log(`Bot running in webhook mode: ${config.webhookUrl}/telegram on port ${config.port}`);
  } else {
    await bot.launch();
    console.log('Bot running in polling mode');
  }

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, stopping bot...`);
    if (jobs) jobs.stop();
    bot.stop(signal);
    await store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
