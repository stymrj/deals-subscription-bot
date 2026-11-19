// jobs.js — scheduled work for the subscription bot.
//   startJobs(bot, db, config) wires one node-cron job (Asia/Kolkata) in
//   LOCAL/POLLING mode only:
//     every 15 minutes digest — fetches the 9 store feeds, selects the
//             top deals (same filter/sort/cut as src/digest.js), drops
//             any deal already posted within the last 7 days (persistent
//             dedupe in the posted_deals table, see src/dedupe.js), and
//             sends only the new deals to every active subscriber.
//             If no store has anything new, nothing is sent at all.
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
const { DEDUPE_WINDOW_MS, dealKey, selectDeals } = require('./dedupe');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TZ = 'Asia/Kolkata';

function chatIdOf(sub) {
  return sub.telegram_id ?? sub.user_id ?? sub.chat_id ?? sub.telegramId ?? sub.id;
}

async function runDigest(bot, db, config = {}, deps = {}) {
  const deals = await fetchDeals(deps.feedUrls, deps.fetchFn);
  // Same filter/sort/top-N cut as formatDigest (see selectDeals in
  // src/dedupe.js — it must stay in sync with src/digest.js).
  const selected = selectDeals(deals, config);
  const now = Date.now();
  // Persistent dedupe: drop any selected deal already posted within the
  // last 7 days. A store without the dedupe methods (e.g. a minimal test
  // stub) is treated as having no recent posts — the real store from
  // initDb always implements them.
  const recent = typeof db.getRecentPostedKeys === 'function'
    ? await db.getRecentPostedKeys(now - DEDUPE_WINDOW_MS)
    : new Set();
  const newDeals = {};
  const keysToMark = [];
  let newCount = 0;
  for (const [store, list] of Object.entries(selected)) {
    const fresh = [];
    for (const deal of list) {
      const key = dealKey(store, deal);
      if (recent.has(key)) continue;
      fresh.push(deal);
      keysToMark.push({ deal_key: key, store, title: deal.title, posted_at: now });
    }
    if (fresh.length) { newDeals[store] = fresh; newCount += fresh.length; }
  }
  const subs = (await db.getActiveSubscribers()) || [];
  // Nothing new anywhere: send nothing at all — no "no deals" message,
  // no sendMessage calls. The subscriber count above is still real.
  if (newCount === 0) {
    return { sent: 0, failed: [], subscribers: subs.length, messages: 0, newDeals: 0 };
  }
  const messages = formatDigest(newDeals, config);
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
  // Record the sent keys only if at least one subscriber received them,
  // so a failed / subscriber-less run does not burn the deals.
  if (sent > 0 && typeof db.markPosted === 'function') {
    await db.markPosted(keysToMark);
  }
  return { sent, failed, subscribers: subs.length, messages: messages.length, newDeals: newCount };
}

function startJobs(bot, db, config = {}) {
  // Webhook mode (Vercel): no in-process cron — GitHub Actions triggers
  // runDigest via the /api/cron-digest endpoint. Scheduling here as well
  // would double-send.
  if (config.botMode === 'webhook') {
    return {
      digestJob: null,
      stop() {},
    };
  }
  // Local/polling mode: every 15 minutes (Asia/Kolkata), matching the
  // production cadence (GitHub Actions calls the /api/cron-digest endpoint
  // every 15 minutes; the 7-day posted_deals dedupe stops re-sends).
  const digestJob = cron.schedule('*/15 * * * *', () => {
    runDigest(bot, db, config).catch(err => console.error('[jobs] digest failed:', err));
  }, { timezone: TZ });
  return {
    digestJob,
    stop() { digestJob.stop(); },
  };
}

module.exports = { startJobs, runDigest, chatIdOf };
