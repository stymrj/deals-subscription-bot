'use strict';

// tests/api.test.js — Vercel serverless shape: webhook + cron-digest + vercel.json.
// Stub-based, NO network, NO real credentials. The real createBot and the
// real runDigest are exercised; Telegram API calls are captured by patching
// Telegram.prototype.callApi (every outbound method funnels through it —
// see tests/bot.test.js), feed fetches are stubbed via global fetch, and
// the store/config are injected through the api/_bot.js test seam
// (__setTestOverrides). Nothing here touches a real DB file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getBot, __setTestOverrides, __resetTestOverrides } = require('../api/_bot');
const webhookHandler = require('../api/webhook');
const cronHandler = require('../api/cron-digest');
const { loadFixture } = require('../src/feed');
const { formatDigest } = require('../src/digest');

const ADMIN_ID = 999;
const USER_ID = 111;

function testConfig() {
  return {
    botToken: 'TEST_TOKEN_NOT_REAL',
    adminId: ADMIN_ID,
    minDiscount: 50,
    digestTopPerStore: 5,
    digestHourIst: 9,
    botMode: 'webhook',
    port: 3000,
    // Worker 1's contract field (Turso URL or `file:` fallback). The fake
    // store below means initDb is never called in these tests, but the
    // field is present so the config shape matches production.
    databaseUrl: 'file::memory:?cache=shared',
    databasePath: ':memory:',
    webhookUrl: 'https://test.example.invalid',
    feedUrls: '',
  };
}

// Fake store implementing the NEW (worker 1) async contract: every method
// is async. Bodies are synchronous Map operations, so the current sync
// callers in src/bot.js still observe the mutation by the time they reply.
function makeFakeStore() {
  const rows = new Map();
  return {
    rows,
    async getSubscriber(userId) {
      const row = rows.get(userId);
      return row ? { ...row } : null;
    },
    async upsertSubscriber({ user_id, name, username }) {
      const existing = rows.get(user_id);
      const row = existing
        ? { ...existing, name: name || existing.name, username: username ?? existing.username }
        : { user_id, name, username, status: 'expired', created_at: Date.now() };
      rows.set(user_id, row);
      return { ...row };
    },
    async setStatus(userId, status) {
      const row = rows.get(userId);
      if (!row) return null;
      row.status = status;
      return { ...row };
    },
    async listSubscribers() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    async getActiveSubscribers() {
      return [...rows.values()].filter((r) => r.status === 'active').map((r) => ({ ...r }));
    },
    async close() {},
  };
}

// --- Telegram API capture (same technique as tests/bot.test.js) ---
const apiCalls = [];
const origCallApi = require('telegraf').Telegram.prototype.callApi;
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
test.after(() => {
  require('telegraf').Telegram.prototype.callApi = origCallApi;
});

// --- Minimal Vercel req/res doubles ---
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  return res;
}

let updateId = 0;
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
      ...(isCommand
        ? { entities: [{ offset: 0, length: cmdLen, type: 'bot_command' }] }
        : {}),
    },
  };
}

// Pre-warm the cached bot via the seam and pin botInfo so handleUpdate
// never needs a getMe round-trip (the callApi stub would answer it anyway).
async function warmBot(store) {
  __setTestOverrides({ config: testConfig(), store });
  const built = await getBot();
  built.bot.botInfo = { id: 1, is_bot: true, first_name: 'TestBot', username: 'testbot' };
  return built;
}

// --- Cron auth helpers ---
// The handler reads the expected secret from the real config module in
// production, falling back to process.env.CRON_SECRET when config cannot
// load (here ADMIN_ID is unset, so config throws). Tests therefore
// control the secret via process.env — the __setTestOverrides seam
// config is NOT read by the handler, because auth runs before getBot().
const FAKE_CRON_SECRET = 'test-cron-secret-not-real';

// Set (or delete, when value is undefined) process.env.CRON_SECRET for
// the duration of one test, restoring the previous value afterwards.
function withCronSecretEnv(t, value) {
  const hadPrev = Object.prototype.hasOwnProperty.call(process.env, 'CRON_SECRET');
  const prev = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  t.after(() => {
    if (hadPrev) process.env.CRON_SECRET = prev;
    else delete process.env.CRON_SECRET;
  });
}

// Stub global fetch so fetchDeals serves the fixture per store, by repo slug
// (same mapping as the cron test above).
function stubFixtureFetch(t, fixture) {
  const origFetch = globalThis.fetch;
  const slugToStore = {
    'Amazon-Now-Deals': 'Amazon Now', 'Blinkit-Deals': 'Blinkit',
    'Flipkart-Minute-Deals': 'Flipkart Minutes', 'BigBasket-Deals': 'BigBasket',
    'Myntra-Deals': 'Myntra', 'Croma-Deals': 'Croma', 'Zepto-Deals': 'Zepto',
    'Swiggy-Instamart-Deals': 'Swiggy Instamart', 'JioMart-Deals': 'JioMart',
  };
  globalThis.fetch = async (url) => {
    const hit = Object.keys(slugToStore).find((slug) => String(url).includes(slug));
    const name = hit ? slugToStore[hit] : 'Amazon Now';
    return {
      ok: true,
      status: 200,
      json: async () => ({ store: name, generatedAt: '2026-11-10T03:00:00Z', deals: fixture[name] || [] }),
    };
  };
  t.after(() => {
    globalThis.fetch = origFetch;
  });
}

// Shared setup for cron tests that expect the digest to RUN: one active
// subscriber, warmed bot, fixture fetch stub, clean apiCalls.
async function setupRunningCron(t) {
  const store = makeFakeStore();
  await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
  await store.setStatus(USER_ID, 'active');
  await warmBot(store);
  const fixture = loadFixture();
  const expectedMessages = formatDigest(fixture, testConfig());
  assert.equal(expectedMessages.length, 2, 'fixture digest must be 2 messages (same as npm run digest:dry)');
  stubFixtureFetch(t, fixture);
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  apiCalls.length = 0;
  return { fixture, expectedMessages };
}

// (a) Webhook accepts a stubbed /start update end-to-end through the real
// createBot + fake async store and returns 200.
test('webhook: POST /start update -> 200 {ok:true}, welcome reply sent, subscriber recorded', async (t) => {
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  const store = makeFakeStore();
  await warmBot(store);
  apiCalls.length = 0;

  const res = makeRes();
  await webhookHandler({ method: 'POST', body: messageUpdate(USER_ID, '/start') }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  const reply = apiCalls.find(
    (c) => c.method === 'sendMessage' && c.chat_id === USER_ID
  );
  assert.ok(reply, 'expected a welcome sendMessage to the user');
  assert.match(reply.text, /free/i, 'welcome must say the subscription is free');
  const row = await store.getSubscriber(USER_ID);
  assert.ok(row, 'the /start user must be recorded in the store');
  assert.equal(row.status, 'expired', 'fresh /start alone must not subscribe (only the Subscribe button does)');
});

// (b) Non-POST -> 405.
test('webhook: non-POST -> 405 JSON, bot never built', async (t) => {
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  // No overrides set on purpose: a 405 must return before getBot() runs,
  // so this also proves no env/config is needed for the method check.
  const res = makeRes();
  await webhookHandler({ method: 'GET', body: null }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { ok: false, error: 'Method not allowed' });
  assert.equal(apiCalls.length, 0, 'no Telegram call may happen on a 405');
});

// (c) Malformed body -> 200 (no Telegram retry storm).
test('webhook: malformed body -> 200 {ok:true}, nothing sent', async (t) => {
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  const store = makeFakeStore();
  await warmBot(store);
  apiCalls.length = 0;

  for (const badBody of ['{not json', 'not json at all', 42, [1, 2, 3]]) {
    const res = makeRes();
    await webhookHandler({ method: 'POST', body: badBody }, res);
    assert.equal(res.statusCode, 200, `malformed body ${JSON.stringify(badBody)} must still ack 200`);
    assert.deepEqual(res.body, { ok: true });
  }
  // An empty-object update has no recognisable content: still 200, no sends.
  const res = makeRes();
  await webhookHandler({ method: 'POST', body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(apiCalls.length, 0, 'malformed updates must not produce outbound calls');
});

// Extra: bot failing to initialise -> 500 (deploy misconfiguration visible).
test('webhook: bot init failure -> 500 {ok:false}', async (t) => {
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  __setTestOverrides({
    config: testConfig(),
    initDb: async () => {
      throw new Error('TURSO_UNAVAILABLE');
    },
  });
  const res = makeRes();
  await webhookHandler({ method: 'POST', body: messageUpdate(USER_ID, '/start') }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ok: false, error: 'Bot failed to initialise' });
});

// (d) Cron runs runDigest from fixtures and returns the runDigest result.
test('cron: runs the fixture digest -> 200 {sent, failed, subscribers, messages} matching digest:dry', async (t) => {
  const store = makeFakeStore();
  await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
  await store.setStatus(USER_ID, 'active');
  await warmBot(store);

  const fixture = loadFixture();
  const expectedMessages = formatDigest(fixture, testConfig());
  assert.equal(expectedMessages.length, 2, 'fixture digest must be 2 messages (same as npm run digest:dry)');

  // Stub global fetch so fetchDeals serves the fixture per store, by repo slug.
  const origFetch = globalThis.fetch;
  const slugToStore = {
    'Amazon-Now-Deals': 'Amazon Now', 'Blinkit-Deals': 'Blinkit',
    'Flipkart-Minute-Deals': 'Flipkart Minutes', 'BigBasket-Deals': 'BigBasket',
    'Myntra-Deals': 'Myntra', 'Croma-Deals': 'Croma', 'Zepto-Deals': 'Zepto',
    'Swiggy-Instamart-Deals': 'Swiggy Instamart', 'JioMart-Deals': 'JioMart',
  };
  globalThis.fetch = async (url) => {
    const hit = Object.keys(slugToStore).find((slug) => String(url).includes(slug));
    const name = hit ? slugToStore[hit] : 'Amazon Now';
    return {
      ok: true,
      status: 200,
      json: async () => ({ store: name, generatedAt: '2026-11-10T03:00:00Z', deals: fixture[name] || [] }),
    };
  };
  t.after(() => {
    globalThis.fetch = origFetch;
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  apiCalls.length = 0;

  const res = makeRes();
  await cronHandler({ method: 'GET', headers: { 'x-vercel-cron': '1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, 1, 'one active subscriber must receive the digest');
  assert.deepEqual(res.body.failed, []);
  assert.equal(res.body.subscribers, 1);
  assert.equal(res.body.messages, 2, 'fixture digest is 2 messages');

  const sent = apiCalls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.equal(sent.length, 2, 'both digest messages must be sent to the subscriber');
  assert.deepEqual(
    sent.map((c) => c.text),
    expectedMessages.map((m) => m.text),
    'sent texts must equal the fixture digest (same shape as npm run digest:dry)'
  );
  // Each digest message carries its Grab Deal buttons on reply_markup.
  assert.ok(sent[0].reply_markup, 'digest message must attach Grab Deal buttons');
  const firstButtons = JSON.parse(JSON.stringify(sent[0].reply_markup.inline_keyboard)).flat();
  assert.ok(firstButtons.length >= 1 && firstButtons.length <= 8, 'button count must respect the 8-per-message cap');
  assert.ok(firstButtons.every((b) => b.text === '🛒 Grab Deal' && b.url.startsWith('https://')), 'every button must be a Grab Deal link');
});

// (e) vercel.json parses to {} — no Vercel crons: the 15-min digest is
// triggered by GitHub Actions (.github/workflows/digest-15min.yml),
// because Vercel Hobby allows at most one cron run per day.
test('vercel.json: parses to {} — no Vercel crons (GitHub Actions triggers the digest)', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, {}, 'vercel.json must be empty: no Vercel cron (Hobby allows one run/day)');
});

// (f) Cron auth: CRON_SECRET unset + no header -> 401, zero sends.
// The 401 must happen BEFORE getBot()/runDigest, so no digest message
// can go out (asserted on the fake bot's captured Telegram calls).
test('cron auth: CRON_SECRET unset + no header -> 401, zero sends', async (t) => {
  withCronSecretEnv(t, undefined);
  const store = makeFakeStore();
  await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
  await store.setStatus(USER_ID, 'active');
  await warmBot(store);
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  apiCalls.length = 0;

  const res = makeRes();
  await cronHandler({ method: 'GET', headers: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, error: 'Unauthorized' });
  assert.equal(apiCalls.length, 0, 'a 401 must send nothing (runDigest never runs)');
  assert.equal(
    apiCalls.filter((c) => c.method === 'sendMessage').length,
    0,
    'no sendMessage may happen on a 401'
  );
});

// (g) Cron auth: correct secret via ?secret= query param -> digest runs.
test('cron auth: correct secret via ?secret= -> 200, digest runs', async (t) => {
  withCronSecretEnv(t, FAKE_CRON_SECRET);
  const { expectedMessages } = await setupRunningCron(t);

  const res = makeRes();
  await cronHandler({ method: 'GET', headers: {}, query: { secret: FAKE_CRON_SECRET } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, 1, 'one active subscriber must receive the digest');
  assert.equal(res.body.messages, 2, 'fixture digest is 2 messages');
  const sent = apiCalls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.equal(sent.length, 2, 'both digest messages must be sent to the subscriber');
  assert.deepEqual(sent.map((c) => c.text), expectedMessages.map((m) => m.text));
});

// (g2) Cron auth: correct secret via ?secret= in the URL string -> runs.
// (Vercel populates req.query, but the handler also parses req.url.)
test('cron auth: correct secret via ?secret= in req.url -> 200, digest runs', async (t) => {
  withCronSecretEnv(t, FAKE_CRON_SECRET);
  await setupRunningCron(t);

  const res = makeRes();
  await cronHandler(
    { method: 'GET', headers: {}, url: `/api/cron-digest?secret=${FAKE_CRON_SECRET}` },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, 1);
});

// (h) Cron auth: correct secret via x-cron-secret header -> digest runs.
test('cron auth: correct secret via x-cron-secret header -> 200, digest runs', async (t) => {
  withCronSecretEnv(t, FAKE_CRON_SECRET);
  await setupRunningCron(t);

  const res = makeRes();
  await cronHandler({ method: 'GET', headers: { 'x-cron-secret': FAKE_CRON_SECRET } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, 1, 'one active subscriber must receive the digest');
  assert.equal(res.body.messages, 2, 'fixture digest is 2 messages');
  const sent = apiCalls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.equal(sent.length, 2, 'both digest messages must be sent to the subscriber');
});

// (i) Cron auth: wrong secret (header and query) -> 401, zero sends.
test('cron auth: wrong secret -> 401, zero sends', async (t) => {
  withCronSecretEnv(t, FAKE_CRON_SECRET);
  const store = makeFakeStore();
  await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
  await store.setStatus(USER_ID, 'active');
  await warmBot(store);
  t.after(() => {
    __resetTestOverrides();
    apiCalls.length = 0;
  });
  apiCalls.length = 0;

  for (const req of [
    { method: 'GET', headers: { 'x-cron-secret': 'wrong-secret' } },
    { method: 'GET', headers: {}, query: { secret: 'wrong-secret' } },
  ]) {
    const res = makeRes();
    await cronHandler(req, res);
    assert.equal(res.statusCode, 401, `wrong secret must 401: ${JSON.stringify(req)}`);
    assert.deepEqual(res.body, { ok: false, error: 'Unauthorized' });
  }
  assert.equal(apiCalls.length, 0, 'wrong-secret hits must send nothing');
});

// (j) Cron auth: x-vercel-cron header present, no secret configured ->
// digest runs (keeps the endpoint working if a Vercel cron is re-added).
test('cron auth: x-vercel-cron header, no secret configured -> 200, digest runs', async (t) => {
  withCronSecretEnv(t, undefined);
  await setupRunningCron(t);

  const res = makeRes();
  await cronHandler({ method: 'GET', headers: { 'x-vercel-cron': '1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, 1, 'one active subscriber must receive the digest');
  assert.equal(res.body.messages, 2, 'fixture digest is 2 messages');
  const sent = apiCalls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.equal(sent.length, 2, 'both digest messages must be sent to the subscriber');
});
