// design.test.js — CONSISTENCY tests for the shared design system (src/design.js).
//
// Two layers:
//   (A) design.js unit tests — the pinned helpers in isolation. These run
//       against W3's own src/design.js and must pass in this copy.
//   (B) cross-message consistency tests — every user-facing message built
//       via the shared helpers: /start, digest, /deals, /top and watch
//       alerts share the same header()/footer()/storeLabel() output, the
//       deal rendering is byte-identical across all four surfaces, every
//       store carries exactly one emoji everywhere, no message exceeds the
//       3900-char cap, and empty states reply the noDealsLine() one-liner
//       exactly once.
//
// Layer (B) needs W1's rewritten src/digest.js (header/footer/sectionTitle/
// dealLine via design.js) and W2's rewritten src/bot.js (same, for /start,
// /deals, /top, /stores). This copy still has the OLD bot.js/digest.js, so
// the layer-(B) cases that touch those files FAIL here — that is expected
// and merge-gated (see the per-test notes). The cases that only touch
// W3-owned code (watch alerts via src/jobs.js + src/design.js, and the
// empty-state one-liner, whose string is unchanged) PASS here. The
// coordinator runs the full suite on the merged tree.
//
// Harness mirrors tests/bot.test.js: createBot with the real in-memory
// store + fixture feeds, Telegram.prototype.callApi patched so no network
// is ever touched. Watch alerts go through runDigest (src/jobs.js) with
// the stub bot/db from tests/jobs.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const design = require('../src/design');
const { STORE_ORDER } = require('../src/feed');
const { formatDigest } = require('../src/digest');
const { createBot } = require('../src/bot');
const { initDb } = require('../src/db');
const { runDigest } = require('../src/jobs');

const { MAX_LEN, STORE_EMOJI } = design;

// Pinned functional emoji — the ONLY non-store emoji allowed in any bot
// message, plus the nine store emoji from STORE_EMOJI.
const ALLOWED_EMOJI = new Set(
  ['🛒', '📅', '🔔', '✅', '❌', '🎉', ...Object.values(STORE_EMOJI)]
    // Strip U+FE0F so '🛍️' matches its base code point '🛍' when scanned.
    .map((e) => e.replace(/\uFE0F/g, ''))
);

// Every emoji code point in a string (variation selector U+FE0F, part of
// '🛍️', is skipped — it is not an emoji on its own).
function emojiIn(text) {
  const found = [];
  for (const ch of String(text || '')) {
    if (ch === '\uFE0F') continue;
    if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(ch)) found.push(ch);
  }
  return found;
}

function assertOnlyPinnedEmoji(text, where) {
  for (const e of emojiIn(text)) {
    assert.ok(ALLOWED_EMOJI.has(e), `${where}: emoji ${e} is outside the pinned set: ` + text);
  }
}

// ---------- Fixtures ----------

const MIXER = { title: 'Mixer Grinder', price: 1500, mrp: 5000, disc: 70, url: 'https://example.com/mixer', cat: '' };

const FEEDS = {
  'Amazon Now': [
    { title: 'Headphones Pro', price: 999, mrp: 2999, disc: 67, url: 'https://example.com/hp', cat: '' },
    { title: 'Cheap Cable', price: 199, mrp: 499, disc: 60, url: 'https://example.com/cable', cat: '' },
  ],
  Zepto: [MIXER],
  Blinkit: [
    { title: 'Low Discount Snack', price: 90, mrp: 100, disc: 10, url: 'https://example.com/snack', cat: '' },
  ],
};

// One 60%-off deal per store, for the every-store emoji sweep.
// Zepto's deal is 61% so /top has one unambiguous best deal (all ties
// would make it pick the first store in order, Amazon Now) — the sweep
// below asserts Zepto as the /top pick.
const ALL_STORES_FEEDS = Object.fromEntries(
  STORE_ORDER.map((store, i) => [store, [{
    title: `Deal ${i} ${store}`, price: 100, mrp: 250, disc: store === 'Zepto' ? 61 : 60,
    url: `https://example.com/s${i}`, cat: '',
  }]])
);

// A title far longer than any message: the best deal (disc 90) so /top picks it.
const LONG_DEAL = {
  title: 'L'.repeat(5000), price: 100, mrp: 1000, disc: 90,
  url: 'https://example.com/long', cat: '',
};
const LONG_FEEDS = { Zepto: [LONG_DEAL] };

const FIXED_DATE = '2026-11-19T12:45:00Z'; // 6:15 PM IST
const FIXED_DATE_LABEL = design.istDateTimeLabel(FIXED_DATE); // 'Thu, 19 Nov 2026 · 6:15 PM IST'
const DIGEST_HEADER = design.header('Fresh Deals', FIXED_DATE_LABEL);

// ---------- (A) design.js unit tests ----------

test('design unit: STORE_EMOJI covers all 9 stores, one unique emoji each', () => {
  assert.deepEqual(Object.keys(STORE_EMOJI).sort(), [...STORE_ORDER].sort());
  const values = Object.values(STORE_EMOJI);
  assert.equal(new Set(values).size, 9, 'each store must have a distinct emoji');
  for (const [store, emoji] of Object.entries(STORE_EMOJI)) {
    assert.ok(typeof emoji === 'string' && emoji.length > 0, `${store} needs an emoji`);
    // One grapheme (base emoji, optionally + variation selector, as in 🛍️).
    assert.ok([...emoji].length <= 2, `${store} emoji must be a single emoji: ${emoji}`);
  }
});

test('design unit: escapeHtml escapes &, <, >, " and inr formats Indian rupees', () => {
  assert.equal(design.escapeHtml('<a href="x">&\'b'), '&lt;a href=&quot;x&quot;&gt;&amp;\'b');
  assert.equal(design.escapeHtml(null), '');
  assert.equal(design.escapeHtml(42), '42');
  assert.equal(design.inr(1234), '₹1,234');
  assert.equal(design.inr(999), '₹999');
  assert.equal(design.inr(0), '₹0');
  assert.equal(design.inr(1500), '₹1,500');
});

test('design unit: istDateLabel / istDateTimeLabel render IST', () => {
  assert.equal(design.istDateLabel(FIXED_DATE), 'Thu, 19 Nov 2026');
  assert.equal(design.istDateTimeLabel(FIXED_DATE), 'Thu, 19 Nov 2026 · 6:15 PM IST');
});

test('design unit: storeEmoji / storeLabel / sectionTitle', () => {
  assert.equal(design.storeEmoji('Zepto'), '🚀');
  assert.equal(design.storeEmoji('Amazon Now'), '🛒');
  assert.equal(design.storeEmoji('Unknown Store'), '');
  assert.equal(design.storeLabel('Zepto'), '🚀 Zepto');
  assert.equal(design.storeLabel('Unknown Store'), 'Unknown Store');
  assert.equal(design.storeLabel('<b>X</b>'), '&lt;b&gt;X&lt;/b&gt;');
  assert.equal(design.sectionTitle('Zepto'), '<b>🚀 Zepto</b>');
  assert.equal(design.sectionTitle('Unknown Store'), '<b>Unknown Store</b>');
});

test('design unit: header / footer / cadenceLine are exact', () => {
  assert.equal(
    design.header('Fresh Deals', 'Thu, 19 Nov 2026 · 6:15 PM IST'),
    '<b>🛒 PriceDrop Hunter — Fresh Deals</b>\n📅 Thu, 19 Nov 2026 · 6:15 PM IST'
  );
  assert.equal(design.header('Top deal'), '<b>🛒 PriceDrop Hunter — Top deal</b>');
  assert.ok(!design.header('Top deal').includes('📅'), 'no date label means no date line');
  assert.equal(design.footer(), '\n—\nPriceDrop Hunter · /start · /stores · /stop');
  assert.equal(
    design.cadenceLine(50),
    'Fresh deals every 15 minutes · 50%+ off · duplicates removed'
  );
  assert.equal(
    design.cadenceLine(30),
    'Fresh deals every 15 minutes · 30%+ off · duplicates removed'
  );
});

test('design unit: dealLine exact format, empty url has no <a>, title escaped', () => {
  assert.equal(
    design.dealLine(MIXER, 'Zepto'),
    '• <a href="https://example.com/mixer">Mixer Grinder</a> — <b>₹1,500</b> <s>₹5,000</s> (70% off) — 🚀 Zepto'
  );
  const noUrl = { title: 'Plain Deal', price: 100, mrp: 200, disc: 50, url: '', cat: '' };
  assert.equal(
    design.dealLine(noUrl, 'Blinkit'),
    '• Plain Deal — <b>₹100</b> <s>₹200</s> (50% off) — ⚡ Blinkit'
  );
  assert.ok(!design.dealLine(noUrl, 'Blinkit').includes('<a'), 'empty url must produce no link tags');
  const tricky = { title: 'A <B> & "C"', price: 100, mrp: 200, disc: 50, url: 'https://example.com/?a=1&b=2', cat: '' };
  const line = design.dealLine(tricky, 'Zepto');
  assert.ok(line.includes('A &lt;B&gt; &amp; &quot;C&quot;'), 'title must be escaped: ' + line);
  assert.ok(line.includes('href="https://example.com/?a=1&amp;b=2"'), 'url must be escaped: ' + line);
  assert.ok(line.includes('🚀 Zepto'), 'store label carries the store emoji');
});

test('design unit: dealLine truncates a long title, never cuts mid-deal', () => {
  const line = design.dealLine(LONG_DEAL, 'Zepto');
  assert.ok(line.length <= MAX_LEN, `dealLine ${line.length} chars exceeds ${MAX_LEN}`);
  assert.ok(line.includes('…'), 'truncated title must end with an ellipsis');
  assert.ok(!line.includes(LONG_DEAL.title), 'the full 5000-char title must not survive');
  assert.ok(line.endsWith('(90% off) — 🚀 Zepto'), 'price part must survive intact: ' + line.slice(-60));
  assert.ok(line.startsWith('• <a href="https://example.com/long">'), 'link must survive intact');
  // A short deal is never truncated.
  assert.ok(!design.dealLine(MIXER, 'Zepto').includes('…'));
});

test('design unit: noDealsLine is the pinned one-liner', () => {
  assert.equal(
    design.noDealsLine(),
    'No deals right now matching your stores and discount threshold — check back soon, fresh deals arrive every 15 minutes.'
  );
});

test('design unit: watchAlert is alert line + dealLine + footer, keyword escaped', () => {
  const expected =
    '🔔 <b>Watch alert: "mixer"</b>\n' +
    design.dealLine(MIXER, 'Zepto') +
    design.footer();
  assert.equal(design.watchAlert('mixer', MIXER, 'Zepto'), expected);
  const tricky = design.watchAlert('a <b> & "q"', MIXER, 'Zepto');
  assert.ok(tricky.includes('Watch alert: "a &lt;b&gt; &amp; &quot;q&quot;"'), 'keyword must be escaped: ' + tricky);
  assert.ok(tricky.endsWith(design.footer()), 'watch alert ends with the shared footer');
});

test('design unit: only pinned emoji appear in helper output', () => {
  const outputs = [
    design.header('Fresh Deals', FIXED_DATE_LABEL),
    design.footer(),
    design.cadenceLine(50),
    design.noDealsLine(),
    design.watchAlert('mixer', MIXER, 'Zepto'),
    ...STORE_ORDER.map((s) => design.sectionTitle(s)),
    ...STORE_ORDER.map((s) => design.dealLine(MIXER, s)),
  ];
  for (const out of outputs) assertOnlyPinnedEmoji(out, 'design helper');
});

// ---------- (B) cross-message consistency ----------

// Telegraf v4 creates a fresh Telegram client per update inside
// handleUpdate, so patch Telegram.prototype.callApi (as in bot.test.js).
// No network is ever touched.
const apiCalls = [];
require('telegraf').Telegram.prototype.callApi = async function (method, payload = {}) {
  apiCalls.push({ method, ...payload });
  if (method === 'getMe') {
    return { id: 1, is_bot: true, first_name: 'TestBot', username: 'testbot' };
  }
  if (method === 'sendMessage' || method === 'sendPhoto') {
    return { message_id: apiCalls.length, chat: { id: payload.chat_id } };
  }
  return true;
};

const USER_ID = 111;
const ADMIN_ID = 999;
let updateId = 0;

function testConfig() {
  return {
    botToken: 'TEST_TOKEN_NOT_REAL',
    adminId: ADMIN_ID,
    minDiscount: 50,
    digestTopPerStore: 5,
    digestHourIst: 9,
    botMode: 'polling',
    port: 3000,
    databasePath: ':memory:',
    webhookUrl: '',
    feedUrls: '',
  };
}

async function setupBot(fetchDealsStub) {
  apiCalls.length = 0;
  const store = await initDb(':memory:');
  const { bot } = createBot({ config: testConfig(), store, fetchDeals: fetchDealsStub });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'TestBot', username: 'testbot' };
  return { store, bot };
}

function messageUpdate(userId, text) {
  const isCommand = text.startsWith('/');
  const cmdLen = isCommand ? text.split(/\s/)[0].length : 0;
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'Test', username: 'testuser' },
      chat: { id: userId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(isCommand ? { entities: [{ offset: 0, length: cmdLen, type: 'bot_command' }] } : {}),
    },
  };
}

function userMessages(userId) {
  return apiCalls.filter((c) => c.method === 'sendMessage' && c.chat_id === userId);
}

// The brand header line: '<b>🛒 PriceDrop Hunter — {title}</b>' for any title.
const HEADER_LINE = /^<b>🛒 PriceDrop Hunter — .+<\/b>$/;

test('design consistency: /start, digest, /deals and /top share the same header() and footer()', async () => {
  // /start — MERGE-GATED (needs W2's bot.js): old welcome starts with 👋
  // and carries no footer.
  const { bot } = await setupBot(async () => FEEDS);
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  const startReply = userMessages(USER_ID).at(-1);
  assert.ok(startReply, 'expected a /start reply');
  assert.match(startReply.text.split('\n')[0], HEADER_LINE, '/start must open with the shared header: ' + startReply.text);
  assert.ok(startReply.text.endsWith(design.footer()), '/start must end with the shared footer');

  // Digest — MERGE-GATED (needs W1's digest.js): old footer differs and
  // the header/cadence are inline, not helper-built.
  const digestMsgs = formatDigest(FEEDS, { minDiscount: 50, date: FIXED_DATE });
  assert.ok(digestMsgs.length >= 1, 'fixture digest must produce a message');
  assert.ok(digestMsgs[0].startsWith(DIGEST_HEADER), 'digest must open with header("Fresh Deals", date): ' + digestMsgs[0]);
  assert.ok(digestMsgs.at(-1).endsWith(design.footer()), 'digest must end with the shared footer');
  for (const m of digestMsgs) assert.ok(m.length <= MAX_LEN, `digest message ${m.length} chars exceeds ${MAX_LEN}`);

  // /deals — MERGE-GATED (uses formatDigest): same header/footer as the digest.
  // /deals renders the live date (formatDigest defaults to now), so compare
  // the header title line + the IST date-line shape, not the fixed date.
  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  const dealReplies = userMessages(USER_ID);
  assert.ok(dealReplies.length >= 1, 'expected a /deals reply');
  assert.ok(dealReplies[0].text.startsWith(design.header('Fresh Deals')), '/deals must open with the same digest header');
  assert.match(dealReplies[0].text.split('\n')[1], /^📅 .+ IST$/, '/deals header must carry an IST date line');
  assert.ok(dealReplies.at(-1).text.endsWith(design.footer()), '/deals must end with the shared footer');

  // /top — MERGE-GATED (needs W2's bot.js): old reply opens with 🏆 and
  // carries no footer.
  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  const topReply = userMessages(USER_ID).at(-1);
  assert.ok(topReply, 'expected a /top reply');
  assert.match(topReply.text.split('\n')[0], HEADER_LINE, '/top must open with the shared header: ' + topReply.text);
  assert.ok(topReply.text.endsWith(design.footer()), '/top must end with the shared footer');
});

test('design consistency: dealLine is byte-identical across digest, /deals, /top and watch alerts', async () => {
  // The Mixer deal (70%, Zepto) is the best deal, so it is the /top pick
  // and the watch-alert deal for keyword 'mixer' — one deal object, four surfaces.
  const expected = design.dealLine(MIXER, 'Zepto');

  // Digest — MERGE-GATED (old digest.js dealLine: price not bold, bare store name).
  const digestMsgs = formatDigest(FEEDS, { minDiscount: 50, date: FIXED_DATE });
  assert.ok(digestMsgs.join('\n').includes(expected), 'digest must contain the shared dealLine byte-for-byte');

  const { bot } = await setupBot(async () => FEEDS);

  // /deals — MERGE-GATED (uses formatDigest).
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  assert.ok(
    userMessages(USER_ID).map((r) => r.text).join('\n').includes(expected),
    '/deals must contain the same dealLine byte-for-byte'
  );

  // /top — MERGE-GATED (old /top uses the old digest.js dealLine).
  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  assert.ok(
    userMessages(USER_ID).at(-1).text.includes(expected),
    '/top must contain the same dealLine byte-for-byte'
  );

  // Watch alert: covered by its own test below (W3-owned, passes here).
});

test('design consistency: watch alert via runDigest equals design.watchAlert exactly', async () => {
  // PASSES in this copy — the only cross-surface case that touches
  // W3-owned code only (src/jobs.js + src/design.js). Proves the watch
  // alert carries the same dealLine byte-for-byte as the other surfaces
  // will once W1/W2 land.
  const expected = design.dealLine(MIXER, 'Zepto');
  const alertBot = { sent: [], telegram: { async sendMessage(chatId, text, opts) { alertBot.sent.push({ chatId, text, opts }); } } };
  const alertDb = {
    async getActiveSubscribers() { return [{ telegram_id: USER_ID, status: 'active' }]; },
    async getUserPrefs() { return { user_id: USER_ID, stores: [...STORE_ORDER], min_discount: 50 }; },
    async listAllWatches() { return [{ user_id: USER_ID, keyword: 'mixer' }]; },
    async getRecentPostedKeys() { return new Set(); },
    async markPosted() {},
  };
  const stubFetch = async (url) => {
    const slugToStore = { 'Amazon-Now-Deals': 'Amazon Now', 'Zepto-Deals': 'Zepto', 'Blinkit-Deals': 'Blinkit' };
    const hit = Object.keys(slugToStore).find((slug) => url.includes(slug));
    const name = hit ? slugToStore[hit] : 'Amazon Now';
    return { ok: true, status: 200, json: async () => ({ store: name, deals: FEEDS[name] || [] }) };
  };
  const res = await runDigest(alertBot, alertDb, { minDiscount: 50 }, { fetchFn: stubFetch, delayMs: 0 });
  assert.equal(res.alertsSent, 1);
  const alert = alertBot.sent.find((s) => s.text.includes('Watch alert:'));
  assert.ok(alert, 'expected a watch alert');
  assert.ok(alert.text.includes(expected), 'watch alert must contain the same dealLine byte-for-byte');
  assert.equal(alert.text, design.watchAlert('mixer', MIXER, 'Zepto'), 'watch alert must equal design.watchAlert() exactly');
  assert.ok(alert.text.includes(design.storeLabel('Zepto')), 'watch alert must render the store via storeLabel()');
});

test('design consistency: every store has exactly one emoji, identical everywhere', async () => {
  // Digest headings — MERGE-GATED (old digest.js: bare '<b>Zepto</b>').
  const digestText = formatDigest(ALL_STORES_FEEDS, { minDiscount: 50, date: FIXED_DATE }).join('\n');
  for (const store of STORE_ORDER) {
    assert.ok(digestText.includes(design.sectionTitle(store)), `digest must head ${store} with sectionTitle(): ` + digestText);
    assert.ok(!digestText.includes(`<b>${store}</b>`), `digest must not show a bare ${store} heading`);
  }

  const { bot } = await setupBot(async () => ALL_STORES_FEEDS);

  // /deals — MERGE-GATED (uses formatDigest).
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  const dealsText = userMessages(USER_ID).map((r) => r.text).join('\n');
  for (const store of STORE_ORDER) {
    assert.ok(dealsText.includes(design.sectionTitle(store)), `/deals must head ${store} with sectionTitle()`);
  }

  // /stores — MERGE-GATED (old bot.js: '✅ Zepto' with a bare store name).
  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/stores'));
  const storesText = userMessages(USER_ID).at(-1).text;
  for (const store of STORE_ORDER) {
    assert.ok(
      storesText.includes(`✅ ${design.storeLabel(store)}`),
      `/stores must list ${store} as ✅ + storeLabel(): ` + storesText
    );
  }

  // /top — MERGE-GATED (old /top: bare store name in the deal line).
  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  assert.ok(
    userMessages(USER_ID).at(-1).text.includes(design.storeLabel('Zepto')),
    '/top must render the best deal’s store via storeLabel()'
  );

  // Watch alert: covered by the standalone watch-alert test above
  // (W3-owned, passes here).
});

test('design consistency: no message exceeds 3900 chars; long titles truncate, never cut mid-deal', async () => {
  // Digest — passes in this copy too (old splitMessages already caps),
  // kept as the merged-tree guard.
  const digestMsgs = formatDigest(LONG_FEEDS, { minDiscount: 50, date: FIXED_DATE });
  assert.ok(digestMsgs.length >= 1);
  for (const m of digestMsgs) assert.ok(m.length <= MAX_LEN, `digest message ${m.length} chars exceeds ${MAX_LEN}`);
  const digestText = digestMsgs.join('\n');
  assert.ok(digestText.includes('…'), 'long title must be truncated with an ellipsis');
  assert.ok(!digestText.includes(LONG_DEAL.title), 'the full 5000-char title must not survive');
  assert.ok(digestText.includes('(90% off)'), 'price part must survive intact');

  const { bot } = await setupBot(async () => LONG_FEEDS);

  // /deals — same guard via formatDigest.
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  for (const r of userMessages(USER_ID)) {
    assert.ok(r.text.length <= MAX_LEN, `/deals message ${r.text.length} chars exceeds ${MAX_LEN}`);
  }
  assert.ok(userMessages(USER_ID).map((r) => r.text).join('\n').includes('(90% off)'));

  // /top — MERGE-GATED: old /top prepends its header to an already-3900
  // char dealLine, so the message can reach ~3931 chars. The merged /top
  // must shorten the dealLine to fit header + footer inside the cap.
  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  const topReply = userMessages(USER_ID).at(-1);
  assert.ok(topReply, 'expected a /top reply');
  assert.ok(topReply.text.length <= MAX_LEN, `/top message ${topReply.text.length} chars exceeds ${MAX_LEN}: ` + topReply.text.slice(0, 80));
  assert.ok(topReply.text.includes('…'), '/top long title must be truncated with an ellipsis');
  assert.ok(!topReply.text.includes(LONG_DEAL.title), '/top must not carry the full 5000-char title');
  assert.ok(topReply.text.includes('(90% off)'), '/top price part must survive intact');
});

test('design consistency: empty states reply the noDealsLine() one-liner exactly once', async () => {
  // PASSES in this copy (the one-liner string is unchanged by the redesign).
  const { bot } = await setupBot(async () => ({}));
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  let replies = userMessages(USER_ID);
  assert.equal(replies.length, 1, 'empty /deals must produce exactly one reply');
  assert.equal(replies[0].text, design.noDealsLine(), 'empty /deals must be exactly noDealsLine()');

  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  replies = userMessages(USER_ID);
  assert.equal(replies.length, 1, 'empty /top must produce exactly one reply');
  assert.equal(replies[0].text, design.noDealsLine(), 'empty /top must be exactly noDealsLine()');
});

test('design consistency: only pinned emoji appear in bot messages', async () => {
  // MERGE-GATED: old messages carry 💎 (digest), 🏆 (/top), 🏬 (/stores),
  // 👋/🆓 (/start), 📋 (/status), 📊 (/subscribers) — none in the pinned set.
  const digestText = formatDigest(FEEDS, { minDiscount: 50, date: FIXED_DATE }).join('\n');
  assertOnlyPinnedEmoji(digestText, 'digest');

  const { bot } = await setupBot(async () => FEEDS);
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  assertOnlyPinnedEmoji(userMessages(USER_ID).at(-1).text, '/start');

  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  for (const r of userMessages(USER_ID)) assertOnlyPinnedEmoji(r.text, '/deals');

  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  assertOnlyPinnedEmoji(userMessages(USER_ID).at(-1).text, '/top');

  apiCalls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/stores'));
  assertOnlyPinnedEmoji(userMessages(USER_ID).at(-1).text, '/stores');
});
