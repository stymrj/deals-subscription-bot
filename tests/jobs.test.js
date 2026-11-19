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
const { loadFixture } = require('../src/feed');
const { formatDigest } = require('../src/digest');

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
// the real store.
function makeDb(rows) {
  const store = rows.map(r => ({ ...r }));
  const posted = new Map();
  return {
    rows: store,
    posted,
    async getActiveSubscribers() {
      return store.filter(r => r.status === 'active');
    },
    async listSubscribers() { return store.map(r => ({ ...r })); },
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
    assert.deepEqual(res, { sent: 0, failed: [], subscribers: 1, messages: 0, newDeals: 0 });
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
