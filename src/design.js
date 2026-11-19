// design.js — the ONE design module every bot message imports.
// Pure functions, no I/O, no Telegraf/DB imports. All strings are built
// for Telegram HTML parse_mode: every user/deal-supplied value goes
// through escapeHtml before it lands in markup.
//
// Functional emoji — ONLY these may appear in bot messages:
//   🛒 brand header, 📅 date line, 🔔 watch alert, ✅ on/success,
//   ❌ off, 🎉 subscribe confirmation — plus the per-store emoji in
//   STORE_EMOJI below. No other emoji anywhere.
'use strict';

const BRAND_NAME = 'PriceDrop Hunter';

const STORE_EMOJI = {
  'Amazon Now': '🛒', 'Blinkit': '⚡', 'Flipkart Minutes': '🛍️',
  'BigBasket': '🧺', 'Myntra': '👗', 'Croma': '📱',
  'Zepto': '🚀', 'Swiggy Instamart': '🍔', 'JioMart': '🏪',
};

const MAX_LEN = 3900; // Telegram limit is 4096; stay safely under it.

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

function storeEmoji(store) {
  return STORE_EMOJI[store] || '';
}

function storeLabel(store) {
  const emoji = storeEmoji(store);
  return emoji ? `${emoji} ${escapeHtml(store)}` : escapeHtml(store);
}

function sectionTitle(store) {
  return '<b>' + storeLabel(store) + '</b>';
}

function header(title, dateLabel) {
  return `<b>🛒 ${BRAND_NAME} — ${title}</b>` + (dateLabel ? '\n📅 ' + dateLabel : '');
}

function footer() {
  return '\n—\nPriceDrop Hunter · /start · /stores · /stop';
}

function cadenceLine(minDiscount) {
  return `Fresh deals every 15 minutes · ${minDiscount}%+ off · duplicates removed`;
}

// One deal line. If it would exceed maxLen on its own, shorten the title
// (never truncate mid-deal / mid-line anywhere else).
function dealLine(deal, store, maxLen = MAX_LEN) {
  const pricePart = `<b>${inr(deal.price)}</b> <s>${inr(deal.mrp)}</s> (${deal.disc}% off) — ${storeLabel(store)}`;
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

function noDealsLine() {
  return 'No deals right now matching your stores and discount threshold — check back soon, fresh deals arrive every 15 minutes.';
}

function watchAlert(keyword, deal, store) {
  return `🔔 <b>Watch alert: "${escapeHtml(keyword)}"</b>\n` + dealLine(deal, store) + footer();
}

module.exports = {
  BRAND_NAME, STORE_EMOJI, MAX_LEN,
  escapeHtml, inr, istDateLabel, istDateTimeLabel,
  storeEmoji, storeLabel, sectionTitle, header, footer, cadenceLine,
  dealLine, noDealsLine, watchAlert,
};
