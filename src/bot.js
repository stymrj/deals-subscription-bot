'use strict';

const { Telegraf, Markup } = require('telegraf');
const { STORE_ORDER } = require('./feed');

const IST = 'Asia/Kolkata';

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
 */
function createBot({ config, store }) {
  const bot = new Telegraf(config.botToken);
  const adminId = config.adminId;

  const welcomeText = () =>
    `👋 Welcome to PriceDrop Hunter!\n\n` +
    `🆓 Free subscription — fresh deals every 15 minutes, only 50%+ off, duplicates removed.\n\n` +
    `Stores we track:\n${storeListText()}\n\n` +
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

  function statusText(sub) {
    const subscribed = sub && sub.status === 'active';
    const statusLabel = subscribed ? 'subscribed' : 'not subscribed';
    return (
      `📋 Your subscription\n\n` +
      `Free subscriber\n` +
      `Status: ${statusLabel}\n` +
      `Fresh deals every 15 minutes · 50%+ off · duplicates removed\n` +
      `Next digest: ${nextDigestLabel(Date.now(), config.digestHourIst)}` +
      (subscribed
        ? ''
        : `\n\nTap /start and hit Subscribe to join — it's free.`)
    );
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
        `Stores we track:\n${storeListText()}\n\n` +
        `/start — subscribe for free, or check status\n` +
        `/status — your subscription status and next digest time\n` +
        `/myid — your numeric Telegram id\n` +
        `/stop — stop the deal updates\n` +
        `/help — this help\n\n` +
        `Admin: /subscribers, /broadcast <text>`
    );
  });

  bot.command('status', async (ctx) => {
    const sub = await ensureSubscriber(ctx);
    await ctx.reply(statusText(sub), startKeyboard());
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
    await ctx.reply(statusText(sub), startKeyboard());
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
