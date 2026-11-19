'use strict';

const { Telegraf, Markup } = require('telegraf');
const { STORE_ORDER, fetchDeals: defaultFetchDeals } = require('./feed');
const { formatDigest } = require('./digest');
const {
  header,
  footer,
  cadenceLine,
  storeLabel,
  dealCard,
  dealButtons,
  noDealsLine,
  escapeHtml,
  MAX_LEN,
} = require('./design');
const { selectUserDeals } = require('./dedupe');

const IST = 'Asia/Kolkata';

// Polite one-liner for /deals and /top when nothing matches the user's
// stores + discount threshold. Sent exactly once, never as a digest.
const NO_DEALS_LINE = noDealsLine();

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
  return STORE_ORDER.map((s) => `• ${storeLabel(s)}`).join('\n');
}

// The one shared command list: /start and /help both render from here so
// the two messages can never drift apart. Includes the store list above.
function commandsText() {
  return (
    `Stores we track:\n${storeListText()}\n\n` +
    `🔥 Deals — right now:\n` +
    `/deals — matching deals right now, on demand\n` +
    `/hot — biggest saving right now\n` +
    `/top — steepest discount right now\n` +
    `/search <keyword> — find deals by name\n\n` +
    `⚙️ Your digest:\n` +
    `/start — subscribe for free, or check status\n` +
    `/status — your subscription status and next digest time\n` +
    `/stores — pick which stores your digest covers\n` +
    `/setdiscount <10-90> — only show deals at that discount or more\n\n` +
    `🔔 Watchlist:\n` +
    `/watch <keyword> — alert me when a matching deal appears\n` +
    `/unwatch <keyword> — stop watching a keyword\n` +
    `/watchlist — your watched keywords\n\n` +
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
    `${header('Welcome')}\n\n` +
    `🎉 Free subscription — no payment needed. 9 stores, fresh deals every 15 minutes, 50%+ off only.\n` +
    `🔥 Hottest deals land here first — tap Subscribe and you're in.\n\n` +
    `${cadenceLine(50)}\n\n` +
    `${commandsText()}\n\n` +
    `Tap below to get started:${footer()}`;

  const startKeyboard = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback('🎉 Subscribe — free', 'subscribe')],
      [Markup.button.callback('🔥 Hottest deal now', 'hot')],
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
      `${header('Your subscription')}\n\n` +
      `Free subscriber\n` +
      `<b>Status:</b> ${statusLabel}${subscribed ? ' ✅' : ' ❌'}\n` +
      `🎯 <b>Min. discount:</b> ${min}%\n` +
      `🏪 <b>Stores:</b> ${enabledCount} of ${STORE_ORDER.length} enabled\n` +
      `🔔 <b>Watchlist:</b> ${watchCount} keyword(s)\n` +
      `${cadenceLine(min)}\n` +
      `📅 <b>Next digest:</b> ${nextDigestLabel(Date.now(), config.digestHourIst)}` +
      (subscribed
        ? footer()
        : `\n\nTap /start and hit Subscribe to join — it's free.${footer()}`)
    );
  }

  // ---------- /stores helpers ----------

  function storesText(prefs) {
    const lines = STORE_ORDER.map(
      (s) => `${prefs.stores.includes(s) ? '✅' : '❌'} ${storeLabel(s)}`
    );
    return (
      `${header('Your stores')}\n\n` +
      `${lines.join('\n')}\n\n` +
      `Tap a store to turn it on/off for your digest.${footer()}`
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
        row.push(Markup.button.callback(`${on ? '✅' : '❌'} ${storeLabel(STORE_ORDER[j])}`, `store:toggle:${j}`));
      }
      rows.push(row);
    }
    return Markup.inlineKeyboard(rows);
  }

  // ---------- /deals + /top + /hot + /search helpers ----------

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

  // Best deal in a selection: highest discount, ties broken by biggest
  // rupee saving (same rule as formatDigest's per-store sort).
  function bestDealByDisc(selected) {
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
    return best ? { deal: best, store: bestStore } : null;
  }

  // Hottest deal: biggest rupee saving (different pick from /top, which
  // is the steepest discount). Ties broken by higher discount.
  function bestDealBySaving(selected) {
    let best = null;
    let bestStore = null;
    for (const [storeName, list] of Object.entries(selected)) {
      for (const deal of list) {
        const saving = deal.mrp - deal.price;
        const bestSaving = best ? best.mrp - best.price : -Infinity;
        if (!best || saving > bestSaving || (saving === bestSaving && deal.disc > best.disc)) {
          best = deal;
          bestStore = storeName;
        }
      }
    }
    return best ? { deal: best, store: bestStore } : null;
  }

  // Send one formatDigest message object: text + its Grab Deal buttons.
  async function sendRichMessage(ctx, msg, extraRows) {
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
    const rows = (msg.buttons || []).map((b) => [{ text: b.text, url: b.url }]);
    if (extraRows && extraRows.length) rows.push(...extraRows);
    if (rows.length) extra.reply_markup = { inline_keyboard: rows };
    await ctx.reply(msg.text, extra);
  }

  // Store quick-filter buttons for /deals: one per store + All stores.
  // Callback data carries the store INDEX, never the name.
  function dealsFilterKeyboard() {
    const rows = [];
    for (let i = 0; i < STORE_ORDER.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, STORE_ORDER.length); j++) {
        row.push(Markup.button.callback(storeLabel(STORE_ORDER[j]), `deals:filter:${j}`));
      }
      rows.push(row);
    }
    rows.push([Markup.button.callback('🔄 All stores', 'deals:filter:all')]);
    return rows;
  }

  // Reply with one single-deal card (header + dealCard + footer) and its
  // Grab Deal button. Budget the card so header + footer fit in MAX_LEN.
  async function sendSingleDeal(ctx, headTitle, found) {
    const head = header(headTitle);
    const foot = footer();
    const card = dealCard(found.deal, found.store, MAX_LEN - head.length - 2 - foot.length);
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
    const buttons = dealButtons(found.deal);
    if (buttons.length) extra.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
    await ctx.reply(`${head}\n\n${card}${foot}`, extra);
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
    await ctx.reply(welcomeText(), { ...startKeyboard(), parse_mode: 'HTML' });
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      `${header('Help')}\n\n` +
        `Free subscription — no payment needed.\n` +
        `${cadenceLine(50)}\n\n` +
        `${commandsText()}${footer()}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('status', async (ctx) => {
    const sub = await ensureSubscriber(ctx);
    await ctx.reply(statusText(sub, await loadStatusExtra(ctx.from.id)), { ...startKeyboard(), parse_mode: 'HTML' });
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
      'Tap /start to subscribe again (free).' + footer()
    );
  });

  bot.command('myid', async (ctx) => {
    await ctx.reply(`Your Telegram id is: ${ctx.from.id}`);
  });

  bot.command('stores', async (ctx) => {
    await ensureSubscriber(ctx);
    const prefs = await loadPrefs(ctx.from.id);
    await ctx.reply(storesText(prefs), { ...storesKeyboard(prefs), parse_mode: 'HTML' });
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
    const filterRows = dealsFilterKeyboard();
    for (let i = 0; i < messages.length; i++) {
      // Store quick-filter buttons ride on the last message only.
      await sendRichMessage(ctx, messages[i], i === messages.length - 1 ? filterRows : null);
    }
  });

  bot.command('top', async (ctx) => {
    const { selected } = await fetchSelectedForUser(ctx);
    const found = bestDealByDisc(selected);
    if (!found) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    await sendSingleDeal(ctx, 'Top deal', found);
  });

  bot.command('hot', async (ctx) => {
    const { selected } = await fetchSelectedForUser(ctx);
    const found = bestDealBySaving(selected);
    if (!found) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    await sendSingleDeal(ctx, 'Hottest deal 🔥', found);
  });

  bot.command('search', async (ctx) => {
    const q = keywordArg(ctx, 'search');
    if (!q) {
      await ctx.reply('Usage: /search <keyword> — e.g. /search headphones');
      return;
    }
    const { selected } = await fetchSelectedForUser(ctx);
    const needle = q.toLowerCase();
    const hits = [];
    for (const [store, list] of Object.entries(selected)) {
      for (const deal of list) {
        if (String(deal.title || '').toLowerCase().includes(needle)) hits.push({ deal, store });
      }
    }
    hits.sort((a, b) => b.deal.disc - a.deal.disc || (b.deal.mrp - b.deal.price) - (a.deal.mrp - a.deal.price));
    const top = hits.slice(0, 5);
    if (!top.length) {
      await ctx.reply(`🔍 No deals found for "${escapeHtml(q)}" — try another word, or /watch ${escapeHtml(q)} to get alerted when one appears.`);
      return;
    }
    const head = header(`Search: "${escapeHtml(q)}"`);
    const foot = footer();
    const intro = `🔍 Found ${top.length} deal${top.length === 1 ? '' : 's'} for "${escapeHtml(q)}"`;
    // Add cards one at a time so the whole reply stays inside MAX_LEN.
    const cards = [];
    let used = head.length + 1 + intro.length + 2 + foot.length;
    for (const { deal, store } of top) {
      const card = dealCard(deal, store, MAX_LEN - used - 2);
      if (used + card.length + 2 > MAX_LEN && cards.length) break;
      cards.push(card);
      used += card.length + 2;
    }
    const buttons = top.slice(0, cards.length).flatMap(({ deal }) => dealButtons(deal)).slice(0, 5);
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons.length) extra.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
    await ctx.reply(`${head}\n${intro}\n\n${cards.join('\n\n')}${foot}`, extra);
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
    await ctx.reply(`🔔 Your watchlist:\n${list.map((k) => `• ${k}`).join('\n')}${footer()}`);
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
      return `${escapeHtml(s.name || '—')} (@${escapeHtml(s.username || '—')}) — ${label}`;
    });
    await ctx.reply(
      `${header('Subscribers')}\n\n` +
        `${all.length} total\n` +
        `Active: ${active} • Stopped: ${stopped}\n\n` +
        (lines.join('\n') || 'No subscribers yet.') + footer(),
      { parse_mode: 'HTML' }
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
    const prefs = await loadPrefs(ctx.from.id);
    const min = Number.isInteger(prefs.min_discount) ? prefs.min_discount : 50;
    await ctx.reply(
      `🎉 ${header('Subscribed')}\n\n` +
        `✅ You're subscribed — for free, forever.\n` +
        `🔥 Hottest deals land here first.\n` +
        `${cadenceLine(min)}\n` +
        `<b>Next digest:</b> ${nextDigestLabel(Date.now(), config.digestHourIst)}${footer()}`,
      { ...startKeyboard(), parse_mode: 'HTML' }
    );
  });

  bot.action('status', async (ctx) => {
    await ctx.answerCbQuery();
    const sub = await ensureSubscriber(ctx);
    await ctx.reply(statusText(sub, await loadStatusExtra(ctx.from.id)), { ...startKeyboard(), parse_mode: 'HTML' });
  });

  // "Hottest deal now" button on /start — same as /hot.
  bot.action('hot', async (ctx) => {
    await ctx.answerCbQuery();
    const { selected } = await fetchSelectedForUser(ctx);
    const found = bestDealBySaving(selected);
    if (!found) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    await sendSingleDeal(ctx, 'Hottest deal 🔥', found);
  });

  // Store quick-filter buttons on /deals: re-run /deals for one store
  // (or all stores). Callback data carries the store INDEX, never the name.
  bot.action(/^deals:filter:(all|\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const { prefs, selected } = await fetchSelectedForUser(ctx);
    const arg = ctx.match[1];
    let subset = selected;
    if (arg !== 'all') {
      const store = STORE_ORDER[Number(arg)];
      if (!store || !selected[store] || !selected[store].length) {
        await ctx.reply(NO_DEALS_LINE);
        return;
      }
      subset = { [store]: selected[store] };
    }
    const messages = formatDigest(subset, {
      minDiscount: prefs.min_discount,
      topPerStore: config.digestTopPerStore ?? config.topPerStore ?? 5,
    });
    if (messages.length === 0) {
      await ctx.reply(NO_DEALS_LINE);
      return;
    }
    const filterRows = dealsFilterKeyboard();
    for (let i = 0; i < messages.length; i++) {
      await sendRichMessage(ctx, messages[i], i === messages.length - 1 ? filterRows : null);
    }
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
    await ctx.editMessageText(storesText(updated), { ...storesKeyboard(updated), parse_mode: 'HTML' });
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
