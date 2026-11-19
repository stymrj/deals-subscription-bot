// jobs.test.js — digest sending with stub telegram and an in-memory db stub.
// Free model: there is no expiry handling anywhere — no runExpiryCheck
// export, and startJobs wires exactly one cron job (the 09:00 IST digest).
// No network, no real token.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('node-cron');
const jobs = require('../src/jobs');
const { runDigest, chatIdOf } = jobs;

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
function makeDb(rows) {
  const store = rows.map(r => ({ ...r }));
  return {
    rows: store,
    async getActiveSubscribers() {
      return store.filter(r => r.status === 'active');
    },
    async listSubscribers() { return store.map(r => ({ ...r })); },
  };
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

test('startJobs wires exactly one cron job (the 09:00 IST digest only)', () => {
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
