// digest.js — build the daily subscriber digest (Telegram HTML).
// Pure functions, no I/O: formatDigest(dealsByStore, config) -> string[]
// (already split into sendable messages) and splitMessages(blocks, ...).
'use strict';

const { STORE_ORDER } = require('./feed');

const MAX_LEN = 3900;      // Telegram limit is 4096; stay safely under it.
const MAX_MESSAGES = 2;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inr(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

// IST date, e.g. "Tue, 10 Nov 2026". Accepts a Date, an ISO string, or nothing (= now).
function istDateLabel(date) {
  const d = date ? new Date(date) : new Date();
  // "Tue, 10 Nov 2026" — built from parts because Intl en-IN renders
  // "Tue, 10 Nov, 2026" (extra comma after the month).
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}`;
}

// One deal line. If it would exceed maxLen on its own, shorten the title
// (never truncate mid-deal / mid-line anywhere else).
function dealLine(deal, store, maxLen = MAX_LEN) {
  const pricePart = `${inr(deal.price)} <s>${inr(deal.mrp)}</s> (${deal.disc}% off) — ${escapeHtml(store)}`;
  const url = String(deal.url || '');
  const linkOpen = url ? `<a href="${escapeHtml(url)}">` : '';
  const linkClose = url ? '</a>' : '';
  let title = String(deal.title || '');
  let line = `• ${linkOpen}${escapeHtml(title)}${linkClose} — ${pricePart}`;
  if (line.length > maxLen) {
    const overhead = line.length - escapeHtml(title).length;
    const keep = Math.max(10, maxLen - overhead - 1); // room for '…'
    title = title.slice(0, keep) + '…';
    line = `• ${linkOpen}${escapeHtml(title)}${linkClose} — ${pricePart}`;
  }
  return line;
}

// Split pre-built blocks (each block is one indivisible unit: header, one
// store heading, ONE deal line, footer) into <= maxMessages messages of
// <= maxLen chars. Splits happen only BETWEEN blocks, never inside one.
// If blocks still overflow maxMessages, whole trailing deals are dropped
// (lowest priority = last stores) and the last message notes the count.
function splitMessages(blocks, maxLen = MAX_LEN, maxMessages = MAX_MESSAGES) {
  const messages = [];
  let cur = '';
  let dropped = 0;
  for (const block of blocks) {
    if (messages.length >= maxMessages) { dropped++; continue; } // cap hit: drop whole trailing blocks
    const candidate = cur ? cur + '\n' + block : block;
    if (candidate.length <= maxLen) { cur = candidate; continue; }
    if (cur) messages.push(cur);
    if (messages.length >= maxMessages) { dropped++; cur = ''; continue; }
    cur = block.length > maxLen ? block.slice(0, maxLen) : block; // safety net; deal lines are pre-shortened
  }
  if (cur) {
    if (messages.length >= maxMessages) dropped++;
    else messages.push(cur);
  }
  if (dropped > 0 && messages.length) {
    const note = `\n… +${dropped} more deal${dropped === 1 ? '' : 's'} in tomorrow's digest`;
    const last = messages[messages.length - 1];
    if (last.length + note.length <= maxLen) messages[messages.length - 1] = last + note;
  }
  return messages;
}

function formatDigest(dealsByStore, config = {}) {
  const min = Number(config.MIN_DISCOUNT ?? config.minDiscount ?? 50);
  const top = Number(config.DIGEST_TOP_PER_STORE ?? config.topPerStore ?? 5);
  const dateLabel = istDateLabel(config.date);

  const blocks = [];
  blocks.push(
    `<b>🛒 PriceDrop Hunter — Daily Digest</b>\n📅 ${dateLabel} · Deals ${min}% off or more\n💎 Free subscriber digest — prices change fast, check the link before buying.`,
  );

  const stores = [
    ...STORE_ORDER.filter(s => s in (dealsByStore || {})),
    ...Object.keys(dealsByStore || {}).filter(s => !STORE_ORDER.includes(s)),
  ];
  for (const store of stores) {
    const deals = ((dealsByStore || {})[store] || [])
      .filter(d => d && Number(d.disc) >= min)
      .sort((a, b) => b.disc - a.disc || (b.mrp - b.price) - (a.mrp - a.price))
      .slice(0, top);
    blocks.push(`\n<b>${escapeHtml(store)}</b>`);
    if (!deals.length) {
      blocks.push(`${store}: no deals above ${min}% today`);
    } else {
      // Reserve room for the header/store-heading/footer blocks so a
      // single near-limit deal still fits in one message with them.
      for (const deal of deals) blocks.push(dealLine(deal, store, MAX_LEN - 350));
    }
  }
  blocks.push(`\n—\nPriceDrop Hunter · Manage your subscription: /start · Stop anytime with /stop`);

  return splitMessages(blocks, MAX_LEN, MAX_MESSAGES);
}

module.exports = { escapeHtml, istDateLabel, dealLine, splitMessages, formatDigest, MAX_LEN, MAX_MESSAGES };
