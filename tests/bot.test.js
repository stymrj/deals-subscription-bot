'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createBot, nextDigestLabel } = require('../src/bot');
const { STORE_ORDER } = require('../src/feed');
const { storeLabel, noDealsLine, header, footer, cadenceLine, dealLine, dealCard, escapeHtml } = require('../src/design');

const ADMIN_ID = 999;
const USER_ID = 111;

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

const { Telegraf } = require('telegraf');

/**
 * Telegraf v4 creates a fresh Telegram client per update inside
 * handleUpdate (from bot.token), so replacing bot.telegram does NOT stub
 * ctx calls. Instead we patch Telegram.prototype.callApi — every outbound
 * API method (sendMessage, sendPhoto, answerCbQuery, editMessageCaption,
 * getMe) funnels through it. No network is ever touched.
 */
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

/** View of captured calls shaped like the old stub ({ method, chatId, text, ... }). */
function makeTelegramView() {
  const calls = apiCalls;
  return {
    calls,
    find: (pred) => calls.find(pred),
  };
}

async function setup(fetchDealsStub) {
  apiCalls.length = 0;
  const store = await initDb(':memory:');
  const { bot, sendToSubscribers, notifyAdmin } = createBot({
    config: testConfig(),
    store,
    fetchDeals: fetchDealsStub,
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'TestBot', username: 'testbot' };
  return { store, bot, telegram: makeTelegramView(), sendToSubscribers, notifyAdmin };
}

let updateId = 0;
function messageUpdate(userId, text, extra = {}) {
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
      ...extra,
    },
  };
}

function callbackUpdate(userId, data) {
  return {
    update_id: ++updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: userId, is_bot: false, first_name: 'Test', username: 'testuser' },
      message: {
        message_id: 1,
        chat: { id: userId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'choose an option',
      },
      data,
    },
  };
}

function photoUpdate(userId) {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'Test', username: 'testuser' },
      chat: { id: userId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: 'small', file_unique_id: 's', width: 100, height: 100 },
        { file_id: 'large-photo-id', file_unique_id: 'l', width: 800, height: 800 },
      ],
    },
  };
}

/** All sendMessage/sendPhoto calls addressed to the admin. */
function adminCalls(telegram) {
  return telegram.calls.filter(
    (c) => (c.method === 'sendMessage' || c.method === 'sendPhoto') && c.chat_id === ADMIN_ID
  );
}

test('db contract: new subscriber starts expired; no legacy payment/expiry API on the store', async () => {
  const store = await initDb(':memory:');
  try {
    const sub = await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
    assert.equal(sub.status, 'expired', 'fresh subscriber must start expired (not active)');
    assert.ok(!('trial_used' in sub), 'trial_used must not exist on the subscriber row');
    assert.ok(!('expires_at' in sub), 'expires_at must not exist on the subscriber row');

    // No payment methods, no legacy or reminder helpers.
    for (const name of ['createPayment', 'getPayment', 'getPendingPayments', 'decidePayment']) {
      assert.equal(store[name], undefined, `store.${name} must not exist`);
    }
    for (const name of ['updateSubscriber', 'setReminderField', 'markTrialUsed']) {
      assert.equal(store[name], undefined, `store.${name} must not exist`);
    }

    // Two-arg setStatus: 'active' only is what getActiveSubscribers returns.
    await store.setStatus(USER_ID, 'active');
    assert.equal((await store.getSubscriber(USER_ID)).status, 'active');
    assert.deepEqual((await store.getActiveSubscribers()).map((s) => s.user_id), [USER_ID]);
    await store.setStatus(USER_ID, 'expired');
    assert.deepEqual(await store.getActiveSubscribers(), []);
    assert.equal((await store.listSubscribers()).length, 1);
  } finally {
    await store.close();
  }
});

test('free subscribe: fresh user taps subscribe → active, in digest recipients, second tap idempotent', async () => {
  const { store, bot, telegram, sendToSubscribers } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  telegram.calls.length = 0; // drop the welcome so only the subscribe reply is matched below

  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));

  const sub = await store.getSubscriber(USER_ID);
  assert.equal(sub.status, 'active', 'subscribe must activate instantly, free');
  assert.deepEqual((await store.getActiveSubscribers()).map((s) => s.user_id), [USER_ID]);

  const confirm = telegram.calls.find(
    (c) => c.method === 'sendMessage' && c.chat_id === USER_ID && /active|subscribed|free/i.test(c.text || '')
  );
  assert.ok(confirm, 'user should get a free-activation confirmation');
  assert.ok(!/₹|expir|pay/i.test(confirm.text), 'confirmation must not mention price/expiry/payment: ' + confirm.text);

  // The new subscriber is a digest recipient.
  const result = await sendToSubscribers('digest hello');
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.ok(telegram.calls.some((c) => c.method === 'sendMessage' && c.chat_id === USER_ID && c.text === 'digest hello'));

  // Second tap is idempotent: still active, still exactly one row.
  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  assert.equal((await store.getSubscriber(USER_ID)).status, 'active');
  assert.equal((await store.listSubscribers()).length, 1);
  assert.deepEqual((await store.getActiveSubscribers()).map((s) => s.user_id), [USER_ID]);
});

test('/stop: active user stops and leaves the digest; non-subscribed user gets a polite reply', async () => {
  const { store, bot, telegram } = await setup();
  const uid = 777;
  // No subscription yet -> polite reply, no crash.
  await bot.handleUpdate(messageUpdate(uid, '/stop'));
  const polite = telegram.find((c) => c.method === 'sendMessage' && c.chat_id === uid);
  assert.ok(polite);
  assert.match(polite.text, /no active subscription/i);
  assert.equal((await store.getSubscriber(uid)).status, 'expired');

  // Activate for free, then /stop.
  await bot.handleUpdate(messageUpdate(uid, '/start'));
  await bot.handleUpdate(callbackUpdate(uid, 'subscribe'));
  assert.equal((await store.getSubscriber(uid)).status, 'active');
  await bot.handleUpdate(messageUpdate(uid, '/stop'));
  assert.equal((await store.getSubscriber(uid)).status, 'expired');
  const stopped = telegram.find(
    (c) => c.method === 'sendMessage' && c.chat_id === uid && /stopped/i.test(c.text || '')
  );
  assert.ok(stopped, 'expected a stopped confirmation');
  assert.ok(!/refund|₹/i.test(stopped.text), 'stop reply must not mention refunds/price');
  // Stopped user is no longer an active subscriber.
  assert.equal((await store.getActiveSubscribers()).filter((s) => s.user_id === uid).length, 0);
});

test('/status: subscribed user sees Free wording and no price/expiry text; unsubscribed sees not-subscribed', async () => {
  const { bot, telegram } = await setup();
  // Unsubscribed first.
  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  let reply = telegram.calls.at(-1);
  assert.match(reply.text, /free/i, 'status should say the plan is free');
  assert.match(reply.text, /not (a )?subscriber|not subscribed/i, 'unsubscribed user must see not-subscribed wording');
  // Footer carries the brand name "PriceDrop Hunter", so the price check
  // must not match the word "price" inside the brand name.
  assert.ok(!/₹|\b49\b|expir/i.test(reply.text), 'status must not mention price/expiry: ' + reply.text);

  // Subscribe, then /status again.
  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /free subscriber/i);
  assert.match(reply.text, /next digest/i, 'status should show the next digest time');
  assert.ok(!/₹|\b49\b|expir/i.test(reply.text), 'status must not mention price/expiry: ' + reply.text);
});

test('photo: subscribed and unsubscribed users get a no-payment-needed reply; nothing stored, nothing to admin', async () => {
  const { store, bot, telegram } = await setup();
  // The store has no payment API at all.
  assert.equal(store.createPayment, undefined);
  assert.equal(store.getPayment, undefined);

  // Unsubscribed user sends a photo.
  await bot.handleUpdate(photoUpdate(USER_ID));
  let reply = telegram.find((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.ok(reply, 'expected a reply to the photo');
  assert.match(reply.text, /no payment needed/i);
  assert.equal(adminCalls(telegram).length, 0, 'photo must not be forwarded to admin');

  // Subscribed user sends a photo.
  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  assert.equal((await store.getSubscriber(USER_ID)).status, 'active');
  telegram.calls.length = 0;
  await bot.handleUpdate(photoUpdate(USER_ID));
  reply = telegram.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID).at(-1);
  assert.ok(reply, 'expected a reply to the photo from a subscriber');
  assert.match(reply.text, /no payment needed/i);
  assert.equal(adminCalls(telegram).length, 0, 'subscriber photo must not be forwarded to admin');
  assert.equal((await store.getSubscriber(USER_ID)).status, 'active', 'photo must not change subscription status');
});

test('legacy callback is gone: tapping it activates nothing and sends nothing', async () => {
  const { store, bot, telegram } = await setup();
  await bot.handleUpdate(callbackUpdate(USER_ID, 'trial'));

  const sub = await store.getSubscriber(USER_ID);
  assert.ok(!sub || sub.status === 'expired', 'legacy callback must not activate anyone');
  assert.deepEqual(await store.getActiveSubscribers(), [], 'legacy callback must not create a digest recipient');
  assert.equal(telegram.calls.length, 0, 'legacy callback must produce no outbound call at all');
});

test('approve:/reject: callbacks are inert — no payment, no activation, no crash', async () => {
  const { store, bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  telegram.calls.length = 0;

  await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'approve:1'));
  await bot.handleUpdate(callbackUpdate(ADMIN_ID, 'reject:1'));

  assert.equal((await store.getSubscriber(USER_ID)).status, 'active', 'subscribe state must be untouched by approve/reject taps');
  assert.equal(adminCalls(telegram).length, 0, 'no payment forwarding must happen');
});

test('admin: /subscribers counts Active vs Stopped with no legacy counts; /broadcast is admin-only and reaches actives', async () => {
  const { store, bot, telegram } = await setup();
  // Seed one active subscriber and one stopped (never subscribed) user.
  await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
  await store.setStatus(USER_ID, 'active');
  await store.upsertSubscriber({ user_id: 222, name: 'Stopped', username: 'stoppeduser' });
  await store.setStatus(222, 'expired');

  await bot.handleUpdate(messageUpdate(333, '/subscribers'));
  let reply = telegram.calls.at(-1);
  assert.match(reply.text, /admin only/);

  await bot.handleUpdate(messageUpdate(ADMIN_ID, '/subscribers'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /Active: 1/);
  assert.match(reply.text, /(Stopped|Expired): 1/);
  assert.ok(!/Trial:/i.test(reply.text), 'no legacy counts allowed: ' + reply.text);
  assert.match(reply.text, /testuser/);

  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(333, '/broadcast hello'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /admin only/);

  await bot.handleUpdate(messageUpdate(ADMIN_ID, '/broadcast hello all'));
  const sent = telegram.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.equal(sent.length, 1, 'broadcast must reach the active subscriber');
  assert.equal(sent[0].text, 'hello all');
  assert.equal(
    telegram.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === 222).length,
    0,
    'broadcast must not reach the stopped user'
  );
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /Sent to 1 subscribers, 0 failed/);
});

test('sendToSubscribers only reaches active subscribers', async () => {
  const { store, sendToSubscribers, telegram } = await setup();
  await store.upsertSubscriber({ user_id: 1, name: 'A', username: 'a' });
  await store.setStatus(1, 'active');
  await store.upsertSubscriber({ user_id: 2, name: 'B', username: 'b' });
  await store.setStatus(2, 'expired');
  await store.upsertSubscriber({ user_id: 3, name: 'C', username: 'c' });
  // Never activated: stays expired.
  assert.equal((await store.getSubscriber(3)).status, 'expired');

  const result = await sendToSubscribers('digest');
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(telegram.calls.filter((c) => c.chat_id === 1).length, 1);
});

test('/start offers free subscribe with no price or legacy button; /myid reports the numeric id', async () => {
  const { bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  const startReply = telegram.calls.find((c) => c.method === 'sendMessage');
  assert.ok(startReply);
  assert.match(startReply.text, /free/i);
  assert.ok(!/₹|\b49\b/i.test(startReply.text), 'welcome must not mention price: ' + startReply.text);
  const buttons = (startReply.reply_markup?.inline_keyboard || []).flat();
  assert.ok(buttons.some((b) => b.callback_data === 'subscribe'), 'expected a subscribe button');
  assert.ok(!buttons.some((b) => b.callback_data === 'trial'), 'no legacy button allowed');

  await bot.handleUpdate(messageUpdate(USER_ID, '/myid'));
  assert.match(telegram.calls.at(-1).text, new RegExp(String(USER_ID)));
});

test('/help has no price and points at /status', async () => {
  const { bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/help'));
  const reply = telegram.calls.at(-1);
  assert.ok(reply);
  assert.match(reply.text, /\/status/);
  assert.ok(!/₹/i.test(reply.text), 'help must not mention price: ' + reply.text);
});

test('/start and /help each list all 9 stores (one shared list, no drift)', async () => {
  assert.equal(STORE_ORDER.length, 9, 'canonical store list must have 9 stores');
  const { bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  const startReply = telegram.calls.find((c) => c.method === 'sendMessage');
  assert.ok(startReply, 'expected a /start reply');
  for (const store of STORE_ORDER) {
    assert.ok(startReply.text.includes(store), `/start must list ${store}: ` + startReply.text);
  }

  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/help'));
  const helpReply = telegram.calls.at(-1);
  assert.ok(helpReply, 'expected a /help reply');
  for (const store of STORE_ORDER) {
    assert.ok(helpReply.text.includes(store), `/help must list ${store}: ` + helpReply.text);
  }
});

test('cadence copy: welcome/help/subscribe/status say every 15 minutes, no 9 AM / morning / daily left', async () => {
  const { bot, telegram } = await setup();
  const stale = /9 AM|every morning|daily digest|Daily Digest|Daily Deals/i;

  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  let reply = telegram.calls.find((c) => c.method === 'sendMessage');
  assert.match(reply.text, /every 15 minutes/i, 'welcome must state the 15-minute cadence');
  assert.match(reply.text, /50%\+ off/i, 'welcome must state 50%+ off');
  assert.match(reply.text, /duplicates removed/i, 'welcome must state duplicates are removed');
  assert.ok(!stale.test(reply.text), 'welcome has stale daily copy: ' + reply.text);

  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/help'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /every 15 minutes/i, 'help must state the 15-minute cadence');
  assert.ok(!stale.test(reply.text), 'help has stale daily copy: ' + reply.text);

  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  // The welcome also carries a 🎉 now, so target the confirmation by its
  // header text, not by the first 🎉 message.
  reply = telegram.calls.find((c) => c.method === 'sendMessage' && (c.text || '').includes('Subscribed'));
  assert.ok(reply, 'expected a subscribe confirmation');
  assert.match(reply.text, /every 15 minutes/i, 'subscribe reply must state the 15-minute cadence');
  assert.ok(!stale.test(reply.text), 'subscribe reply has stale daily copy: ' + reply.text);

  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /every 15 minutes/i, 'status must state the 15-minute cadence');
  assert.ok(!stale.test(reply.text), 'status has stale daily copy: ' + reply.text);

  // A subscribed user's photo reply also carries the new cadence.
  telegram.calls.length = 0;
  await bot.handleUpdate(photoUpdate(USER_ID));
  reply = telegram.find((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
  assert.match(reply.text, /every 15 minutes/i, 'photo reply must state the 15-minute cadence');
  assert.ok(!stale.test(reply.text), 'photo reply has stale daily copy: ' + reply.text);
});

/** Minutes after IST midnight parsed out of a nextDigestLabel string. */
function labelMinutesIst(label) {
  const m = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  assert.ok(m, 'label must carry an IST time: ' + label);
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') hour += 12;
  return hour * 60 + Number(m[2]);
}

test('nextDigestLabel lands on a 15-minute IST boundary (incl. midnight rollover)', () => {
  // 12:37:00Z = 18:07 IST -> next boundary 18:15.
  let label = nextDigestLabel(Date.parse('2026-11-19T12:37:00Z'), 9);
  assert.equal(labelMinutesIst(label) % 15, 0, 'not a 15-minute boundary: ' + label);
  assert.match(label, /6:15 pm/, 'expected 6:15 pm next: ' + label);
  assert.match(label, /19 Nov 2026/, 'expected same-day label: ' + label);

  // Exactly on a boundary (18:15 IST) -> the following one, 18:30.
  label = nextDigestLabel(Date.parse('2026-11-19T12:45:00Z'), 9);
  assert.match(label, /6:30 pm/, 'exact boundary must roll to the next one: ' + label);

  // 18:52:00Z = 00:22 IST next day -> 00:30, rolling the date forward.
  label = nextDigestLabel(Date.parse('2026-11-19T18:52:00Z'), 9);
  assert.equal(labelMinutesIst(label), 30, 'expected 00:30: ' + label);
  assert.match(label, /20 Nov 2026/, 'expected next-day label: ' + label);

  // The old digest hour is ignored: same input, different hour, same label.
  assert.equal(
    nextDigestLabel(Date.parse('2026-11-19T12:37:00Z'), 9),
    nextDigestLabel(Date.parse('2026-11-19T12:37:00Z'), 21),
    'digestHourIst must not move the next 15-minute boundary'
  );
});

// ---------- Worker 3: /stores, /setdiscount, /deals, /top, /watch ----------

const NO_DEALS_LINE = noDealsLine();

const STUB_DEALS = {
  'Amazon Now': [
    { title: 'Headphones Pro', price: 999, mrp: 2999, disc: 67, url: 'https://example.com/hp', cat: '' },
    { title: 'Cheap Cable', price: 199, mrp: 499, disc: 60, url: 'https://example.com/cable', cat: '' },
  ],
  Zepto: [
    { title: 'Mixer Grinder', price: 1500, mrp: 5000, disc: 70, url: 'https://example.com/mixer', cat: '' },
  ],
  Blinkit: [
    { title: 'Low Discount Snack', price: 90, mrp: 100, disc: 10, url: 'https://example.com/snack', cat: '' },
  ],
};

function userMessages(telegram, userId) {
  return telegram.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === userId);
}

function lastUserMessage(telegram, userId) {
  return userMessages(telegram, userId).at(-1);
}

function keyboardButtons(call) {
  return (call.reply_markup?.inline_keyboard || []).flat();
}

test('/stores shows 9 toggle buttons (2 per row), all ✅ by default', async () => {
  const { bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/stores'));
  const reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply, 'expected a /stores reply');
  for (const storeName of STORE_ORDER) {
    assert.ok(reply.text.includes(`✅ ${storeLabel(storeName)}`), `/stores must show ✅ ${storeLabel(storeName)}: ` + reply.text);
  }
  assert.match(reply.text, /Tap a store to turn it on\/off/);
  assert.equal(reply.parse_mode, 'HTML', '/stores reply carries HTML (header) so it needs parse_mode');
  assert.ok(reply.text.includes('PriceDrop Hunter · /start · /stores · /stop'), '/stores must end with the footer');
  const buttons = keyboardButtons(reply);
  assert.equal(buttons.length, 9, 'one toggle button per store');
  for (let i = 0; i < 9; i++) {
    assert.equal(buttons[i].callback_data, `store:toggle:${i}`, 'callback data must be store:toggle:<index>');
    assert.equal(buttons[i].text, `✅ ${storeLabel(STORE_ORDER[i])}`);
  }
  const rows = reply.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r.length), [2, 2, 2, 2, 1], 'two toggle buttons per row');
});

test('store toggle flips prefs AND edits the message; toggling back restores it', async () => {
  const { store, bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/stores'));
  telegram.calls.length = 0;

  // Toggle Amazon Now (index 0) off.
  await bot.handleUpdate(callbackUpdate(USER_ID, 'store:toggle:0'));
  assert.ok(
    telegram.calls.some((c) => c.method === 'answerCallbackQuery'),
    'toggle must answer the callback query'
  );
  const edit = telegram.calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit, 'toggle must EDIT the message (not send a new one)');
  assert.equal(edit.parse_mode, 'HTML', 'store toggle edit carries HTML (header) so it needs parse_mode');
  assert.ok(edit.text.includes(`❌ ${storeLabel('Amazon Now')}`), 'edited text must show Amazon Now off: ' + edit.text);
  assert.ok(edit.text.includes(`✅ ${storeLabel('Blinkit')}`), 'edited text must keep other stores on: ' + edit.text);
  const editButtons = keyboardButtons(edit);
  assert.equal(editButtons.find((b) => b.callback_data === 'store:toggle:0').text, `❌ ${storeLabel('Amazon Now')}`);
  assert.equal(editButtons.find((b) => b.callback_data === 'store:toggle:1').text, `✅ ${storeLabel('Blinkit')}`);
  assert.deepEqual(
    (await store.getUserPrefs(USER_ID)).stores,
    STORE_ORDER.filter((s) => s !== 'Amazon Now'),
    'prefs must drop the toggled store'
  );

  // Toggle it back on.
  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'store:toggle:0'));
  const edit2 = telegram.calls.find((c) => c.method === 'editMessageText');
  assert.ok(edit2, 'second toggle must edit again');
  assert.ok(edit2.text.includes(`✅ ${storeLabel('Amazon Now')}`), 'edited text must show Amazon Now on again: ' + edit2.text);
  assert.deepEqual((await store.getUserPrefs(USER_ID)).stores, STORE_ORDER, 'prefs must be back to all 9');
});

test('/setdiscount valid (30) confirms + updates prefs; invalid leaves prefs unchanged', async () => {
  const { store, bot, telegram } = await setup();

  for (const bad of ['/setdiscount abc', '/setdiscount 5', '/setdiscount 95', '/setdiscount']) {
    await bot.handleUpdate(messageUpdate(USER_ID, bad));
    const reply = lastUserMessage(telegram, USER_ID);
    assert.match(reply.text, /Usage: \/setdiscount <10-90>/, `${bad} must show the usage hint: ` + reply.text);
    assert.match(reply.text, /Your current threshold is 50%/, 'usage hint must show the current threshold');
    assert.equal((await store.getUserPrefs(USER_ID)).min_discount, 50, `${bad} must not change prefs`);
  }

  await bot.handleUpdate(messageUpdate(USER_ID, '/setdiscount 30'));
  let reply = lastUserMessage(telegram, USER_ID);
  assert.match(reply.text, /✅ Minimum discount set to 30%/);
  assert.match(reply.text, /only include deals at 30% off or more/);
  assert.equal((await store.getUserPrefs(USER_ID)).min_discount, 30);

  // Out of range after a valid set: usage hint shows the new threshold, prefs untouched.
  await bot.handleUpdate(messageUpdate(USER_ID, '/setdiscount 95'));
  reply = lastUserMessage(telegram, USER_ID);
  assert.match(reply.text, /Usage: \/setdiscount <10-90>/);
  assert.match(reply.text, /Your current threshold is 30%/);
  assert.equal((await store.getUserPrefs(USER_ID)).min_discount, 30);
});

test('/status shows threshold, store count and watchlist count (command + status button)', async () => {
  const { store, bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  let reply = lastUserMessage(telegram, USER_ID);
  assert.match(reply.text, /Min\. discount:<\/b> 50%/);
  assert.match(reply.text, /Stores:<\/b> 9 of 9 enabled/);
  assert.match(reply.text, /Watchlist:<\/b> 0 keyword\(s\)/);
  assert.match(reply.text, /<b>🛒 PriceDrop Hunter — Your subscription<\/b>/, 'status must use the design header');
  assert.ok(reply.text.includes('PriceDrop Hunter · /start · /stores · /stop'), 'status must end with the footer');
  assert.equal(reply.parse_mode, 'HTML', 'status carries HTML so it needs parse_mode');

  // Change all three, then /status again.
  await store.setUserMinDiscount(USER_ID, 30);
  await store.setUserStores(USER_ID, STORE_ORDER.filter((s) => s !== 'Zepto'));
  await store.addWatch(USER_ID, 'shoes');
  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  reply = lastUserMessage(telegram, USER_ID);
  assert.match(reply.text, /Min\. discount:<\/b> 30%/);
  assert.match(reply.text, /Stores:<\/b> 8 of 9 enabled/);
  assert.match(reply.text, /Watchlist:<\/b> 1 keyword\(s\)/);
  assert.match(reply.text, /Fresh deals every 15 minutes · 30%\+ off/);

  // The 'status' inline button shows the same three lines.
  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'status'));
  reply = lastUserMessage(telegram, USER_ID);
  assert.match(reply.text, /Min\. discount:<\/b> 30%/);
  assert.match(reply.text, /Stores:<\/b> 8 of 9 enabled/);
  assert.match(reply.text, /Watchlist:<\/b> 1 keyword\(s\)/);
});

test('/deals returns matching deals for an unsubscribed user, honours prefs, writes no dedupe state', async () => {
  const { store, bot, telegram } = await setup(async () => STUB_DEALS);
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));

  const replies = userMessages(telegram, USER_ID);
  assert.equal(replies.length, 1, 'fixture deals must fit in one digest message');
  assert.equal(replies[0].parse_mode, 'HTML');
  assert.equal(replies[0].disable_web_page_preview, true, '/deals must suppress link previews');
  const joined = replies.map((r) => r.text).join('\n');
  assert.ok(joined.includes('Headphones Pro'), 'matching Amazon deal must be shown');
  assert.ok(joined.includes('Cheap Cable'), 'second matching Amazon deal must be shown');
  assert.ok(joined.includes('Mixer Grinder'), 'matching Zepto deal must be shown');
  assert.ok(!joined.includes('Low Discount Snack'), 'below-threshold deal must be filtered out');
  // No active-subscription gate: /deals works before subscribing.
  assert.equal((await store.getSubscriber(USER_ID)).status, 'expired');
  // No dedupe writes: nothing recorded as posted.
  assert.equal((await store.getRecentPostedKeys(0)).size, 0, '/deals must not mark deals posted');

  // Disable Zepto in prefs: its deal disappears, Amazon deals stay.
  await store.setUserStores(USER_ID, STORE_ORDER.filter((s) => s !== 'Zepto'));
  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  const joined2 = userMessages(telegram, USER_ID).map((r) => r.text).join('\n');
  assert.ok(!joined2.includes('Mixer Grinder'), 'disabled-store deal must be filtered out');
  assert.ok(joined2.includes('Headphones Pro'), 'enabled-store deal must still be shown');
  assert.equal((await store.getRecentPostedKeys(0)).size, 0, 'second /deals must still write no dedupe state');
});

test('/deals with empty feeds replies the polite one-liner exactly once, no dedupe state', async () => {
  const { store, bot, telegram } = await setup(async () => ({}));
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  const replies = userMessages(telegram, USER_ID);
  assert.equal(replies.length, 1, 'empty feeds must produce exactly one reply');
  assert.equal(replies[0].text, NO_DEALS_LINE);
  assert.equal((await store.getRecentPostedKeys(0)).size, 0);
});

test('/top returns the single best deal (highest disc) and writes no dedupe state', async () => {
  const { store, bot, telegram } = await setup(async () => STUB_DEALS);
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  const replies = userMessages(telegram, USER_ID);
  assert.equal(replies.length, 1, '/top must send exactly one message');
  assert.equal(replies[0].parse_mode, 'HTML');
  assert.equal(replies[0].disable_web_page_preview, true, '/top must suppress link previews');
  assert.ok(
    replies[0].text.includes('<b>🛒 PriceDrop Hunter — Top deal</b>'),
    '/top must use the design header (no 🏆): ' + replies[0].text
  );
  assert.ok(replies[0].text.includes('PriceDrop Hunter · /start · /stores · /stop'), '/top must end with the footer');
  assert.ok(replies[0].text.includes('<b>₹1,500</b>'), '/top deal price must be bold: ' + replies[0].text);
  assert.ok(replies[0].text.includes('🚀 Zepto'), '/top deal must carry the store label: ' + replies[0].text);
  assert.ok(replies[0].text.includes('Mixer Grinder'), 'best deal is the 70% Zepto one');
  assert.ok(replies[0].text.includes('🎯 70% OFF'));
  assert.ok(replies[0].text.includes('💸 save ₹3,500'), '/top card must show the rupee saving');
  assert.ok(replies[0].reply_markup, '/top must attach its Grab Deal button');
  assert.ok(
    JSON.stringify(replies[0].reply_markup).includes('https://example.com/mixer'),
    '/top Grab Deal button must link the deal URL'
  );
  assert.ok(!replies[0].text.includes('Headphones Pro'), 'only the single best deal, not the rest');
  assert.equal((await store.getRecentPostedKeys(0)).size, 0, '/top must not mark deals posted');
});

test('/top tie-breaks equal discounts by biggest saving; empty feeds get the one-liner', async () => {
  const tied = {
    'Amazon Now': [
      { title: 'Big Saver', price: 100, mrp: 5100, disc: 70, url: 'https://example.com/big', cat: '' },
    ],
    Zepto: [
      { title: 'Small Saver', price: 900, mrp: 1000, disc: 70, url: 'https://example.com/small', cat: '' },
    ],
  };
  const { bot, telegram } = await setup(async () => tied);
  await bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  let reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply.text.includes('Big Saver'), 'equal disc must pick the bigger saving (₹5000 vs ₹100)');
  assert.ok(!reply.text.includes('Small Saver'));

  const empty = await setup(async () => ({}));
  await empty.bot.handleUpdate(messageUpdate(USER_ID, '/top'));
  const replies = userMessages(empty.telegram, USER_ID);
  assert.equal(replies.length, 1, 'empty /top must produce exactly one reply');
  assert.equal(replies[0].text, NO_DEALS_LINE);
});

test('/hot returns the biggest rupee saving (not the steepest discount); empty feeds get the one-liner', async () => {
  const deals = {
    'Amazon Now': [
      { title: 'Steep But Cheap', price: 100, mrp: 1000, disc: 90, url: 'https://example.com/steep', cat: '' },
    ],
    Zepto: [
      { title: 'Big Ticket Saver', price: 1500, mrp: 5000, disc: 70, url: 'https://example.com/mixer', cat: '' },
    ],
  };
  const { store, bot, telegram } = await setup(async () => deals);
  await bot.handleUpdate(messageUpdate(USER_ID, '/hot'));
  const replies = userMessages(telegram, USER_ID);
  assert.equal(replies.length, 1, '/hot must send exactly one message');
  assert.ok(replies[0].text.includes('<b>🛒 PriceDrop Hunter — Hottest deal 🔥</b>'), 'hot must use the design header: ' + replies[0].text);
  assert.ok(replies[0].text.includes('Big Ticket Saver'), '/hot must pick the ₹3,500 saving over the 90% ₹900 saving');
  assert.ok(!replies[0].text.includes('Steep But Cheap'), '/hot must not pick the steepest discount');
  assert.ok(replies[0].text.includes('💸 save ₹3,500'));
  assert.ok(replies[0].text.includes('PriceDrop Hunter · /start · /stores · /stop'), '/hot must end with the footer');
  assert.ok(replies[0].reply_markup, '/hot must attach its Grab Deal button');
  assert.equal((await store.getRecentPostedKeys(0)).size, 0, '/hot must not mark deals posted');

  const empty = await setup(async () => ({}));
  await empty.bot.handleUpdate(messageUpdate(USER_ID, '/hot'));
  const emptyReplies = userMessages(empty.telegram, USER_ID);
  assert.equal(emptyReplies.length, 1, 'empty /hot must produce exactly one reply');
  assert.equal(emptyReplies[0].text, NO_DEALS_LINE);
});

test('/start keyboard has a Hottest deal button; the hot callback behaves like /hot', async () => {
  const { bot, telegram } = await setup(async () => STUB_DEALS);
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  const startReply = lastUserMessage(telegram, USER_ID);
  const startButtons = JSON.parse(JSON.stringify(startReply.reply_markup.inline_keyboard)).flat();
  assert.ok(startButtons.some((b) => b.callback_data === 'hot'), 'start keyboard must offer the hot button: ' + JSON.stringify(startButtons));

  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'hot'));
  const reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply.text.includes('Mixer Grinder'), 'hot callback must reply with the biggest saving (Mixer ₹3,500 vs Headphones ₹2,000): ' + reply.text);
  assert.ok(reply.text.includes('💸 save ₹'));
});

test('/search finds by keyword, caps at 5, usage without keyword, no-results suggests /watch', async () => {
  const deals = {
    'Amazon Now': [
      { title: 'Headphones Pro X', price: 999, mrp: 2999, disc: 66, url: 'https://example.com/hp', cat: 'Electronics' },
      { title: 'Headphones Lite', price: 499, mrp: 999, disc: 50, url: 'https://example.com/hl', cat: 'Electronics' },
    ],
    Zepto: [
      { title: 'Mixer Grinder', price: 1500, mrp: 5000, disc: 70, url: 'https://example.com/mixer', cat: 'Kitchen' },
    ],
  };
  const { store, bot, telegram } = await setup(async () => deals);

  await bot.handleUpdate(messageUpdate(USER_ID, '/search'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /Usage: \/search <keyword>/);

  await bot.handleUpdate(messageUpdate(USER_ID, '/search HEADPHONES'));
  let reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply.text.includes('Headphones Pro X') && reply.text.includes('Headphones Lite'), 'case-insensitive search must match both: ' + reply.text);
  assert.ok(!reply.text.includes('Mixer Grinder'), 'search must not show non-matching deals');
  assert.ok(reply.text.includes('🎯 66% OFF'), 'search results must carry the discount badge');
  assert.ok(reply.text.includes('💸 save ₹2,000'), 'search results must show the rupee saving');
  assert.ok(reply.reply_markup, 'search must attach Grab Deal buttons');
  assert.equal((await store.getRecentPostedKeys(0)).size, 0, '/search must not mark deals posted');

  await bot.handleUpdate(messageUpdate(USER_ID, '/search fridge'));
  reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply.text.includes('No deals found'), 'no-results reply: ' + reply.text);
  assert.ok(reply.text.includes('/watch fridge'), 'no-results reply must suggest watching the keyword');
});

test('/deals attaches store-filter buttons; tapping one re-runs /deals for that store only', async () => {
  const { bot, telegram } = await setup(async () => STUB_DEALS);
  await bot.handleUpdate(messageUpdate(USER_ID, '/deals'));
  const dealsReply = lastUserMessage(telegram, USER_ID);
  assert.ok(dealsReply.reply_markup, '/deals must attach a keyboard (Grab Deal + store filters)');
  const buttons = JSON.parse(JSON.stringify(dealsReply.reply_markup.inline_keyboard)).flat();
  assert.ok(buttons.some((b) => b.callback_data === 'deals:filter:all'), 'All stores button missing: ' + JSON.stringify(buttons));
  assert.ok(buttons.some((b) => b.callback_data === 'deals:filter:0'), 'Amazon Now filter button missing');
  assert.ok(buttons.some((b) => b.callback_data === 'deals:filter:6'), 'Zepto filter button missing');
  assert.ok(buttons.some((b) => b.text === '🛒 Grab Deal' && b.url === 'https://example.com/hp'), 'Grab Deal button missing from /deals');

  // Filter to Amazon Now (index 0): only its deals, no Zepto mixer.
  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'deals:filter:0'));
  let reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply.text.includes('Headphones Pro'), 'filtered reply must show the Amazon deal: ' + reply.text);
  assert.ok(!reply.text.includes('Mixer Grinder'), 'filtered reply must not show other stores');

  // Filter to Croma (index 5, no deals in the stub): the one-liner.
  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'deals:filter:5'));
  reply = lastUserMessage(telegram, USER_ID);
  assert.equal(reply.text, NO_DEALS_LINE);

  // All stores again: both stores back.
  telegram.calls.length = 0;
  await bot.handleUpdate(callbackUpdate(USER_ID, 'deals:filter:all'));
  reply = lastUserMessage(telegram, USER_ID);
  assert.ok(reply.text.includes('Headphones Pro') && reply.text.includes('Mixer Grinder'), 'All stores must restore every deal');
});

test('/watch add/duplicate/limit/too-long/empty; /unwatch present + absent; /watchlist empty + populated', async () => {
  const { store, bot, telegram } = await setup();

  await bot.handleUpdate(messageUpdate(USER_ID, '/watchlist'));
  assert.equal(
    lastUserMessage(telegram, USER_ID).text,
    'Your watchlist is empty. Use /watch <keyword> to add one.'
  );

  await bot.handleUpdate(messageUpdate(USER_ID, '/watch'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /Usage: \/watch <keyword>/);

  await bot.handleUpdate(messageUpdate(USER_ID, '/watch ' + 'x'.repeat(41)));
  assert.match(lastUserMessage(telegram, USER_ID).text, /too long/i);
  assert.deepEqual(await store.listWatch(USER_ID), [], 'too-long keyword must not be stored');

  await bot.handleUpdate(messageUpdate(USER_ID, '/watch Headphones'));
  assert.match(
    lastUserMessage(telegram, USER_ID).text,
    /🔔 Watching "Headphones" — I'll alert you when a matching deal appears\./
  );
  assert.deepEqual(await store.listWatch(USER_ID), ['headphones'], 'keyword is stored lowercased');

  await bot.handleUpdate(messageUpdate(USER_ID, '/watch HEADPHONES'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /You're already watching "HEADPHONES"/);

  for (let i = 1; i <= 9; i++) {
    await bot.handleUpdate(messageUpdate(USER_ID, `/watch kw${i}`));
    assert.match(lastUserMessage(telegram, USER_ID).text, new RegExp(`Watching "kw${i}"`));
  }
  assert.equal((await store.listWatch(USER_ID)).length, 10, 'watchlist must hold 10 keywords');

  await bot.handleUpdate(messageUpdate(USER_ID, '/watch eleventh'));
  assert.match(
    lastUserMessage(telegram, USER_ID).text,
    /You already have 10 keywords — remove one with \/unwatch <keyword> first\./
  );
  assert.equal((await store.listWatch(USER_ID)).length, 10, 'limit must not store an 11th keyword');

  await bot.handleUpdate(messageUpdate(USER_ID, '/watchlist'));
  const listReply = lastUserMessage(telegram, USER_ID).text;
  for (const kw of ['headphones', 'kw1', 'kw9']) {
    assert.ok(listReply.includes(`• ${kw}`), `watchlist must list ${kw}: ` + listReply);
  }
  assert.ok(listReply.startsWith('🔔 Your watchlist:'), 'watchlist must keep its 🔔 lead line: ' + listReply);
  assert.ok(listReply.includes('PriceDrop Hunter · /start · /stores · /stop'), 'populated watchlist is multi-line so it gets the footer');

  await bot.handleUpdate(messageUpdate(USER_ID, '/unwatch KW1'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /Stopped watching "KW1"\./);
  assert.equal((await store.listWatch(USER_ID)).length, 9);

  await bot.handleUpdate(messageUpdate(USER_ID, '/unwatch kw1'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /"kw1" wasn't in your watchlist\./);

  await bot.handleUpdate(messageUpdate(USER_ID, '/unwatch'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /Usage: \/unwatch <keyword>/);

  // Freeing a slot lets a new keyword in again.
  await bot.handleUpdate(messageUpdate(USER_ID, '/watch newkw'));
  assert.match(lastUserMessage(telegram, USER_ID).text, /Watching "newkw"/);
  assert.equal((await store.listWatch(USER_ID)).length, 10);
});

test('/start and /help both list all 9 stores and all new commands', async () => {
  const newCommands = ['/stores', '/setdiscount', '/deals', '/hot', '/search', '/top', '/watch', '/unwatch', '/watchlist'];
  const { bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  let reply = telegram.calls.find((c) => c.method === 'sendMessage');
  assert.ok(reply, 'expected a /start reply');
  for (const storeName of STORE_ORDER) {
    assert.ok(reply.text.includes(storeName), `/start must list ${storeName}`);
  }
  for (const cmd of newCommands) {
    assert.ok(reply.text.includes(cmd), `/start must list ${cmd}: ` + reply.text);
  }

  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/help'));
  reply = telegram.calls.at(-1);
  assert.ok(reply, 'expected a /help reply');
  for (const storeName of STORE_ORDER) {
    assert.ok(reply.text.includes(storeName), `/help must list ${storeName}`);
  }
  for (const cmd of newCommands) {
    assert.ok(reply.text.includes(cmd), `/help must list ${cmd}: ` + reply.text);
  }
});

// ---------- Worker 2 (design-system pass): design.js + new bot formats ----------

const FORBIDDEN_EMOJI = ['👋', '🆓', '📋', '🏬', '💎', '🏆', '📊'];
const FOOTER_TAIL = 'PriceDrop Hunter · /start · /stores · /stop';

test('design.js: header/footer/cadence/storeLabel/escape/inr follow the pin exactly', () => {
  assert.equal(header('Welcome'), '<b>🛒 PriceDrop Hunter — Welcome</b>');
  assert.equal(
    header('Fresh Deals', 'Thu, 19 Nov 2026'),
    '<b>🛒 PriceDrop Hunter — Fresh Deals</b>\n📅 Thu, 19 Nov 2026'
  );
  assert.equal(footer(), '\n—\n' + FOOTER_TAIL);
  assert.equal(
    cadenceLine(50),
    '⚡ Fresh deals every 15 minutes · 50%+ off · duplicates removed'
  );
  assert.equal(storeLabel('Amazon Now'), '🛒 Amazon Now');
  assert.equal(storeLabel('Zepto'), '🚀 Zepto');
  assert.equal(storeLabel('Unknown Store'), 'Unknown Store', 'unknown store: no emoji, plain escaped name');
  assert.equal(storeLabel('A <b> & "x"'), 'A &lt;b&gt; &amp; &quot;x&quot;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('<b>&"x"'), '&lt;b&gt;&amp;&quot;x&quot;');
  assert.equal(noDealsLine(), NO_DEALS_LINE);
});

test('design.js: dealLine renders bold price + store label, no link when url is empty, truncates long titles', () => {
  const deal = { title: 'Headphones Pro', price: 999, mrp: 2999, disc: 67, url: 'https://example.com/hp' };
  assert.equal(
    dealLine(deal, 'Amazon Now'),
    '• <a href="https://example.com/hp">Headphones Pro</a> — <b>₹999</b> <s>₹2,999</s> (67% off) — 🛒 Amazon Now'
  );
  const noUrl = dealLine({ ...deal, url: '' }, 'Zepto');
  assert.ok(!noUrl.includes('<a'), 'empty url must produce no link tags: ' + noUrl);
  assert.ok(noUrl.includes('🚀 Zepto'), 'store label must still be present: ' + noUrl);
  const long = dealLine({ ...deal, title: 'x'.repeat(200) }, 'Amazon Now', 120);
  assert.ok(long.length <= 120, 'truncated line must fit maxLen: ' + long.length);
  assert.ok(long.includes('…'), 'truncated title must end with an ellipsis');
  assert.ok(long.includes('<b>₹999</b>'), 'truncation must keep the price part intact');
  const alert = require('../src/design').watchAlert('headphones', deal, 'Amazon Now');
  assert.ok(alert.startsWith('🔔 <b>Watch alert: "headphones"</b>\n'), 'watch alert lead line: ' + alert);
  assert.ok(alert.includes(dealCard(deal, 'Amazon Now')), 'watch alert must embed the deal card');
  assert.ok(alert.endsWith(footer()), 'watch alert must end with the footer');
});

test('design formats: welcome/help/status/subscribe/stores use header + footer + parse_mode HTML', async () => {
  const { store, bot, telegram } = await setup();
  await bot.handleUpdate(messageUpdate(USER_ID, '/start'));
  let reply = telegram.calls.find((c) => c.method === 'sendMessage');
  assert.ok(reply.text.startsWith('<b>🛒 PriceDrop Hunter — Welcome</b>'), 'welcome header: ' + reply.text);
  assert.ok(reply.text.includes('Free subscription — no payment needed.'), 'welcome free line, no 🆓');
  assert.ok(reply.text.includes(cadenceLine(50)), 'welcome cadence line');
  assert.ok(reply.text.endsWith(footer()), 'welcome footer');
  assert.equal(reply.parse_mode, 'HTML', 'welcome carries HTML so it needs parse_mode');
  for (const s of STORE_ORDER) {
    assert.ok(reply.text.includes(`• ${storeLabel(s)}`), `welcome store list must use storeLabel for ${s}`);
  }

  await bot.handleUpdate(messageUpdate(USER_ID, '/help'));
  reply = telegram.calls.at(-1);
  assert.ok(reply.text.startsWith('<b>🛒 PriceDrop Hunter — Help</b>'), 'help header: ' + reply.text);
  assert.ok(reply.text.endsWith(footer()), 'help footer');
  assert.equal(reply.parse_mode, 'HTML');

  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  reply = telegram.calls.at(-1);
  assert.ok(reply.text.startsWith('<b>🛒 PriceDrop Hunter — Your subscription</b>'), 'status header');
  assert.ok(reply.text.includes('<b>Status:</b> not subscribed'), 'status bold label');
  assert.ok(reply.text.includes('Tap /start and hit Subscribe to join — it\'s free.'), 'not-subscribed trailing line kept');
  assert.ok(reply.text.endsWith(footer()), 'status footer');
  assert.equal(reply.parse_mode, 'HTML');

  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  // The welcome also carries a 🎉 now, so target the confirmation by its
  // header text, not by the first 🎉 message.
  reply = telegram.calls.find((c) => c.method === 'sendMessage' && (c.text || '').includes('Subscribed'));
  assert.ok(reply, 'expected a subscribe confirmation');
  assert.ok(reply.text.includes('🎉 <b>🛒 PriceDrop Hunter — Subscribed</b>'), 'subscribe confirmation: 🎉 + header');
  assert.ok(reply.text.includes('<b>Next digest:</b>'), 'subscribe confirmation: next digest');
  assert.ok(reply.text.endsWith(footer()), 'subscribe confirmation footer');
  assert.equal(reply.parse_mode, 'HTML');
  assert.ok(!/Happy deal hunting/.test(reply.text), 'trailing 🛒 decoration is gone');

  // /stop keeps its resubscribe line AND gets the footer.
  await bot.handleUpdate(messageUpdate(USER_ID, '/stop'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /Tap \/start to subscribe again \(free\)\./, 'stop resubscribe line kept');
  assert.ok(reply.text.endsWith(footer()), 'stopped reply gets the footer');
  assert.equal((await store.getSubscriber(USER_ID)).status, 'expired');

  // One-line replies get NO footer: /myid, usage hints, photo replies.
  await bot.handleUpdate(messageUpdate(USER_ID, '/myid'));
  assert.ok(!telegram.calls.at(-1).text.includes(FOOTER_TAIL), '/myid is one line: no footer');
  await bot.handleUpdate(messageUpdate(USER_ID, '/setdiscount'));
  assert.ok(telegram.calls.at(-1).text.startsWith('Usage: /setdiscount <10-90>'), 'usage hint keeps the single-line Usage shape');
  assert.ok(!telegram.calls.at(-1).text.includes(FOOTER_TAIL), 'usage hint is one line: no footer');
  await bot.handleUpdate(photoUpdate(USER_ID));
  reply = telegram.calls.filter((c) => c.method === 'sendMessage' && c.chat_id === USER_ID).at(-1);
  assert.ok(!reply.text.includes(FOOTER_TAIL), 'photo reply is one line: no footer');

  // No forbidden emoji in any bot-owned message sent during this run.
  // (The /deals digest is excluded here: it still comes from the old
  // digest.js, which W1 owns — its 💎 header is not bot.js output.)
  for (const call of telegram.calls) {
    if (typeof call.text !== 'string') continue;
    for (const emoji of FORBIDDEN_EMOJI) {
      assert.ok(!call.text.includes(emoji), `forbidden emoji ${emoji} in bot message: ` + call.text);
    }
  }
});

test('design formats: /subscribers admin list uses header + footer + parse_mode HTML', async () => {
  const { store, bot, telegram } = await setup();
  await store.upsertSubscriber({ user_id: USER_ID, name: 'Test', username: 'testuser' });
  await store.setStatus(USER_ID, 'active');
  await bot.handleUpdate(messageUpdate(ADMIN_ID, '/subscribers'));
  const reply = telegram.calls.at(-1);
  assert.ok(reply.text.startsWith('<b>🛒 PriceDrop Hunter — Subscribers</b>'), 'subscribers header: ' + reply.text);
  assert.match(reply.text, /1 total/, 'subscribers total line');
  assert.ok(reply.text.endsWith(footer()), 'subscribers footer');
  assert.equal(reply.parse_mode, 'HTML');
});
