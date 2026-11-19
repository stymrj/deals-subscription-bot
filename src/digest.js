// digest.js — build the subscriber digest (Telegram HTML).
// Pure functions, no I/O: formatDigest(dealsByStore, config) -> string[]
// (already split into sendable messages) and splitMessages(blocks, ...).
// Cadence: fresh deals every 15 minutes (dedupe lives in the jobs layer),
// so stores with no new deals are omitted entirely and an empty digest
// sends nothing (returns []).
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

// IST date + time, e.g. "Thu, 19 Nov 2026 · 6:15 PM IST".
// Accepts a Date, an ISO string, or nothing (= now).
function istDateTimeLabel(date) {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  // en-IN renders the day period lowercase ("pm"); the digest shows "PM".
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')} · ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()} IST`;
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
// Only deal blocks ('• ...') count towards the dropped-deals note;
// headings/footer dropped with them are not deals.
function splitMessages(blocks, maxLen = MAX_LEN, maxMessages = MAX_MESSAGES) {
  const messages = [];
  let cur = '';
  let dropped = 0;
  for (const block of blocks) {
    if (messages.length >= maxMessages) { if (block.startsWith('• ')) dropped++; continue; } // cap hit: drop whole trailing blocks
    const candidate = cur ? cur + '\n' + block : block;
    if (candidate.length <= maxLen) { cur = candidate; continue; }
    if (cur) messages.push(cur);
    if (messages.length >= maxMessages) { if (block.startsWith('• ')) dropped++; cur = ''; continue; }
    cur = block.length > maxLen ? block.slice(0, maxLen) : block; // safety net; deal lines are pre-shortened
  }
  if (cur) {
    if (messages.length >= maxMessages) { if (cur.startsWith('• ')) dropped++; }
    else messages.push(cur);
  }
  if (dropped > 0 && messages.length) {
    const note = `\n… +${dropped} more deal${dropped === 1 ? '' : 's'} in the next update`;
    const last = messages[messages.length - 1];
    if (last.length + note.length <= maxLen) messages[messages.length - 1] = last + note;
  }
  return messages;
}

function formatDigest(dealsByStore, config = {}) {
  const min = Number(config.MIN_DISCOUNT ?? config.minDiscount ?? 50);
  const top = Number(config.DIGEST_TOP_PER_STORE ?? config.topPerStore ?? 5);
  const dateTimeLabel = istDateTimeLabel(config.date);

  const stores = [
    ...STORE_ORDER.filter(s => s in (dealsByStore || {})),
    ...Object.keys(dealsByStore || {}).filter(s => !STORE_ORDER.includes(s)),
  ];
  // Filter + sort + cap per store first. Stores with no deals after
  // filtering are omitted entirely — at a 15-minute cadence a
  // "no deals" line per store would spam every update.
  const perStore = [];
  for (const store of stores) {
    const deals = ((dealsByStore || {})[store] || [])
      .filter(d => d && Number(d.disc) >= min)
      .sort((a, b) => b.disc - a.disc || (b.mrp - b.price) - (a.mrp - a.price))
      .slice(0, top);
    if (deals.length) perStore.push([store, deals]);
  }
  if (!perStore.length) return []; // no deals in any store: send nothing

  const blocks = [];
  blocks.push(
    `<b>🛒 PriceDrop Hunter — Fresh Deals</b>\n📅 ${dateTimeLabel}\n${min}%+ off · fresh deals every 15 minutes · duplicates removed\n💎 Free subscriber digest — prices change fast, check the link before buying.`,
  );

  for (const [store, deals] of perStore) {
    blocks.push(`\n<b>${escapeHtml(store)}</b>`);
    // Reserve room for the header/store-heading/footer blocks so a
    // single near-limit deal still fits in one message with them.
    for (const deal of deals) blocks.push(dealLine(deal, store, MAX_LEN - 350));
  }
  blocks.push(`\n—\nPriceDrop Hunter · Manage your subscription: /start · Stop anytime with /stop`);

  return splitMessages(blocks, MAX_LEN, MAX_MESSAGES);
}

module.exports = { escapeHtml, istDateLabel, istDateTimeLabel, dealLine, splitMessages, formatDigest, MAX_LEN, MAX_MESSAGES };
