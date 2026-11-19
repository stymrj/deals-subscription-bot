// feed.test.js — fetchDeals tolerates per-store failures; fixture loader.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchDeals, loadFixture, parseFeedUrls, defaultFeedUrls } = require('../src/feed');

function okFeed(deals) {
  return async () => ({ ok: true, status: 200, json: async () => ({ store: 'X', generatedAt: '2026-11-10T03:00:00Z', deals }) });
}

test('default feed URLs are the 9 raw.githubusercontent.com feed-branch URLs', () => {
  const urls = defaultFeedUrls();
  assert.equal(Object.keys(urls).length, 9);
  for (const [store, url] of Object.entries(urls)) {
    assert.ok(url.startsWith('https://raw.githubusercontent.com/stymrj/'), store + ': ' + url);
    assert.ok(url.endsWith('/feed/deals.json'), store + ': ' + url);
  }
  assert.ok(urls['Amazon Now'].includes('Amazon-Now-Deals'));
  assert.ok(urls.JioMart.includes('JioMart-Deals'));
});

test('parseFeedUrls parses comma-separated Store=url pairs', () => {
  const out = parseFeedUrls('Amazon Now=https://a.example/x.json,Zepto=https://z.example/y.json');
  assert.equal(out['Amazon Now'], 'https://a.example/x.json');
  assert.equal(out.Zepto, 'https://z.example/y.json');
  assert.deepEqual(parseFeedUrls(''), {});
});

test('fetchDeals returns normalised deals for healthy stores', async () => {
  const stub = okFeed([
    { title: 'Test Oil 1L', price: 89, mrp: 199, disc: 55.4, url: 'https://example.com/oil', cat: 'Grocery' },
  ]);
  const out = await fetchDeals({ 'Amazon Now': 'https://example.com/a.json' }, stub);
  assert.equal(out['Amazon Now'].length, 1);
  assert.equal(out['Amazon Now'][0].disc, 55, 'disc rounded to int');
  assert.equal(out['Amazon Now'][0].title, 'Test Oil 1L');
});

test('fetchDeals tolerates a failed store: empty list + warning, digest continues', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const stub = async (url) => {
      if (url.includes('blinkit')) throw new Error('fetch failed');
      if (url.includes('croma')) return { ok: false, status: 404, json: async () => ({}) };
      if (url.includes('zepto')) return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
      return { ok: true, status: 200, json: async () => ({ deals: [{ title: 'OK', price: 10, mrp: 20, disc: 50, url: '', cat: '' }] }) };
    };
    const urls = {
      'Amazon Now': 'https://x/amazon.json',
      Blinkit: 'https://x/blinkit.json',
      Croma: 'https://x/croma.json',
      Zepto: 'https://x/zepto.json',
    };
    const out = await fetchDeals(urls, stub);
    assert.deepEqual(out.Blinkit, [], 'rejected store must be []');
    assert.deepEqual(out.Croma, [], '404 store must be []');
    assert.deepEqual(out.Zepto, [], 'bad-JSON store must be []');
    assert.equal(out['Amazon Now'].length, 1, 'healthy store unaffected');
    assert.ok(warnings.length >= 3, 'expected warnings for the 3 failed stores');
  } finally {
    console.warn = origWarn;
  }
});

test('fetchDeals drops malformed deals but keeps the good ones', async () => {
  const stub = okFeed([
    { title: 'Good', price: 50, mrp: 100, disc: 50, url: '', cat: '' },
    { title: '', price: 50, mrp: 100, disc: 50, url: '', cat: '' },
    { title: 'NoPrice', price: null, mrp: 100, disc: 50, url: '', cat: '' },
  ]);
  const out = await fetchDeals({ 'Amazon Now': 'https://example.com/a.json' }, stub);
  assert.equal(out['Amazon Now'].length, 1);
  assert.equal(out['Amazon Now'][0].title, 'Good');
});

test('loadFixture returns the 9-store map used by the dry run', () => {
  const deals = loadFixture();
  assert.equal(Object.keys(deals).length, 9);
  assert.ok(Array.isArray(deals['Amazon Now']) && deals['Amazon Now'].length >= 3);
});
