// design.js — the ONE design module every bot message imports.
// Pure functions, no I/O, no Telegraf/DB imports. All strings are built
// for Telegram HTML parse_mode: every user/deal-supplied value goes
// through escapeHtml before it lands in markup.
//
// Functional emoji — ONLY these may appear in bot messages:
//   🛒 brand header, 📅 date line, 🔔 watch alert, ✅ on/success,
//   ❌ off, 🎉 subscribe confirmation, 🔥 hot / 90%+ deal,
//   ⚡ 75%+ deal / fresh-drop marker, 💰 price, 💸 savings,
//   🏷️ category tag, 🎯 60%+ deal / top pick, 🔍 search / no-deals,
//   ⚙️ settings section, 🔄 all-stores filter
//   — plus the per-store emoji in STORE_EMOJI below. No other emoji
//   anywhere.
//
// One rendering per deal: dealCard() is used byte-identically by the
// digest, /deals, /top, /hot, /search and watch alerts. dealLine() is
// kept for backwards compatibility (tests + older callers) but no
// user-facing surface renders through it anymore.
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
  return `⚡ Fresh deals every 15 minutes · ${minDiscount}%+ off · duplicates removed`;
}

// Discount badge by tier: the hotter the deal, the louder the badge.
function discountBadge(disc) {
  const d = Math.round(Number(disc) || 0);
  if (d >= 90) return `🔥 ${d}% OFF`;
  if (d >= 75) return `⚡ ${d}% OFF`;
  if (d >= 60) return `🎯 ${d}% OFF`;
  return `✅ ${d}% OFF`;
}

function savingsText(deal) {
  const mrp = Number(deal.mrp) || 0;
  const price = Number(deal.price) || 0;
  if (mrp > price) return `💸 save ${inr(mrp - price)}`;
  return '';
}

function categoryTag(deal) {
  const cat = String(deal.cat || '').trim();
  return cat ? `🏷️ ${escapeHtml(cat)}` : '';
}

// The one deal rendering, used byte-identically everywhere:
//   {badge} · {store}
//   <linked title>
//   💰 ₹price <s>₹mrp</s> · 💸 save ₹X
//   🏷️ category            (only when the feed carries one)
// If it would exceed maxLen on its own, shorten the title (never
// truncate mid-deal / mid-line anywhere else).
function dealCard(deal, store, maxLen = MAX_LEN) {
  const badge = discountBadge(deal.disc);
  const storePart = storeLabel(store);
  const url = String(deal.url || '');
  const linkOpen = url ? `<a href="${escapeHtml(url)}">` : '';
  const linkClose = url ? '</a>' : '';
  const save = savingsText(deal);
  const priceLine = save
    ? `💰 <b>${inr(deal.price)}</b> <s>${inr(deal.mrp)}</s> · ${save}`
    : `💰 <b>${inr(deal.price)}</b> <s>${inr(deal.mrp)}</s>`;
  const catLine = categoryTag(deal);
  let title = String(deal.title || '');
  const build = (t) => {
    const lines = [`${badge} · ${storePart}`, `${linkOpen}${escapeHtml(t)}${linkClose}`, priceLine];
    if (catLine) lines.push(catLine);
    return lines.join('\n');
  };
  let card = build(title);
  if (card.length > maxLen) {
    const overhead = build('').length;
    const keep = Math.max(10, maxLen - overhead - 1); // room for '…'
    title = title.slice(0, keep) + '…';
    card = build(title);
  }
  return card;
}

// Inline "Grab Deal" URL button for one deal (Telegram url button).
// Empty when the deal has no URL — the title link already covers it.
function dealButtons(deal) {
  const url = String(deal.url || '').trim();
  return url ? [{ text: '🛒 Grab Deal', url }] : [];
}

// One deal line. Kept for backwards compatibility (tests + older
// callers); no user-facing surface renders through it anymore —
// dealCard() is the one rendering. If it would exceed maxLen on its own,
// shorten the title (never truncate mid-deal / mid-line anywhere else).
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
  return '🔍 No deals right now matching your stores & discount — fresh deals land every 15 minutes, so check back soon, or try /deals, /hot or /search.';
}

function watchAlert(keyword, deal, store) {
  return `🔔 <b>Watch alert: "${escapeHtml(keyword)}"</b>\n` + dealCard(deal, store) + footer();
}

module.exports = {
  BRAND_NAME, STORE_EMOJI, MAX_LEN,
  escapeHtml, inr, istDateLabel, istDateTimeLabel,
  storeEmoji, storeLabel, sectionTitle, header, footer, cadenceLine,
  discountBadge, savingsText, categoryTag, dealCard, dealButtons,
  dealLine, noDealsLine, watchAlert,
};
