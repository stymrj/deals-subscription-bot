// jobs.js — scheduled work for the subscription bot.
//   startJobs(bot, db, config) wires one node-cron job (Asia/Kolkata) in
//   LOCAL/POLLING mode only:
//     09:00 IST daily digest — fetches the 9 store feeds, formats the digest,
//             sends it to every active subscriber (fetch-then-send inside the
//             9:00 job; no separate 8:45 job — one job, one failure surface).
//   In webhook mode (config.botMode === 'webhook', i.e. on Vercel) startJobs
//   schedules NOTHING and returns { digestJob: null, stop() {} }: the Vercel
//   cron function (api/cron-digest.js) triggers runDigest instead, and a
//   second in-process cron job would double-send the digest.
//   runDigest is exported for tests (deps inject fetch, feed URLs, delay).
//   There is no expiry check: the subscription is free and never expires.
//
// Expected interfaces (worker 1 owns bot + db; this module only consumes them):
//   bot.telegram.sendMessage(chatId, text, {parse_mode:'HTML',
//       disable_web_page_preview:true, reply_markup?}) -> Promise
//   db.getActiveSubscribers() -> Promise<[{user_id, ...}]>
//       (status 'active' only — worker 1's contract)
//   config: worker 1's config object (MIN_DISCOUNT, DIGEST_TOP_PER_STORE).
//       Read via the passed object; this module never requires ./config
//       itself, so it works with any config shape the coordinator merges.
'use strict';

const cron = require('node-cron');
const { fetchDeals } = require('./feed');
const { formatDigest } = require('./digest');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TZ = 'Asia/Kolkata';

function chatIdOf(sub) {
  return sub.telegram_id ?? sub.user_id ?? sub.chat_id ?? sub.telegramId ?? sub.id;
}

async function runDigest(bot, db, config = {}, deps = {}) {
  const deals = await fetchDeals(deps.feedUrls, deps.fetchFn);
  const messages = formatDigest(deals, config);
  const subs = (await db.getActiveSubscribers()) || [];
  const delayMs = deps.delayMs ?? 120; // small gap between users (Telegram pacing)
  let sent = 0;
  const failed = [];
  for (const sub of subs) {
    const chatId = chatIdOf(sub);
    if (chatId == null) { failed.push({ sub, error: 'no chat id' }); continue; }
    try {
      for (const msg of messages) {
        await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
      }
      sent++;
    } catch (err) {
      // e.g. user blocked the bot — log and continue with the next subscriber.
      console.warn(`[jobs] digest send failed for ${chatId}: ${err && err.message ? err.message : err}`);
      failed.push({ sub, error: err && err.message ? err.message : String(err) });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return { sent, failed, subscribers: subs.length, messages: messages.length };
}

function startJobs(bot, db, config = {}) {
  // Webhook mode (Vercel): no in-process cron — the Vercel cron function
  // triggers runDigest. Scheduling here as well would double-send.
  if (config.botMode === 'webhook') {
    return {
      digestJob: null,
      stop() {},
    };
  }
  const digestJob = cron.schedule('0 9 * * *', () => {
    runDigest(bot, db, config).catch(err => console.error('[jobs] digest failed:', err));
  }, { timezone: TZ });
  return {
    digestJob,
    stop() { digestJob.stop(); },
  };
}

module.exports = { startJobs, runDigest, chatIdOf };
