// digest.test.js — formatting rules: top-5 cap, min-discount filter,
// no-deals store line, 4096-char split into <=2 messages without cutting a
// deal, HTML escaping.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDigest, splitMessages, escapeHtml } = require('../src/digest');
const { loadFixture } = require('../src/feed');

const CFG = { MIN_DISCOUNT: 50, DIGEST_TOP_PER_STORE: 5, date: '2026-11-10' };

function deal(title, disc, price = 100, mrp = 200) {
  return { title, price, mrp, disc, url: 'https://example.com/' + encodeURIComponent(title), cat: 'Test' };
}

test('top-5 cap: only the 5 highest-discount deals per store appear', () => {
  const deals = { 'Amazon Now': [95, 90, 80, 70, 60, 55, 51].map(d => deal('Deal ' + d, d)) };
  const msgs = formatDigest(deals, CFG);
  const text = msgs.join('\n');
  for (const d of [95, 90, 80, 70, 60]) assert.ok(text.includes('Deal ' + d), 'missing ' + d);
  assert.ok(!text.includes('Deal 55'), '6th deal leaked through');
  assert.ok(!text.includes('Deal 51'), '7th deal leaked through');
});

test('min-discount filter: deals below MIN_DISCOUNT are dropped', () => {
  const deals = { Blinkit: [deal('Good 60', 60), deal('Bad 49', 49), deal('Bad 48', 48), deal('Edge 50', 50)] };
  const text = formatDigest(deals, CFG).join('\n');
  assert.ok(text.includes('Good 60') && text.includes('Edge 50'));
  assert.ok(!text.includes('Bad 49') && !text.includes('Bad 48'));
});

test('no-deals store line: empty / all-below-min store gets the exact line', () => {
  const deals = { Croma: [], Blinkit: [deal('Low', 10)] };
  const text = formatDigest(deals, CFG).join('\n');
  assert.ok(text.includes('Croma: no deals above 50% today'));
  assert.ok(text.includes('Blinkit: no deals above 50% today'));
});

test('HTML escaping: titles cannot break out of the markup', () => {
  const deals = { Zepto: [deal('<script>alert("x")</script> & Sons', 80)] };
  const text = formatDigest(deals, CFG).join('\n');
  assert.ok(!text.includes('<script>'), 'raw script tag leaked');
  assert.ok(text.includes('&lt;script&gt;'), 'escaped tag missing');
  assert.ok(text.includes('&amp;'), 'ampersand not escaped');
  assert.equal(escapeHtml('a"b<c>d&e'), 'a&quot;b&lt;c&gt;d&amp;e');
});

test('header carries the IST date and the free-subscriber note', () => {
  const text = formatDigest({ 'Amazon Now': [deal('X', 60)] }, CFG).join('\n');
  assert.ok(text.includes('10 Nov 2026'), 'IST date missing: ' + text.slice(0, 200));
  assert.ok(text.includes('Free subscriber digest'), 'free-subscriber header missing');
  assert.ok(text.includes('prices change fast, check the link before buying'), 'header disclaimer missing');
  assert.ok(!text.includes('₹49/month'), 'paid plan note must be gone');
  assert.ok(!/₹49/.test(text), 'no price may appear in the header');
});

test('split: a long digest becomes <=2 messages of <=3900 chars, no deal cut mid-line', () => {
  const stores = {};
  for (const s of ['Amazon Now', 'Blinkit', 'Flipkart Minutes', 'BigBasket', 'Myntra', 'Croma', 'Zepto', 'Swiggy Instamart', 'JioMart']) {
    stores[s] = Array.from({ length: 5 }, (_, i) =>
      ({ title: `${s} Product ${i} With Extra Words`, price: 100, mrp: 200, disc: 90 - i, url: 'https://example.com/' + s.replace(/ /g, '') + i, cat: 'Test' }));
  }
  const msgs = formatDigest(stores, CFG);
  assert.ok(msgs.length <= 2, `expected <=2 messages, got ${msgs.length}`);
  for (const m of msgs) assert.ok(m.length <= 3900, `message ${m.length} chars exceeds 3900`);
  // Every '• ' line is a complete deal: each must contain '% off) — ' and end
  // with a store name; no line may be a fragment.
  const allLines = msgs.join('\n').split('\n').filter(l => l.startsWith('• '));
  assert.equal(allLines.length, 45, `expected 45 deal lines (9 stores x 5), got ${allLines.length}`);
  for (const line of allLines) assert.ok(/\(\d+% off\) — /.test(line), 'cut deal line: ' + line.slice(0, 80));
});

test('split: an over-cap digest still ships <=2 messages, dropping whole trailing deals', () => {
  const stores = {};
  for (const s of ['Amazon Now', 'Blinkit', 'Flipkart Minutes', 'BigBasket', 'Myntra', 'Croma', 'Zepto', 'Swiggy Instamart', 'JioMart']) {
    stores[s] = Array.from({ length: 5 }, (_, i) =>
      deal(`${s} Very Long Product Name Number ${i} With Extra Descriptive Words To Push Length`, 90 - i));
  }
  const msgs = formatDigest(stores, CFG);
  assert.ok(msgs.length <= 2, `expected <=2 messages, got ${msgs.length}`);
  for (const m of msgs) assert.ok(m.length <= 3900, `message ${m.length} chars exceeds 3900`);
  const allLines = msgs.join('\n').split('\n').filter(l => l.startsWith('• '));
  assert.ok(allLines.length > 0 && allLines.length < 40, `expected some deals dropped, got ${allLines.length} lines`);
  for (const line of allLines) assert.ok(/\(\d+% off\) — /.test(line), 'cut deal line: ' + line.slice(0, 80));
});

test('splitMessages splits only between blocks', () => {
  const blocks = ['HEADER', '• deal one', '• deal two', '• deal three'];
  const msgs = splitMessages(blocks, 30, 2);
  assert.equal(msgs.length, 2, 'should split into 2 messages, got ' + JSON.stringify(msgs));
  for (const m of msgs) assert.ok(m.length <= 30, 'message exceeds limit: ' + m);
  assert.ok(msgs.join('\n').includes('• deal one'));
  assert.ok(msgs.join('\n').includes('• deal three'));
});

test('a single over-long deal gets its title shortened, not the message blown', () => {
  const longTitle = 'X'.repeat(5000);
  // Short URL on purpose: a 5 KB URL alone would exceed the limit and no
  // amount of title-shortening could fix that (not a realistic feed case).
  const msgs = formatDigest({ 'Amazon Now': [{ title: longTitle, price: 100, mrp: 200, disc: 90, url: 'https://example.com/x', cat: 'Test' }] }, CFG);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].length <= 3900, `single-deal message ${msgs[0].length} chars`);
  assert.ok(msgs[0].includes('…'), 'no ellipsis shortening marker');
});

test('fixture loads: 9 stores, Croma empty, one 95% deal', () => {
  const deals = loadFixture();
  assert.equal(Object.keys(deals).length, 9);
  assert.deepEqual(deals.Croma, []);
  const all = Object.values(deals).flat();
  assert.ok(all.some(d => d.disc === 95), 'no 95% deal in fixture');
  assert.ok(all.length >= 30, `fixture too thin: ${all.length} deals`);
  const text = formatDigest(deals, CFG).join('\n');
  assert.ok(text.includes('95% off'));
  assert.ok(text.includes('Croma: no deals above 50% today'));
});
