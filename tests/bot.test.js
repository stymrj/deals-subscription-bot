'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createBot, nextDigestLabel } = require('../src/bot');
const { STORE_ORDER } = require('../src/feed');

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

async function setup() {
  apiCalls.length = 0;
  const store = await initDb(':memory:');
  const { bot, sendToSubscribers, notifyAdmin } = createBot({ config: testConfig(), store });
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
  assert.ok(!/₹|49|expir|price/i.test(reply.text), 'status must not mention price/expiry: ' + reply.text);

  // Subscribe, then /status again.
  await bot.handleUpdate(callbackUpdate(USER_ID, 'subscribe'));
  telegram.calls.length = 0;
  await bot.handleUpdate(messageUpdate(USER_ID, '/status'));
  reply = telegram.calls.at(-1);
  assert.match(reply.text, /free subscriber/i);
  assert.match(reply.text, /next digest/i, 'status should show the next digest time');
  assert.ok(!/₹|49|expir|price/i.test(reply.text), 'status must not mention price/expiry: ' + reply.text);
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
  reply = telegram.find((c) => c.method === 'sendMessage' && c.chat_id === USER_ID);
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
  reply = telegram.calls.find((c) => c.method === 'sendMessage' && /subscribed/i.test(c.text || ''));
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
