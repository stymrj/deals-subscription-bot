// tests/db.test.js — user_prefs + watchlist (src/db.js).
// node:test + node:assert/strict, real initDb(':memory:') — each test gets
// a fresh isolated in-memory store (cache=private, see src/db.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { STORE_ORDER } = require('../src/feed');

async function freshStore() {
  return initDb(':memory:');
}

// --- user_prefs -------------------------------------------------------------

test('getUserPrefs: fresh user gets defaults (all 9 stores in STORE_ORDER, min_discount 50)', async () => {
  const store = await freshStore();
  try {
    const prefs = await store.getUserPrefs(111);
    assert.deepEqual(prefs, {
      user_id: 111,
      stores: [...STORE_ORDER],
      min_discount: 50,
    });
    assert.equal(prefs.stores.length, 9);
  } finally {
    await store.close();
  }
});

test('getUserPrefs: reading defaults does not create a row (a later write still defaults min_discount)', async () => {
  const store = await freshStore();
  try {
    await store.getUserPrefs(222); // read-only; must not insert
    // First write is stores-only: min_discount must still default to 50.
    const prefs = await store.setUserStores(222, ['Zepto']);
    assert.deepEqual(prefs, { user_id: 222, stores: ['Zepto'], min_discount: 50 });
  } finally {
    await store.close();
  }
});

test('setUserStores: persists, reorders to STORE_ORDER, drops unknown names, dedupes', async () => {
  const store = await freshStore();
  try {
    const prefs = await store.setUserStores(333, [
      'Zepto', 'Amazon Now', 'NotAStore', 'Zepto', 'Blinkit', '  JioMart  ',
    ]);
    // '  JioMart  ' is not an exact STORE_ORDER name, so it is dropped too.
    assert.deepEqual(prefs.stores, ['Amazon Now', 'Blinkit', 'Zepto']);
    assert.equal(prefs.min_discount, 50);
    // Round-trip through a fresh read.
    const again = await store.getUserPrefs(333);
    assert.deepEqual(again, prefs);
  } finally {
    await store.close();
  }
});

test('setUserStores: empty array is allowed (no stores enabled)', async () => {
  const store = await freshStore();
  try {
    const prefs = await store.setUserStores(444, []);
    assert.deepEqual(prefs, { user_id: 444, stores: [], min_discount: 50 });
    const again = await store.getUserPrefs(444);
    assert.deepEqual(again.stores, []);
  } finally {
    await store.close();
  }
});

test('setUserMinDiscount: persists and preserves existing stores', async () => {
  const store = await freshStore();
  try {
    await store.setUserStores(555, ['Myntra', 'Croma']);
    const prefs = await store.setUserMinDiscount(555, 80);
    assert.deepEqual(prefs, { user_id: 555, stores: ['Myntra', 'Croma'], min_discount: 80 });
    const again = await store.getUserPrefs(555);
    assert.deepEqual(again, prefs);
  } finally {
    await store.close();
  }
});

test('setUserMinDiscount: fresh user defaults stores to all 9', async () => {
  const store = await freshStore();
  try {
    const prefs = await store.setUserMinDiscount(666, 30);
    assert.deepEqual(prefs, {
      user_id: 666,
      stores: [...STORE_ORDER],
      min_discount: 30,
    });
  } finally {
    await store.close();
  }
});

test('setUserStores: preserves an existing min_discount', async () => {
  const store = await freshStore();
  try {
    await store.setUserMinDiscount(777, 70);
    const prefs = await store.setUserStores(777, ['JioMart']);
    assert.deepEqual(prefs, { user_id: 777, stores: ['JioMart'], min_discount: 70 });
  } finally {
    await store.close();
  }
});

test('user_prefs: users are independent', async () => {
  const store = await freshStore();
  try {
    await store.setUserStores(888, ['Zepto']);
    await store.setUserMinDiscount(999, 90);
    assert.deepEqual((await store.getUserPrefs(888)).stores, ['Zepto']);
    assert.equal((await store.getUserPrefs(888)).min_discount, 50);
    assert.deepEqual((await store.getUserPrefs(999)).stores, [...STORE_ORDER]);
    assert.equal((await store.getUserPrefs(999)).min_discount, 90);
  } finally {
    await store.close();
  }
});

// --- watchlist --------------------------------------------------------------

test('addWatch: normalises case and whitespace on insert', async () => {
  const store = await freshStore();
  try {
    const res = await store.addWatch(111, '  iPhone 15 ');
    assert.deepEqual(res, { added: true, count: 1 });
    assert.deepEqual(await store.listWatch(111), ['iphone 15']);
  } finally {
    await store.close();
  }
});

test('addWatch: duplicate (any case) returns exists with unchanged count', async () => {
  const store = await freshStore();
  try {
    await store.addWatch(111, 'AirPods');
    const res = await store.addWatch(111, '  AIRPODS ');
    assert.deepEqual(res, { added: false, reason: 'exists', count: 1 });
    assert.deepEqual(await store.listWatch(111), ['airpods']);
  } finally {
    await store.close();
  }
});

test('addWatch: empty keyword is a no-op returning exists', async () => {
  const store = await freshStore();
  try {
    await store.addWatch(111, 'mouse');
    const res = await store.addWatch(111, '   ');
    assert.deepEqual(res, { added: false, reason: 'exists', count: 1 });
    assert.deepEqual(await store.listWatch(111), ['mouse']);
  } finally {
    await store.close();
  }
});

test('addWatch: 11th keyword hits the limit (count stays 10)', async () => {
  const store = await freshStore();
  try {
    for (let i = 1; i <= 10; i++) {
      const res = await store.addWatch(111, `kw${i}`);
      assert.equal(res.added, true);
      assert.equal(res.count, i);
    }
    const res = await store.addWatch(111, 'kw11');
    assert.deepEqual(res, { added: false, reason: 'limit', count: 10 });
    assert.equal((await store.listWatch(111)).length, 10);
  } finally {
    await store.close();
  }
});

test('removeWatch: case-insensitive remove; absent keyword returns removed:false', async () => {
  const store = await freshStore();
  try {
    await store.addWatch(111, 'Keyboard');
    const removed = await store.removeWatch(111, '  KEYBOARD ');
    assert.deepEqual(removed, { removed: true });
    assert.deepEqual(await store.listWatch(111), []);
    const absent = await store.removeWatch(111, 'keyboard');
    assert.deepEqual(absent, { removed: false });
  } finally {
    await store.close();
  }
});

test('listWatch: keywords sorted alphabetically; empty user returns []', async () => {
  const store = await freshStore();
  try {
    await store.addWatch(111, 'zebra');
    await store.addWatch(111, 'apple');
    await store.addWatch(111, 'Mango');
    assert.deepEqual(await store.listWatch(111), ['apple', 'mango', 'zebra']);
    assert.deepEqual(await store.listWatch(999), []);
  } finally {
    await store.close();
  }
});

test('listAllWatches: every user\'s watches, user_id as a number', async () => {
  const store = await freshStore();
  try {
    await store.addWatch(111, 'laptop');
    await store.addWatch(111, 'phone');
    await store.addWatch(222, 'Shoes');
    const all = await store.listAllWatches();
    assert.deepEqual(all, [
      { user_id: 111, keyword: 'laptop' },
      { user_id: 111, keyword: 'phone' },
      { user_id: 222, keyword: 'shoes' },
    ]);
    for (const row of all) assert.equal(typeof row.user_id, 'number');
  } finally {
    await store.close();
  }
});

test('watchlist: removing frees a slot under the limit', async () => {
  const store = await freshStore();
  try {
    for (let i = 1; i <= 10; i++) await store.addWatch(111, `kw${i}`);
    await store.removeWatch(111, 'kw1');
    const res = await store.addWatch(111, 'kw11');
    assert.deepEqual(res, { added: true, count: 10 });
  } finally {
    await store.close();
  }
});
