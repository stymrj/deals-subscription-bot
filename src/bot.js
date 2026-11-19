'use strict';

const { Telegraf, Markup } = require('telegraf');
const { STORE_ORDER, fetchDeals: defaultFetchDeals } = require('./feed');
const { formatDigest, dealLine } = require('./digest');
const { selectUserDeals } = require('./dedupe');

const IST = 'Asia/Kolkata';

// Polite one-liner for /deals and /top when nothing matches the user's
// stores + discount threshold. Sent exactly once, never as a digest.
const NO_DEALS_LINE =
  'No deals right now matching your stores and discount threshold — check back soon, fresh deals arrive every 15 minutes.';

const MAX_WATCH_KEYWORD_LEN = 40;

function fmtDateTimeIst(epochMs) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

/**
 * Next digest time as a human-readable IST string: the next 15-minute
 * boundary strictly after nowMs (digests run every 15 minutes, not once
 * a day at a fixed hour — so an exact-boundary now shows the following
 * boundary, the update for the current one already being sent).
 * digestHourIst is ignored — kept in the signature so existing callers
 * (statusText, subscribe reply) need no change.
 */
function nextDigestLabel(nowMs, _digestHourIst) {
  const istNow = new Date(nowMs + 5.5 * 60 * 60 * 1000); // shift to IST wall clock
  const mins = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const next = (Math.floor(mins / 15) + 1) * 15; // minutes after IST midnight; may pass 1440
  const target = new Date(istNow);
  target.setUTCHours(0, next, 0, 0); // overflow past midnight rolls the date forward
  // target is a UTC-shifted date; convert back to a real epoch ms.
  const targetEpoch = target.getTime() - 5.5 * 60 * 60 * 1000;
  return fmtDateTimeIst(targetEpoch);
}

// The one shared store list: /start and /help both render from STORE_ORDER
// (src/feed.js) so the two messages can never drift apart.
function storeListText() {
  return STORE_ORDER.map((s) => `• ${s}`).join('\n');
}

// The one shared command list: /start and /help both render from here so
// the two messages can never drift apart. Includes the store list above.
function commandsText() {
  return (
    `Stores we track:\n${storeListText()}\n\n` +
    `Commands:\n` +
    `/start — subscribe for free, or check status\n` +
    `/status — your subscription status and next digest time\n` +
    `/stores — pick which stores your digest covers\n` +
    `/setdiscount <10-90> — only show deals at that discount or more\n` +
    `/deals — matching deals right now, on demand\n` +
    `/top — the single best deal right now\n` +
    `/watch <keyword> — alert me when a matching deal appears\n` +
    `/unwatch <keyword> — stop watching a keyword\n` +
    `/watchlist — your watched keywords\n` +
    `/myid — your numeric Telegram id\n` +
    `/stop — stop the deal updates\n` +
    `/help — this help\n\n` +
    `Admin: /subscribers, /broadcast <text>`
  );
}

function displayName(from) {
  const parts = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return parts || from.username || String(from.id);
}

/**
 * Build the bot. Does NOT launch it — src/index.js does that.
 *
 * The subscription is free: Subscribe is instant, there is no payment
 * flow, no plan and no expiry.
 *
 * @param {object} opts
 * @param {object} opts.config - from src/config.js
 * @param {object} opts.store  - from src/db.js initDb()
 * @param {function} [opts.fetchDeals] - optional override for the feed
 *   fetcher (defaults to src/feed fetchDeals, which reads FEED_URLS from
 *   the environment). Injectable so tests can serve fixture deals without
 *   network. Called with no arguments.
 * @returns {{ bot: Telegraf, store: object, config: object,
 *             sendToSubscribers: function, notifyAdmin: function }}
 *
 * INTERFACE FOR WORKER 2 (jobs/digest):
 *   - `sendToSubscribers(text)` — sends the same text to every subscriber
 *     whose status is 'active'. Returns Promise<{ sent: number, failed: number }>.
 *   - `bot.telegram.sendMessage(userId, text, extra)` — send to one user.
 *   - `store.getActiveSubscribers()` — async, returns [{ user_id, name,
 *     username, status, ... }] — the live list of digest recipients.
 *     All store methods are async (see the Turso/async store contract).
 *   - `bot` itself is the Telegraf instance, exported for jobs to use.
 *
 * USER PREFS + WATCHLIST (Worker 1 owns src/db.js; bot.js calls the store
 * ONLY through these signatures):
 *   - `store.getUserPrefs(userId)` -> { user_id, stores, min_discount }
 *   - `store.setUserStores(userId, storesArray)` -> prefs object
 *   - `store.setUserMinDiscount(userId, min)` -> prefs object
 *   - `store.addWatch(userId, keyword)` -> { added, reason?, count }
 *   - `store.removeWatch(userId, keyword)` -> { removed }
 *   - `store.listWatch(userId)` -> string[]
 */
function createBot({ config, store, fetchDeals: fetchDealsOverride }) {
  const bot = new Telegraf(config.botToken);
  const adminId = config.adminId;
  const fetchDealsFn = fetchDealsOverride || defaultFetchDeals;

  const welcomeText = () =>
    `👋 Welcome to PriceDrop Hunter!\n\n` +
    `🆓 Free subscription — fresh deals every 15 minutes, only 50%+ off, duplicates removed.\n\n` +
    `${commandsText()}\n\n` +
    `Tap below to get started:`;

  const startKeyboard = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback('Subscribe — free', 'subscribe')],
      [Markup.button.callback('My status', 'status')],
    ]);

  async function ensureSubscriber(ctx) {
    const from = ctx.from;
    return await store.upsertSubscriber({
      user_id: from.id,
      name: displayName(from),
      username: from.username || null,
    });
  }

  function isAdmin(ctx) {
    return ctx.from && ctx.from.id === adminId;
  }

  // Prefs/watchlist with safe defaults when the store does not implement
  // them (e.g. a minimal stub in another suite): /status must never crash
  // on a store that predates the prefs feature.
  async function loadPrefs(userId) {
    if (typeof store.getUserPrefs === 'function') return await store.getUserPrefs(userId);
    return { user_id: userId, stores: [...STORE_ORDER], min_discount: 50 };
  }

  async function loadWatchCount(userId) {
    if (typeof store.listWatch === 'function') return (await store.listWatch(userId)).length;
    return 0;
  }

  async function loadStatusExtra(userId) {
    return { prefs: await loadPrefs(userId), watchCount: await loadWatchCount(userId) };
  }

  function statusText(sub, extra = {}) {
    const subscribed = sub && sub.status === 'active';
    const statusLabel = subscribed ? 'subscribed' : 'not subscribed';
    const prefs = extra.prefs || { stores: [...STORE_ORDER], min_discount: 50 };
    const min = Number.isInteger(prefs.min_discount) ? prefs.min_discount : 50;
    const enabledCount = Array.isArray(prefs.stores) ? prefs.stores.length : STORE_ORDER.length;
    const watchCount = Number.isInteger(extra.watchCount) ? extra.watchCount : 0;
    return (
      `📋 Your subscription\n\n` +
      `Free subscriber\n` +
      `Status: ${statusLabel}\n` +
      `Min. discount: ${min}%\n` +
      `Stores: ${enabledCount} of ${STORE_ORDER.length} enabled\n` +
      `Watchlist: ${watchCount} keyword(s)\n` +
      `Fresh deals every 15 minutes · ${min}%+ off · duplicates removed\n` +
      `Next digest: ${nextDigestLabel(Date.now(), config.digestHourIst)}` +
      (subscribed
        ? ''
        : `\n\nTap /start and hit Subscribe to join — it's free.`)
    );
  }

  // ---------- /stores helpers ----------

  function storesText(prefs) {
    const lines = STORE_ORDER.map(
      (s) => `${prefs.stores.includes(s) ? '✅' : '❌'} ${s}`
    );
    return (
      `🏬 Your stores\n\n` +
      `${lines.join('\n')}\n\n` +
      `Tap a store to turn it on/off for your digest.`
    );
  }

  function storesKeyboard(prefs) {
    const rows = [];
    for (let i = 0; i < STORE_ORDER.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, STORE_ORDER.length); j++) {
        const on = prefs.stores.includes(STORE_ORDER[j]);
        // Callback data carries the store INDEX, never the name: store
        // names contain spaces and callback data must stay compact.
        row.push(Markup.button.callback(`${on ? '✅' : '❌'} ${STORE_ORDER[j]}`, `store:toggle:${j}`));
      }
      rows.push(row);
    }
    return Markup.inlineKeyboard(rows);
  }

  // ---------- /deals + /top helper ----------

  // Fetch the feeds and select the deals matching this user's stores and
  // discount threshold. Reads dedupe state NEVER and writes it NEVER:
  // on-demand commands must not burn deals for the scheduled digest.
  async function fetchSelectedForUser(ctx) {
    await ensureSubscriber(ctx);
    const prefs = await loadPrefs(ctx.from.id);
    const deals = await fetchDealsFn();
    const selected = selectUserDeals(deals, prefs, config);
    return { prefs, selected };
  }

  // ---------- Watch helpers ----------

  // Everything after "/<command>" (plus an optional "@botname"), trimmed.
  function keywordArg(ctx, command) {
    const re = new RegExp(`^/${command}(@\\w+)?\\s*`);
    return (ctx.message.text || '').replace(re, '').trim();
  }

  // ---------- Commands ----------

  bot.start(async (ctx) => {
    await ensureSubscriber(ctx);
    await ctx.reply(welcomeText(), startKeyboard());
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      `PriceDrop Hunter — Fresh Deals\n\n` +
        `🆓 Free subscription — fresh deals every 15 minutes, only 50%+ off, duplicates removed.\n\n` +
        `${commandsText()}`
    );
  });

  bot.command('status', async (ctx) => {
    const sub = await ensureSubscriber(ctx);
    await ctx.reply(statusText(sub, await loadStatusExtra(ctx.from.id)), startKeyboard());
  });

  bot.command('stop', async (ctx) => {
    const sub = await ensureSubscriber(ctx);
    if (!sub || sub.status !== 'active') {
      await ctx.reply("You're not subscribed — you have no active subscription to stop. Tap /start and hit Subscribe to join for free.");
      return;
    }
    await store.setStatus(ctx.from.id, 'expired');
    await ctx.reply(
      'Your subscription is stopped — you will no longer receive the deal updates. ' +
      'Tap /start to subscribe again (free).'
    );
  });

  bot.command('myid', async (ctx) => {
    await ctx.reply(`Your Telegram id is: ${ctx.from.id}`);
  });

  bot.command('stores', async (ctx) => {
    await ensureSubscriber(ctx);
    const prefs = await loadPrefs(ctx.from.id);
    await ctx.reply(storesText(prefs), storesKeyboard(prefs));
  });

  bot.command('setdiscount', async (ctx) => {
    await ensureSubscriber(ctx);
    const arg = (ctx.message.text || '')
      .replace(/^\/setdiscount(@\w+)?\s*/, '').trim().split(/\s+/)[0] || '';
    const prefs = await loadPrefs(ctx.from.id);
    const n = Number.parseInt(arg, 10);
    const valid = /^\d+$/.test(arg) && Number.isInteger(n) && n >= 10 && n <= 90;
    if (!valid) {
      await ctx.reply(
        `Usage: /setdiscount <10-90> — e.g. /setdiscount 30. Your current threshold is ${prefs.min_discount}%.`
      );
      return;
    }
    await store.setUserMinDiscount(ctx.from.id, n);
    await ctx.reply(
      `✅ Minimum discount set to ${n}%. Your digest will only include deals at ${n}% off or more.`
    );
  });

  bot.command('deals', async (ctx) => {
    const { prefs, selected } = await fetchSelectedForUser(ctx);
    if (Object.keys(selected).length === 0) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    const messages = formatDigest(selected, {
      minDiscount: prefs.min_discount,
      topPerStore: config.digestTopPerStore ?? config.topPerStore ?? 5,
    });
    if (messages.length === 0) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    for (const msg of messages) {
      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
  });

  bot.command('top', async (ctx) => {
    const { selected } = await fetchSelectedForUser(ctx);
    let best = null;
    let bestStore = null;
    for (const [storeName, list] of Object.entries(selected)) {
      for (const deal of list) {
        const saving = deal.mrp - deal.price;
        const bestSaving = best ? best.mrp - best.price : -Infinity;
        if (!best || deal.disc > best.disc || (deal.disc === best.disc && saving > bestSaving)) {
          best = deal;
          bestStore = storeName;
        }
      }
    }
    if (!best) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    await ctx.reply(
      `<b>🏆 Top deal right now</b>\n${dealLine(best, bestStore)}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('watch', async (ctx) => {
    await ensureSubscriber(ctx);
    const keyword = keywordArg(ctx, 'watch');
    if (!keyword) {
      await ctx.reply('Usage: /watch <keyword> — e.g. /watch headphones');
      return;
    }
    if (keyword.length > MAX_WATCH_KEYWORD_LEN) {
      await ctx.reply('That keyword is too long — please keep watch keywords to 40 characters or fewer.');
      return;
    }
    const res = await store.addWatch(ctx.from.id, keyword);
    if (res.added) {
      await ctx.reply(`🔔 Watching "${keyword}" — I'll alert you when a matching deal appears.`);
    } else if (res.reason === 'limit') {
      await ctx.reply('You already have 10 keywords — remove one with /unwatch <keyword> first.');
    } else {
      await ctx.reply(`You're already watching "${keyword}".`);
    }
  });

  bot.command('unwatch', async (ctx) => {
    await ensureSubscriber(ctx);
    const keyword = keywordArg(ctx, 'unwatch');
    if (!keyword) {
      await ctx.reply('Usage: /unwatch <keyword> — e.g. /unwatch headphones');
      return;
    }
    if (keyword.length > MAX_WATCH_KEYWORD_LEN) {
      await ctx.reply('That keyword is too long — please keep watch keywords to 40 characters or fewer.');
      return;
    }
    const res = await store.removeWatch(ctx.from.id, keyword);
    if (res.removed) {
      await ctx.reply(`Stopped watching "${keyword}".`);
    } else {
      await ctx.reply(`"${keyword}" wasn't in your watchlist.`);
    }
  });

  bot.command('watchlist', async (ctx) => {
    await ensureSubscriber(ctx);
    const list = typeof store.listWatch === 'function' ? await store.listWatch(ctx.from.id) : [];
    if (!list.length) {
      await ctx.reply('Your watchlist is empty. Use /watch <keyword> to add one.');
      return;
    }
    await ctx.reply(`🔔 Your watchlist:\n${list.map((k) => `• ${k}`).join('\n')}`);
  });

  bot.command('subscribers', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('This command is for the admin only.');
      return;
    }
    const all = await store.listSubscribers();
    let active = 0;
    let stopped = 0;
    for (const s of all) {
      if (s.status === 'active') active += 1;
      else stopped += 1;
    }
    const lines = all.slice(0, 20).map((s) => {
      const label = s.status === 'active' ? 'subscribed' : 'stopped';
      return `${s.name || '—'} (@${s.username || '—'}) — ${label}`;
    });
    await ctx.reply(
      `📊 Subscribers: ${all.length} total\n` +
        `Active: ${active} • Stopped: ${stopped}\n\n` +
        (lines.join('\n') || 'No subscribers yet.')
    );
  });

  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('This command is for the admin only.');
      return;
    }
    const text = (ctx.message.text || '').replace(/^\/broadcast\s*/, '').trim();
    if (!text) {
      await ctx.reply('Usage: /broadcast <text>');
      return;
    }
    const result = await sendToSubscribers(text);
    await ctx.reply(`Sent to ${result.sent} subscribers, ${result.failed} failed.`);
  });

  // ---------- Inline buttons ----------

  bot.action('subscribe', async (ctx) => {
    await ctx.answerCbQuery();
    await ensureSubscriber(ctx);
    await store.setStatus(ctx.from.id, 'active');
    await ctx.reply(
      `🎉 You're subscribed — for free!\n\n` +
        `Fresh deals arrive every 15 minutes.\n` +
        `Next digest: ${nextDigestLabel(Date.now(), config.digestHourIst)}.\n\n` +
        `Happy deal hunting! 🛒`,
      startKeyboard()
    );
  });

  bot.action('status', async (ctx) => {
    await ctx.answerCbQuery();
    const sub = await ensureSubscriber(ctx);
    await ctx.reply(statusText(sub, await loadStatusExtra(ctx.from.id)), startKeyboard());
  });

  // Callback data: `store:toggle:<index>` — index into STORE_ORDER.
  bot.action(/^store:toggle:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = Number(ctx.match[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= STORE_ORDER.length) return;
    const prefs = await loadPrefs(ctx.from.id);
    const storeName = STORE_ORDER[idx];
    const enabled = prefs.stores.includes(storeName);
    const next = enabled
      ? prefs.stores.filter((s) => s !== storeName)
      : STORE_ORDER.filter((s) => s === storeName || prefs.stores.includes(s));
    const updated = typeof store.setUserStores === 'function'
      ? await store.setUserStores(ctx.from.id, next)
      : { user_id: ctx.from.id, stores: next, min_discount: prefs.min_discount };
    await ctx.editMessageText(storesText(updated), storesKeyboard(updated));
  });

  // ---------- Photos and free text ----------

  // Photos used to be payment proof; the bot is free now, so a photo is
  // never a payment — just tell the user no payment is needed.
  bot.on('photo', async (ctx) => {
    const sub = await ensureSubscriber(ctx);
    if (sub && sub.status === 'active') {
      await ctx.reply("No payment needed — you're already subscribed for free, fresh deals arrive every 15 minutes.");
    } else {
      await ctx.reply('No payment needed — this bot is free. Tap /start and hit Subscribe.');
    }
  });

  bot.on('text', async (ctx) => {
    // Non-command chit-chat is ignored. There is no payment flow, so no
    // text is ever treated as a payment reference.
    return;
  });

  // ---------- Digest / broadcast helper (used by src/jobs.js, worker 2) ----------

  async function sendToSubscribers(text) {
    const recipients = await store.getActiveSubscribers();
    let sent = 0;
    let failed = 0;
    for (const sub of recipients) {
      try {
        await bot.telegram.sendMessage(sub.user_id, text, { parse_mode: 'HTML' });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`Digest send failed for user ${sub.user_id}:`, err.message);
      }
    }
    return { sent, failed };
  }

  async function notifyAdmin(text) {
    await bot.telegram.sendMessage(adminId, text);
  }

  return { bot, store, config, sendToSubscribers, notifyAdmin };
}

module.exports = { createBot, nextDigestLabel };
