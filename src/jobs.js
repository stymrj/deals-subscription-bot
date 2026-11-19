// jobs.js — scheduled work for the subscription bot.
//   startJobs(bot, db, config) wires one node-cron job (Asia/Kolkata) in
//   LOCAL/POLLING mode only:
//     every 15 minutes digest — fetches the 9 store feeds, and for EACH
//             active subscriber selects that user's deals (their enabled
//             stores + their min-discount threshold, same filter/sort/cut
//             as src/digest.js), drops any deal already posted within the
//             last 7 days (persistent dedupe in the posted_deals table,
//             see src/dedupe.js), and sends only the new deals to that
//             subscriber, plus one watch-alert message per fresh deal
//             matching one of their keywords. A subscriber with nothing
//             new gets nothing at all.
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
//   db.getUserPrefs(userId) -> Promise<{user_id, stores, min_discount}>
//       (defaults: all 9 stores, 50). Absent on a minimal stub: runDigest
//       falls back to all stores + the config threshold.
//   db.listAllWatches() -> Promise<[{user_id, keyword}]> (keywords
//       lowercased). Absent on a minimal stub: treated as no watches.
//   config: worker 1's config object (MIN_DISCOUNT, DIGEST_TOP_PER_STORE).
//       Read via the passed object; this module never requires ./config
//       itself, so it works with any config shape the coordinator merges.
'use strict';

const cron = require('node-cron');
const { fetchDeals, STORE_ORDER } = require('./feed');
const { formatDigest } = require('./digest');
const { watchAlert, dealButtons } = require('./design');
const { DEDUPE_WINDOW_MS, dealKey, selectUserDeals } = require('./dedupe');

// reply_markup for one message's Grab Deal buttons (one button per row).
function buttonsMarkup(buttons) {
  if (!buttons || !buttons.length) return undefined;
  return { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TZ = 'Asia/Kolkata';

function chatIdOf(sub) {
  return sub.telegram_id ?? sub.user_id ?? sub.chat_id ?? sub.telegramId ?? sub.id;
}

// Default prefs when the store has no getUserPrefs (minimal test stub):
// every store enabled, threshold from config (same 50 default as
// selectDeals). W1's real store always implements getUserPrefs.
function defaultPrefs(config = {}) {
  return {
    stores: [...STORE_ORDER],
    min_discount: Number(config.MIN_DISCOUNT ?? config.minDiscount ?? 50),
  };
}

// Per-user digest + watch alerts. Deals are fetched once; the recent-posted
// set is computed once; then EACH active subscriber gets only their own
// selection (their stores + their min-discount threshold, fresh deals
// only). A subscriber with zero fresh deals gets nothing — not an error,
// not a failure. Watch alerts fire from the same per-user fresh selection
// (one short message per matching deal per user per run); because alerts
// only fire for fresh deals and every sent fresh key is marked posted at
// the end, a deal is never alerted twice. Returns
// { sent, failed, subscribers, messages, newDeals, alertsSent }:
// sent = users who received >= 1 digest message; messages = total digest
// messages sent; newDeals = total fresh deals across users (a deal sent
// to two users counts twice); alertsSent = watch-alert messages sent.
async function runDigest(bot, db, config = {}, deps = {}) {
  const deals = await fetchDeals(deps.feedUrls, deps.fetchFn);
  const now = Date.now();
  // Persistent dedupe: drop any selected deal already posted within the
  // last 7 days. A store without the dedupe methods (e.g. a minimal test
  // stub) is treated as having no recent posts — the real store from
  // initDb always implements them.
  const recent = typeof db.getRecentPostedKeys === 'function'
    ? await db.getRecentPostedKeys(now - DEDUPE_WINDOW_MS)
    : new Set();
  const subs = (await db.getActiveSubscribers()) || [];

  // Selection phase (no sends yet): per-user prefs + fresh deals.
  // keysToMark is a Map so a deal sent to several users is marked once.
  const keysToMark = new Map();
  const perUser = [];
  let newCount = 0;
  for (const sub of subs) {
    const userId = sub.user_id ?? chatIdOf(sub);
    let prefs = defaultPrefs(config);
    if (typeof db.getUserPrefs === 'function') {
      try {
        const got = await db.getUserPrefs(userId);
        if (got) prefs = got;
      } catch (err) {
        console.warn(`[jobs] getUserPrefs failed for ${userId}: ${err && err.message ? err.message : err} — using defaults`);
      }
    }
    const selected = selectUserDeals(deals, prefs, config);
    const fresh = {};
    for (const [store, list] of Object.entries(selected)) {
      const freshList = [];
      for (const deal of list) {
        const key = dealKey(store, deal);
        if (recent.has(key)) continue;
        freshList.push(deal);
        if (!keysToMark.has(key)) {
          keysToMark.set(key, { deal_key: key, store, title: deal.title, posted_at: now });
        }
      }
      if (freshList.length) fresh[store] = freshList;
    }
    const freshCount = Object.values(fresh).reduce((n, l) => n + l.length, 0);
    newCount += freshCount;
    perUser.push({ sub, userId, prefs, fresh, freshCount });
  }

  // Watches: { userId -> [lowercased keywords] }. A store without
  // listAllWatches (minimal stub) is treated as having no watches.
  const watchesByUser = new Map();
  if (typeof db.listAllWatches === 'function') {
    try {
      const watches = (await db.listAllWatches()) || [];
      for (const w of watches) {
        if (!w || w.user_id == null || !w.keyword) continue;
        const kw = String(w.keyword).toLowerCase();
        if (!watchesByUser.has(w.user_id)) watchesByUser.set(w.user_id, []);
        watchesByUser.get(w.user_id).push(kw);
      }
    } catch (err) {
      console.warn(`[jobs] listAllWatches failed: ${err && err.message ? err.message : err} — no alerts this run`);
      watchesByUser.clear();
    }
  }

  // Sending phase: per-user digest, then that user's watch alerts.
  const delayMs = deps.delayMs ?? 120; // small gap between users (Telegram pacing)
  let sent = 0;
  let messagesSent = 0;
  let alertsSent = 0;
  const failed = [];
  for (const { sub, userId, prefs, fresh } of perUser) {
    const chatId = chatIdOf(sub);
    if (chatId == null) {
      // Only a failure if this user actually had something to receive.
      if (Object.keys(fresh).length) failed.push({ sub, error: 'no chat id' });
      continue;
    }
    // Per-user digest: same min/top as the selection, so a non-empty
    // fresh selection always formats to >= 1 message.
    const messages = formatDigest(fresh, {
      minDiscount: prefs.min_discount,
      DIGEST_TOP_PER_STORE: config.DIGEST_TOP_PER_STORE,
      topPerStore: config.topPerStore,
      date: config.date,
    });
    let userFailed = false;
    try {
      for (const msg of messages) {
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        const markup = buttonsMarkup(msg.buttons);
        if (markup) extra.reply_markup = markup;
        await bot.telegram.sendMessage(chatId, msg.text, extra);
        messagesSent++;
      }
      if (messages.length) sent++;
    } catch (err) {
      // e.g. user blocked the bot — log and continue with the next subscriber.
      console.warn(`[jobs] digest send failed for ${chatId}: ${err && err.message ? err.message : err}`);
      failed.push({ sub, error: err && err.message ? err.message : String(err) });
      userFailed = true;
    }
    // Watch alerts for this user's fresh deals only (their stores +
    // threshold already applied by the selection above). One alert per
    // matching deal; if several keywords match one deal, the first wins.
    // Skipped when the digest send just failed (the user is unreachable).
    if (!userFailed) {
      const keywords = watchesByUser.get(userId) || [];
      if (keywords.length) {
        for (const [store, list] of Object.entries(fresh)) {
          for (const deal of list) {
            const title = String(deal.title || '').toLowerCase();
            const hit = keywords.find(kw => kw && title.includes(kw));
            if (!hit) continue;
            try {
              // One alert per matching deal, built by the shared design
              // helper (alert line + shared dealCard + footer), with the
              // same Grab Deal button as every other deal surface.
              const alertExtra = { parse_mode: 'HTML', disable_web_page_preview: true };
              const alertMarkup = buttonsMarkup(dealButtons(deal));
              if (alertMarkup) alertExtra.reply_markup = alertMarkup;
              await bot.telegram.sendMessage(
                chatId,
                watchAlert(hit, deal, store),
                alertExtra
              );
              alertsSent++;
            } catch (err) {
              console.warn(`[jobs] watch alert send failed for ${chatId}: ${err && err.message ? err.message : err}`);
              failed.push({ sub, error: err && err.message ? err.message : String(err) });
            }
          }
        }
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  // Record the sent keys only if at least one digest or alert message
  // went out, so a failed / subscriber-less run does not burn the deals.
  // Keys are the union across users (a deal sent to user A is therefore
  // not re-sent to user B in a later run within the window).
  if ((messagesSent > 0 || alertsSent > 0) && typeof db.markPosted === 'function') {
    await db.markPosted([...keysToMark.values()]);
  }
  return { sent, failed, subscribers: subs.length, messages: messagesSent, newDeals: newCount, alertsSent };
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
