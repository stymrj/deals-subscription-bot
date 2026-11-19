// digest.js — build the subscriber digest (Telegram HTML).
// Pure functions, no I/O: formatDigest(dealsByStore, config) -> message[]
// where each message is { text, buttons } (buttons: [{ text, url }] —
// one "Grab Deal" URL button per deal, in order). Messages are already
// split into sendable units of <= MAX_LEN chars and <= MAX_MESSAGES
// messages. Cadence: fresh deals every 15 minutes (dedupe lives in the
// jobs layer), so stores with no new deals are omitted entirely and an
// empty digest sends nothing (returns []).
// All message formatting lives in src/design.js; this module only
// assembles the digest blocks from it.
'use strict';

const { STORE_ORDER } = require('./feed');
const design = require('./design');
const { escapeHtml, inr, istDateLabel, istDateTimeLabel, dealLine, dealCard, dealButtons } = design;
const MAX_LEN = design.MAX_LEN;
const MAX_MESSAGES = 2;
const MAX_BUTTONS_PER_MESSAGE = 8; // wall of buttons is ugly; the title link still works

// Split pre-built units into <= maxMessages messages of <= maxLen chars.
// A unit is { text, isDeal?, buttons? }: header, one store heading, ONE
// deal card, footer. Splits happen only BETWEEN units, never inside one.
// If units still overflow maxMessages, whole trailing deals are dropped
// (lowest priority = last stores) and the last message notes the count.
// Only deal units count towards the dropped-deals note; headings/footer
// dropped with them are not deals. Buttons travel with their deal's
// message (capped per message; extras are dropped silently — the title
// link in the card still opens the deal).
function splitMessages(units, maxLen = MAX_LEN, maxMessages = MAX_MESSAGES) {
  const messages = [];
  let curText = '';
  let curButtons = [];
  let dropped = 0;
  const push = () => {
    if (curText) messages.push({ text: curText, buttons: curButtons });
    curText = '';
    curButtons = [];
  };
  for (const unit of units) {
    const text = typeof unit === 'string' ? unit : unit.text;
    const isDeal = typeof unit === 'object' && !!unit.isDeal;
    const buttons = (typeof unit === 'object' && Array.isArray(unit.buttons)) ? unit.buttons : [];
    if (messages.length >= maxMessages) { if (isDeal) dropped++; continue; } // cap hit: drop whole trailing units
    const candidate = curText ? curText + '\n' + text : text;
    if (candidate.length <= maxLen) {
      curText = candidate;
      for (const b of buttons) {
        if (curButtons.length < MAX_BUTTONS_PER_MESSAGE) curButtons.push(b);
      }
      continue;
    }
    if (curText) push();
    if (messages.length >= maxMessages) { if (isDeal) dropped++; continue; }
    curText = text.length > maxLen ? text.slice(0, maxLen) : text; // safety net; deal cards are pre-shortened
    curButtons = buttons.slice(0, MAX_BUTTONS_PER_MESSAGE);
  }
  if (curText) {
    if (messages.length >= maxMessages) { /* trailing unit beyond the cap: dropped with it */ }
    else messages.push({ text: curText, buttons: curButtons });
  }
  if (dropped > 0 && messages.length) {
    const note = `\n… +${dropped} more deal${dropped === 1 ? '' : 's'} in the next update`;
    const last = messages[messages.length - 1];
    if (last.text.length + note.length <= maxLen) last.text = last.text + note;
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

  const units = [];
  units.push({
    text:
      design.header('Fresh Deals', dateTimeLabel) + '\n' + design.cadenceLine(min) +
      '\nFree subscriber digest — prices change fast, check the link before buying.',
  });

  for (const [store, deals] of perStore) {
    units.push({ text: `\n${design.sectionTitle(store)}` });
    // Reserve room for the header/store-heading/footer units so a
    // single near-limit deal still fits in one message with them.
    for (const deal of deals) {
      units.push({
        text: dealCard(deal, store, MAX_LEN - 350),
        isDeal: true,
        buttons: dealButtons(deal),
      });
    }
  }
  units.push({ text: design.footer() });

  return splitMessages(units, MAX_LEN, MAX_MESSAGES);
}

module.exports = { escapeHtml, inr, istDateLabel, istDateTimeLabel, dealLine, dealCard, dealButtons, splitMessages, formatDigest, MAX_LEN, MAX_MESSAGES };
