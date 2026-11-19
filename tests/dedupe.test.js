// dedupe.test.js — dealKey rules and selectDeals parity with formatDigest.
// No network, no real token, no DB (pure functions only).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEDUPE_WINDOW_MS, dealKey, selectDeals, selectUserDeals } = require('../src/dedupe');
const { formatDigest } = require('../src/digest');

test('dedupe window is 7 days', () => {
  assert.equal(DEDUPE_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test('dealKey: URL present uses store + normalized URL', () => {
  const key = dealKey('Zepto', { title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: 'https://example.com/oil', cat: '' });
  assert.equal(key, 'Zepto|https://example.com/oil');
});

test('dealKey: no URL falls back to store + normalized title + sell price', () => {
  const key = dealKey('Zepto', { title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: '', cat: '' });
  assert.equal(key, 'Zepto|oil 1l|89');
  // Whitespace-only URL counts as no URL.
  const blank = dealKey('Zepto', { title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: '   ', cat: '' });
  assert.equal(blank, key);
  // Missing url field entirely also falls back.
  const missing = dealKey('Zepto', { title: 'Oil 1L', price: 89, mrp: 199, disc: 55 });
  assert.equal(missing, key);
});

test('dealKey: URL normalization — case, surrounding whitespace, trailing slashes', () => {
  const base = { title: 'Oil', price: 89, mrp: 199, disc: 55, cat: '' };
  const a = dealKey('Zepto', { ...base, url: 'https://Example.COM/Oil' });
  const b = dealKey('Zepto', { ...base, url: '  https://example.com/oil/  ' });
  const c = dealKey('Zepto', { ...base, url: 'https://example.com/oil///' });
  assert.equal(a, 'Zepto|https://example.com/oil');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('dealKey: title normalization — case and collapsed internal whitespace', () => {
  const a = dealKey('Zepto', { title: '  Oil   1L  Extra ', price: 89, mrp: 199, disc: 55, url: '' });
  const b = dealKey('Zepto', { title: 'oil 1l extra', price: 89, mrp: 199, disc: 55, url: '' });
  assert.equal(a, 'Zepto|oil 1l extra|89');
  assert.equal(b, a);
  // A different sell price is a different key under the fallback rule.
  const c = dealKey('Zepto', { title: 'oil 1l extra', price: 79, mrp: 199, disc: 60, url: '' });
  assert.notEqual(c, a);
});

test('dealKey: same URL in two stores = distinct keys', () => {
  const deal = { title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: 'https://example.com/oil' };
  assert.notEqual(dealKey('Zepto', deal), dealKey('Blinkit', deal));
  assert.equal(dealKey('Zepto', deal), 'Zepto|https://example.com/oil');
  assert.equal(dealKey('Blinkit', deal), 'Blinkit|https://example.com/oil');
});

test('dealKey: same deal re-keyed identically (deterministic)', () => {
  const deal = { title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: 'https://example.com/oil' };
  assert.equal(dealKey('Zepto', deal), dealKey('Zepto', { ...deal }));
  const noUrl = { title: 'Oil 1L', price: 89, mrp: 199, disc: 55, url: '' };
  assert.equal(dealKey('Zepto', noUrl), dealKey('Zepto', { ...noUrl }));
});

test('selectDeals mirrors formatDigest: min filter, disc-then-savings sort, top-5 cut', () => {
  const mk = (title, disc, price = 100, mrp = 200) => ({ title, price, mrp, disc, url: 'https://example.com/' + encodeURIComponent(title), cat: 'Test' });
  const deals = {
    'Amazon Now': [95, 90, 80, 70, 60, 55, 51].map(d => mk('Deal ' + d, d)),
    Blinkit: [mk('Good 60', 60), mk('Bad 49', 49), mk('Edge 50', 50)],
  };
  const picked = selectDeals(deals, { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5 });
  assert.deepEqual(picked['Amazon Now'].map(d => d.disc), [95, 90, 80, 70, 60]);
  assert.deepEqual(picked.Blinkit.map(d => d.title), ['Good 60', 'Edge 50']);
  // And the formatted digest shows exactly the same deals.
  const text = formatDigest(deals, { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5 }).map((m) => m.text).join('\n');
  for (const d of [95, 90, 80, 70, 60]) assert.ok(text.includes('Deal ' + d), 'missing ' + d);
  assert.ok(!text.includes('Deal 55') && !text.includes('Deal 51'), 'cut deal leaked into digest');
  assert.ok(!text.includes('Bad 49'), 'below-min deal leaked into digest');
});

test('selectDeals: sort ties on disc break by savings (mrp - price) desc', () => {
  const deals = {
    Zepto: [
      { title: 'Small saving', price: 90, mrp: 200, disc: 55, url: 'https://example.com/a', cat: '' },
      { title: 'Big saving', price: 40, mrp: 200, disc: 55, url: 'https://example.com/b', cat: '' },
    ],
  };
  const picked = selectDeals(deals, { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5 });
  assert.deepEqual(picked.Zepto.map(d => d.title), ['Big saving', 'Small saving']);
  const text = formatDigest(deals, { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5 }).map((m) => m.text).join('\n');
  assert.ok(text.indexOf('Big saving') < text.indexOf('Small saving'), 'digest order differs from selectDeals');
});

test('selectDeals: stores with nothing above min are omitted', () => {
  const picked = selectDeals(
    { Croma: [], Blinkit: [{ title: 'Low', price: 90, mrp: 100, disc: 10, url: '', cat: '' }] },
    { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5 }
  );
  assert.deepEqual(picked, {});
});

// --- selectUserDeals (per-user store filter + threshold) ---

const USER_DEALS = {
  Zepto: [
    { title: 'Zepto 90', price: 10, mrp: 100, disc: 90, url: 'https://example.com/z90', cat: '' },
    { title: 'Zepto 60', price: 40, mrp: 100, disc: 60, url: 'https://example.com/z60', cat: '' },
  ],
  Blinkit: [
    { title: 'Blinkit 85', price: 15, mrp: 100, disc: 85, url: 'https://example.com/b85', cat: '' },
  ],
  Croma: [
    { title: 'Croma 95', price: 5, mrp: 100, disc: 95, url: 'https://example.com/c95', cat: '' },
  ],
};

test('selectUserDeals: filters to the user\'s enabled stores only', () => {
  const picked = selectUserDeals(USER_DEALS, { stores: ['Zepto'], min_discount: 50 }, { topPerStore: 5 });
  assert.deepEqual(Object.keys(picked), ['Zepto']);
  assert.deepEqual(picked.Zepto.map(d => d.title), ['Zepto 90', 'Zepto 60']);
});

test('selectUserDeals: per-user threshold overrides the config min', () => {
  // Config min is 50, but this user wants 80+.
  const picked = selectUserDeals(
    USER_DEALS,
    { stores: ['Zepto', 'Blinkit', 'Croma'], min_discount: 80 },
    { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5 }
  );
  assert.deepEqual(picked.Zepto.map(d => d.title), ['Zepto 90']);
  assert.deepEqual(picked.Blinkit.map(d => d.title), ['Blinkit 85']);
  assert.deepEqual(picked.Croma.map(d => d.title), ['Croma 95']);
});

test('selectUserDeals: empty stores list returns {}', () => {
  assert.deepEqual(selectUserDeals(USER_DEALS, { stores: [], min_discount: 50 }, {}), {});
});

test('selectUserDeals: stores with nothing above the user threshold are omitted', () => {
  const picked = selectUserDeals(USER_DEALS, { stores: ['Zepto', 'Blinkit'], min_discount: 99 }, {});
  assert.deepEqual(picked, {});
});

test('selectUserDeals: top-N per store still comes from config', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({
    title: 'Deal ' + i, price: 10, mrp: 100, disc: 90 - i,
    url: 'https://example.com/d' + i, cat: '',
  }));
  const picked = selectUserDeals({ Zepto: many }, { stores: ['Zepto'], min_discount: 50 }, { topPerStore: 3 });
  assert.equal(picked.Zepto.length, 3);
  assert.deepEqual(picked.Zepto.map(d => d.disc), [90, 89, 88]);
});

test('selectUserDeals: unknown store names in prefs are ignored', () => {
  const picked = selectUserDeals(USER_DEALS, { stores: ['No Such Store', 'Zepto'], min_discount: 50 }, {});
  assert.deepEqual(Object.keys(picked), ['Zepto']);
});

test('selectUserDeals: missing prefs falls back to all stores + config min', () => {
  const picked = selectUserDeals(USER_DEALS, null, { MIN_DISCOUNT: 85, DIGEST_TOP_PER_STORE: 5 });
  assert.deepEqual(Object.keys(picked).sort(), ['Blinkit', 'Croma', 'Zepto']);
  assert.deepEqual(picked.Zepto.map(d => d.title), ['Zepto 90']);
});
