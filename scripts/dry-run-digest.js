// Dry-run: print the formatted digest built from fixtures/deals.json.
// No network, no token, no sends. Usage: npm run digest:dry
'use strict';

const { loadFixture } = require('../src/feed');
const { formatDigest } = require('../src/digest');

const config = {
  MIN_DISCOUNT: Number(process.env.MIN_DISCOUNT || 50),
  DIGEST_TOP_PER_STORE: Number(process.env.DIGEST_TOP_PER_STORE || 5),
  date: process.env.DIGEST_DATE || undefined,
};

const deals = loadFixture();
const messages = formatDigest(deals, config);
messages.forEach((msg, i) => {
  const text = msg.text;
  console.log(`\n----- message ${i + 1}/${messages.length} (${text.length} chars, ${msg.buttons.length} Grab Deal button(s)) -----\n`);
  // Strip HTML tags for a readable terminal preview (Telegram gets the raw HTML).
  console.log(text.replace(/<[^>]+>/g, ''));
  for (const b of msg.buttons) console.log(`[button] ${b.text} -> ${b.url}`);
  console.log(`\n[raw HTML length: ${text.length} chars]`);
});
console.log(`\nDry run: ${messages.length} message(s), not sent. Stores in fixture: ${Object.keys(deals).length}.`);
