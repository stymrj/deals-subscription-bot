// jobs.test.js — digest sending with stub telegram and an in-memory db stub.
// Free model: there is no expiry handling anywhere — no runExpiryCheck
// export, and startJobs wires exactly one cron job (the every-15-minutes
// digest). Dedupe: the stub implements getRecentPostedKeys / markPosted
// over an in-memory Map; the real initDb(':memory:') store is used for
// the dedupe tests below. No network, no real token.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const jobs = require('../src/jobs');
const { runDigest, chatIdOf } = jobs;
const { initDb } = require('../src/db');
const { dealKey, DEDUPE_WINDOW_MS } = require('../src/dedupe');
const { loadFixture, STORE_ORDER } = require('../src/feed');
const { formatDigest } = require('../src/digest');
const { dealLine, watchAlert } = require('../src/design');

const CFG = {
  minDiscount: 50, digestTopPerStore: 5, digestHourIst: 9,
};
const NOW = new Date('2026-11-10T02:30:00Z'); // 08:00 IST
const DAY = 24 * 3600 * 1000;

function makeBot({ failFor = new Set() } = {}) {
  const sent = [];
  return {
    sent,
    telegram: {
      async sendMessage(chatId, text, opts) {
        if (failFor.has(chatId)) throw new Error('403: Forbidden: bot was blocked by the user');
        sent.push({ chatId, text, opts });
        return { message_id: sent.length };
      },
    },
  };
}

// In-memory db stub implementing the interface jobs.js expects under the
// free contract: getActiveSubscribers returns status === 'active' only
// (no legacy status, no expiry), listSubscribers returns all rows.
// Also implements the dedupe methods over an in-memory Map
// (deal_key -> posted_at) so the stub exercises the same code path as
// the real store, plus the W1 per-user methods getUserPrefs /
// listAllWatches (stubbed here because W1 is adding them to src/db.js
// concurrently; the real store does not have them yet in this copy).
// opts: { prefs: {userId: {user_id, stores, min_discount}}, watches:
// [{user_id, keyword}], posted: shared Map } — all optional.
function makeDb(rows, opts = {}) {
  const store = rows.map(r => ({ ...r }));
  const posted = opts.posted || new Map();
  const prefsByUser = opts.prefs || {};
  const watches = opts.watches || [];
  return {
    rows: store,
    posted,
    async getActiveSubscribers() {
      return store.filter(r => r.status === 'active');
    },
    async listSubscribers() { return store.map(r => ({ ...r })); },
    async getUserPrefs(userId) {
      return prefsByUser[userId] || { user_id: userId, stores: [...STORE_ORDER], min_discount: 50 };
    },
    async listAllWatches() { return watches.map(w => ({ ...w })); },
    async getRecentPostedKeys(sinceMs) {
      return new Set([...posted.entries()].filter(([, at]) => at >= sinceMs).map(([k]) => k));
    },
    async markPosted(entries) {
      for (const e of entries || []) posted.set(e.deal_key, e.posted_at);
    },
  };
}

// Real in-memory store (initDb(':memory:')) with the given users active.
async function makeRealDb(userIds = [101]) {
  const store = await initDb(':memory:');
  for (const id of userIds) {
    await store.upsertSubscriber({ user_id: id, name: 'Test', username: 'testuser' });
    await store.setStatus(id, 'active');
  }
  return store;
}

function stubFetch(dealsByStore) {
  return async (url) => {
    // Map URL -> store by repo slug embedded in the default URL.
    const slugToStore = {
      'Amazon-Now-Deals': 'Amazon Now', 'Blinkit-Deals': 'Blinkit',
      'Flipkart-Minute-Deals': 'Flipkart Minutes', 'BigBasket-Deals': 'BigBasket',
      'Myntra-Deals': 'Myntra', 'Croma-Deals': 'Croma', 'Zepto-Deals': 'Zepto',
      'Swiggy-Instamart-Deals': 'Swiggy Instamart', 'JioMart-Deals': 'JioMart',
    };
    const hit = Object.keys(slugToStore).find(slug => url.includes(slug));
    const name = hit ? slugToStore[hit] : 'Amazon Now';
    return { ok: true, status: 200, json: async () => ({ store: name, generatedAt: '2026-11-10T03:00:00Z', deals: dealsByStore[name] || [] }) };
  };
}

const FEED = {
  'Amazon Now': [{ title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: 'https://example.com/oil', cat: 'Grocery' }],
};

test('digest: active subscribers receive it; expired and legacy-status rows do not', async () => {
  const bot = makeBot();
  const db = makeDb([
    { telegram_id: 1, status: 'active' },
    { telegram_id: 2, status: 'trial' }, // legacy status row: must not receive the digest
    { telegram_id: 3, status: 'expired' },
    { telegram_id: 4, status: 'active' },
  ]);
  // Only rows 1 and 4 are active under the free contract.
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res.sent, 2, 'only active subscribers should get the digest');
  assert.deepEqual(bot.sent.map(s => s.chatId).sort(), [1, 4]);
  assert.ok(bot.sent[0].opts.parse_mode === 'HTML');
  assert.ok(bot.sent[0].text.includes('Oil 1L'));
});

test('digest: a blocked user fails alone — the rest still receive it', async () => {
  const bot = makeBot({ failFor: new Set([11]) });
  const db = makeDb([
    { telegram_id: 11, status: 'active' },
    { telegram_id: 12, status: 'active' },
  ]);
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res.sent, 1);
  assert.equal(res.failed.length, 1);
  assert.deepEqual(bot.sent.map(s => s.chatId), [12]);
});

test('digest: no active subscribers means nothing sent', async () => {
  const bot = makeBot();
  const db = makeDb([
    { telegram_id: 21, status: 'expired' },
  ]);
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res.sent, 0);
  assert.equal(res.subscribers, 0);
  assert.equal(bot.sent.length, 0);
});

test('chatIdOf picks the id field the subscriber row actually carries', () => {
  assert.equal(chatIdOf({ telegram_id: 1 }), 1);
  assert.equal(chatIdOf({ user_id: 2 }), 2);
  assert.equal(chatIdOf({ chat_id: 3 }), 3);
  assert.equal(chatIdOf({ id: 4 }), 4);
  assert.equal(chatIdOf({}), undefined);
});

test('expiry is gone: jobs.js exports no runExpiryCheck', () => {
  assert.equal(typeof jobs.runExpiryCheck, 'undefined', 'runExpiryCheck must not be exported');
  assert.deepEqual(Object.keys(jobs).sort(), ['chatIdOf', 'runDigest', 'startJobs']);
});

test('startJobs wires exactly one cron job (the every-15-minutes digest only)', () => {
  const bot = makeBot();
  const db = makeDb([]);
  const before = cron.getTasks().size;
  const handles = jobs.startJobs(bot, db, CFG);
  try {
    assert.equal(cron.getTasks().size - before, 1, 'startJobs must create exactly one cron job');
    assert.ok(handles.digestJob, 'expected a digestJob handle');
    assert.equal(handles.expiryJob, undefined, 'no expiryJob handle may exist');
    assert.equal(typeof handles.stop, 'function', 'expected a stop() handle');
  } finally {
    // stop() is the public shutdown path; destroy() removes the task from
    // node-cron's registry (stop() alone leaves it listed).
    if (handles && typeof handles.stop === 'function') handles.stop();
    if (handles && handles.digestJob && typeof handles.digestJob.destroy === 'function') handles.digestJob.destroy();
  }
  assert.equal(cron.getTasks().size, before, 'destroying the jobs must remove the cron job');
});

// --- Persistent dedupe (7-day window, real initDb(':memory:') store) ---

test('dedupe: identical feed sends on run 1 and nothing on run 2', async () => {
  const bot = makeBot();
  const db = await makeRealDb();
  try {
    const res1 = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
    assert.equal(res1.sent, 1);
    assert.equal(res1.newDeals, 1);
    assert.equal(res1.messages, 1);
    assert.equal(bot.sent.length, 1);
    const res2 = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
    assert.equal(res2.sent, 0);
    assert.equal(res2.newDeals, 0);
    assert.equal(res2.messages, 0);
    assert.equal(res2.subscribers, 1);
    assert.equal(bot.sent.length, 1, 'run 2 must not call sendMessage again');
    // The key is recorded as posted.
    const recent = await db.getRecentPostedKeys(0);
    assert.ok(recent.has(dealKey('Amazon Now', FEED['Amazon Now'][0])));
  } finally {
    await db.close();
  }
});

test('dedupe: deal posted more than 7 days ago IS re-sent', async () => {
  const bot = makeBot();
  const db = await makeRealDb();
  try {
    const deal = FEED['Amazon Now'][0];
    await db.markPosted([{
      deal_key: dealKey('Amazon Now', deal),
      store: 'Amazon Now',
      title: deal.title,
      posted_at: Date.now() - DEDUPE_WINDOW_MS - 60_000,
    }]);
    const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
    assert.equal(res.sent, 1);
    assert.equal(res.newDeals, 1);
    assert.ok(bot.sent[0].text.includes('Oil 1L'));
    // Re-marking refreshed posted_at to now, so the next run sends nothing.
    const res2 = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
    assert.equal(res2.newDeals, 0);
    assert.equal(bot.sent.length, 1);
  } finally {
    await db.close();
  }
});

test('dedupe: zero new deals means zero sendMessage calls and messages:0', async () => {
  const bot = makeBot();
  const db = await makeRealDb();
  try {
    const deal = FEED['Amazon Now'][0];
    await db.markPosted([{
      deal_key: dealKey('Amazon Now', deal),
      store: 'Amazon Now',
      title: deal.title,
      posted_at: Date.now(),
    }]);
    const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
    // REWRITTEN for the per-user digest: the return shape gained
    // alertsSent (0 here — no watches, no alerts), everything else kept.
    assert.deepEqual(res, { sent: 0, failed: [], subscribers: 1, messages: 0, newDeals: 0, alertsSent: 0 });
    assert.equal(bot.sent.length, 0);
  } finally {
    await db.close();
  }
});

test('dedupe: a store with only already-posted deals is omitted; other stores still send', async () => {
  const bot = makeBot();
  const db = await makeRealDb();
  try {
    const feeds = {
      'Amazon Now': [{ title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: 'https://example.com/oil', cat: 'Grocery' }],
      Zepto: [{ title: 'Ghee 500ml', price: 149, mrp: 349, disc: 57, url: 'https://example.com/ghee', cat: 'Grocery' }],
    };
    await db.markPosted([{
      deal_key: dealKey('Amazon Now', feeds['Amazon Now'][0]),
      store: 'Amazon Now',
      title: 'Oil 1L',
      posted_at: Date.now(),
    }]);
    const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(feeds), delayMs: 0 });
    assert.equal(res.sent, 1);
    assert.equal(res.newDeals, 1);
    assert.ok(bot.sent[0].text.includes('Ghee 500ml'));
    assert.ok(!bot.sent[0].text.includes('Oil 1L'), 'already-posted store must be omitted');
  } finally {
    await db.close();
  }
});

test('dedupe: a run where nobody receives the digest does not mark keys', async () => {
  const bot = makeBot({ failFor: new Set([101]) });
  const db = await makeRealDb([101]);
  try {
    const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
    assert.equal(res.sent, 0);
    assert.equal(res.failed.length, 1);
    assert.equal((await db.getRecentPostedKeys(0)).size, 0, 'failed run must not burn the deals');
  } finally {
    await db.close();
  }
});

test('dedupe: runDigest still works when the db has no dedupe methods (minimal stub)', async () => {
  // e.g. api.test.js's fake store: no getRecentPostedKeys / markPosted.
  // runDigest degrades to "no recent posts" instead of throwing.
  const bot = makeBot();
  const db = {
    async getActiveSubscribers() { return [{ telegram_id: 1, status: 'active' }]; },
  };
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res.sent, 1);
  assert.equal(res.newDeals, 1);
  assert.equal(res.alertsSent, 0, 'a store with no watch methods must send no alerts');
  assert.ok(bot.sent[0].text.includes('Oil 1L'));
});

test('digest parity: runDigest sends only the top-5 above-min deals per store', async () => {
  const bot = makeBot();
  const db = await makeRealDb();
  try {
    const mk = disc => ({ title: 'Deal ' + disc, price: 100, mrp: 200, disc, url: 'https://example.com/d' + disc, cat: 'Test' });
    const feeds = {
      'Amazon Now': [95, 90, 80, 70, 60, 55, 51].map(mk).concat(
        [{ title: 'Bad 49', price: 100, mrp: 200, disc: 49, url: 'https://example.com/bad', cat: 'Test' }]
      ),
    };
    const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(feeds), delayMs: 0 });
    assert.equal(res.newDeals, 5);
    const text = bot.sent.map(s => s.text).join('\n');
    for (const d of [95, 90, 80, 70, 60]) assert.ok(text.includes('Deal ' + d), 'missing ' + d);
    assert.ok(!text.includes('Deal 55') && !text.includes('Deal 51'), 'cut deal leaked through');
    assert.ok(!text.includes('Bad 49'), 'below-min deal leaked through');
  } finally {
    await db.close();
  }
});

test('dry-run: loadFixture + formatDigest writes no dedupe state', async () => {
  // The dry-run path (scripts/dry-run-digest.js) has no DB access at all:
  // it only loads fixtures and formats. Assert the store stays empty.
  const db = await initDb(':memory:');
  try {
    const deals = loadFixture();
    const messages = formatDigest(deals, CFG);
    assert.ok(messages.length >= 1, 'dry-run path should produce at least one message');
    assert.equal((await db.getRecentPostedKeys(0)).size, 0, 'dry-run must not write posted_deals');
  } finally {
    await db.close();
  }
});

// --- Per-user digest (W2 feature upgrade) ---

const MULTI_FEED = {
  Zepto: [{ title: 'Ghee 500ml', price: 149, mrp: 349, disc: 57, url: 'https://example.com/ghee', cat: 'Grocery' }],
  'Amazon Now': [
    { title: 'Oil 1L 55', price: 89, mrp: 199, disc: 55, url: 'https://example.com/oil55', cat: 'Grocery' },
    { title: 'Oil 1L 85', price: 29, mrp: 199, disc: 85, url: 'https://example.com/oil85', cat: 'Grocery' },
  ],
};

const sentTo = (bot, chatId) => bot.sent.filter(s => s.chatId === chatId);
const alertsTo = (bot, chatId) => sentTo(bot, chatId).filter(s => s.text.startsWith('🔔 <b>Watch alert:'));
const digestsTo = (bot, chatId) => sentTo(bot, chatId).filter(s => !s.text.startsWith('🔔 <b>Watch alert:'));

test('per-user digest: Zepto-only user gets only Zepto; 80% user gets only 80%+ deals', async () => {
  const bot = makeBot();
  const db = makeDb([
    { telegram_id: 1, status: 'active' },
    { telegram_id: 2, status: 'active' },
  ], {
    prefs: {
      1: { user_id: 1, stores: ['Zepto'], min_discount: 50 },
      2: { user_id: 2, stores: ['Amazon Now', 'Zepto'], min_discount: 80 },
    },
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(MULTI_FEED), delayMs: 0 });
  assert.equal(res.sent, 2);
  assert.equal(res.messages, 2, 'one digest message per user');
  assert.equal(res.newDeals, 2, 'user 1: 1 Zepto deal; user 2: 1 Amazon 85% deal');
  assert.equal(res.alertsSent, 0);
  const u1 = digestsTo(bot, 1).map(s => s.text).join('\n');
  assert.ok(u1.includes('Ghee 500ml'), 'Zepto user must get the Zepto deal');
  assert.ok(!u1.includes('Oil 1L'), 'Zepto-only user must not get Amazon deals');
  const u2 = digestsTo(bot, 2).map(s => s.text).join('\n');
  assert.ok(u2.includes('Oil 1L 85'), '80% user must get the 85% deal');
  assert.ok(!u2.includes('Oil 1L 55'), '80% user must not get the 55% deal');
  assert.ok(!u2.includes('Ghee 500ml'), '80% user must not get the 57% Zepto deal');
});

test('per-user digest: a user with zero enabled stores gets nothing and is not in failed', async () => {
  const bot = makeBot();
  const db = makeDb([
    { telegram_id: 1, status: 'active' },
    { telegram_id: 2, status: 'active' },
  ], {
    prefs: {
      1: { user_id: 1, stores: [], min_discount: 50 },
      2: { user_id: 2, stores: ['Zepto'], min_discount: 50 },
    },
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(MULTI_FEED), delayMs: 0 });
  assert.equal(res.sent, 1, 'only the user with stores gets the digest');
  assert.deepEqual(res.failed, []);
  assert.equal(res.newDeals, 1);
  assert.deepEqual(bot.sent.map(s => s.chatId), [2]);
});

test('per-user digest: a deal sent to user A in run 1 is not re-sent to user B in run 2', async () => {
  const sharedPosted = new Map();
  const botA = makeBot();
  const dbA = makeDb([{ telegram_id: 1, status: 'active' }], { posted: sharedPosted });
  const res1 = await runDigest(botA, dbA, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res1.sent, 1);
  assert.equal(res1.newDeals, 1);
  assert.equal(sharedPosted.size, 1, 'run 1 must mark the key');

  const botB = makeBot();
  const dbB = makeDb([{ telegram_id: 2, status: 'active' }], { posted: sharedPosted });
  const res2 = await runDigest(botB, dbB, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res2.sent, 0, 'user B must not get a deal user A already received');
  assert.equal(res2.newDeals, 0);
  assert.equal(botB.sent.length, 0);
});

test('watch alerts: keyword match (case-insensitive title) sends exactly one alert per matching deal per user', async () => {
  const bot = makeBot();
  const db = makeDb([
    { telegram_id: 1, status: 'active' },
    { telegram_id: 2, status: 'active' },
  ], {
    watches: [
      { user_id: 1, keyword: 'ghee' },
      { user_id: 2, keyword: 'oil' },
    ],
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(MULTI_FEED), delayMs: 0 });
  assert.equal(res.sent, 2, 'both users still get their digest');
  assert.equal(res.alertsSent, 3, 'user 1: 1 (ghee); user 2: 2 (both oil deals)');
  const a1 = alertsTo(bot, 1);
  assert.equal(a1.length, 1);
  // New design-system format: alert line + shared dealLine + footer.
  assert.equal(a1[0].text, watchAlert('ghee', MULTI_FEED.Zepto[0], 'Zepto'));
  assert.ok(a1[0].text.includes(dealLine(MULTI_FEED.Zepto[0], 'Zepto')), 'alert carries the shared deal line');
  assert.ok(a1[0].text.endsWith('\n—\nPriceDrop Hunter · /start · /stores · /stop'), 'alert ends with the shared footer');
  assert.equal(a1[0].opts.parse_mode, 'HTML');
  assert.equal(a1[0].opts.disable_web_page_preview, true);
  const a2 = alertsTo(bot, 2);
  assert.equal(a2.length, 2, 'one alert per matching deal, not one per user');
  assert.ok(a2.every(a => a.text.includes('Oil 1L')));
  assert.ok(a2.some(a => a.text.includes('Oil 1L 55')) && a2.some(a => a.text.includes('Oil 1L 85')));
});

test('watch alerts: two keywords matching the same deal still send only one alert for it', async () => {
  const bot = makeBot();
  const db = makeDb([{ telegram_id: 1, status: 'active' }], {
    watches: [
      { user_id: 1, keyword: 'ghee' },
      { user_id: 1, keyword: '500ml' },
    ],
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(MULTI_FEED), delayMs: 0 });
  assert.equal(res.alertsSent, 1);
  assert.equal(alertsTo(bot, 1).length, 1);
  assert.ok(alertsTo(bot, 1)[0].text.includes('<b>Watch alert: "ghee"</b>'), 'first matching keyword wins');
  assert.ok(!alertsTo(bot, 1)[0].text.includes('"500ml"'), 'second keyword must not appear in the alert');
});

test('watch alerts: non-matching deal sends no alert (digest still sent)', async () => {
  const bot = makeBot();
  const db = makeDb([{ telegram_id: 1, status: 'active' }], {
    watches: [{ user_id: 1, keyword: 'saffron' }],
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res.sent, 1);
  assert.equal(res.alertsSent, 0);
  assert.equal(bot.sent.length, 1, 'only the digest, no alert');
});

test('watch alerts: already-posted deal sends no alert', async () => {
  const bot = makeBot();
  const db = makeDb([{ telegram_id: 1, status: 'active' }], {
    watches: [{ user_id: 1, keyword: 'ghee' }],
  });
  await db.markPosted([{
    deal_key: dealKey('Zepto', MULTI_FEED.Zepto[0]),
    store: 'Zepto',
    title: 'Ghee 500ml',
    posted_at: Date.now(),
  }]);
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(MULTI_FEED), delayMs: 0 });
  assert.equal(res.sent, 1, 'the fresh Amazon deals still go out');
  assert.equal(res.alertsSent, 0, 'the posted ghee deal must not alert');
  assert.equal(alertsTo(bot, 1).length, 0);
  assert.ok(!digestsTo(bot, 1).map(s => s.text).join('\n').includes('Ghee 500ml'));
});

test('watch alerts: no alert for a deal whose store the user disabled', async () => {
  const bot = makeBot();
  const db = makeDb([{ telegram_id: 1, status: 'active' }], {
    prefs: { 1: { user_id: 1, stores: ['Amazon Now'], min_discount: 50 } },
    watches: [{ user_id: 1, keyword: 'ghee' }],
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(MULTI_FEED), delayMs: 0 });
  assert.equal(res.sent, 1);
  assert.equal(res.alertsSent, 0, 'the Zepto ghee deal is outside this user\'s stores');
  assert.ok(!bot.sent.map(s => s.text).join('\n').includes('Ghee 500ml'));
});

test('watch alerts: blocked user gets no alert and burns no keys', async () => {
  const bot = makeBot({ failFor: new Set([1]) });
  const db = makeDb([{ telegram_id: 1, status: 'active' }], {
    watches: [{ user_id: 1, keyword: 'oil' }],
  });
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.equal(res.sent, 0);
  assert.equal(res.failed.length, 1);
  assert.equal(res.alertsSent, 0, 'alerts are skipped when the digest send failed');
  assert.equal(db.posted.size, 0, 'a fully failed run must not mark keys');
});

test('per-user digest: nothing new means zero sends and alertsSent:0', async () => {
  const bot = makeBot();
  const db = makeDb([{ telegram_id: 1, status: 'active' }], {
    watches: [{ user_id: 1, keyword: 'oil' }],
  });
  await db.markPosted([{
    deal_key: dealKey('Amazon Now', FEED['Amazon Now'][0]),
    store: 'Amazon Now',
    title: 'Oil 1L',
    posted_at: Date.now(),
  }]);
  const res = await runDigest(bot, db, CFG, { fetchFn: stubFetch(FEED), delayMs: 0 });
  assert.deepEqual(res, { sent: 0, failed: [], subscribers: 1, messages: 0, newDeals: 0, alertsSent: 0 });
  assert.equal(bot.sent.length, 0);
  assert.equal(db.posted.size, 1, 'markPosted must not be called when nothing was sent');
});
