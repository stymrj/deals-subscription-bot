// digest.js — build the subscriber digest (Telegram HTML).
// Pure functions, no I/O: formatDigest(dealsByStore, config) -> string[]
// (already split into sendable messages) and splitMessages(blocks, ...).
// Cadence: fresh deals every 15 minutes (dedupe lives in the jobs layer),
// so stores with no new deals are omitted entirely and an empty digest
// sends nothing (returns []).
// All message formatting lives in src/design.js; this module only
// assembles the digest blocks from it.
'use strict';

const { STORE_ORDER } = require('./feed');
const design = require('./design');
const { escapeHtml, inr, istDateLabel, istDateTimeLabel, dealLine } = design;
const MAX_LEN = design.MAX_LEN;
const MAX_MESSAGES = 2;

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
    design.header('Fresh Deals', dateTimeLabel) + '\n' + design.cadenceLine(min) +
    '\nFree subscriber digest — prices change fast, check the link before buying.',
  );

  for (const [store, deals] of perStore) {
    blocks.push(`\n${design.sectionTitle(store)}`);
    // Reserve room for the header/store-heading/footer blocks so a
    // single near-limit deal still fits in one message with them.
    for (const deal of deals) blocks.push(dealLine(deal, store, MAX_LEN - 350));
  }
  blocks.push(design.footer());

  return splitMessages(blocks, MAX_LEN, MAX_MESSAGES);
}

module.exports = { escapeHtml, inr, istDateLabel, istDateTimeLabel, dealLine, splitMessages, formatDigest, MAX_LEN, MAX_MESSAGES };
