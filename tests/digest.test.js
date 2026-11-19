// digest.test.js — formatting rules: top-5 cap, min-discount filter,
// empty stores omitted (15-minute cadence: no "no deals" spam),
// empty digest sends nothing, 3900-char split into <=2 messages without
// cutting a deal, HTML escaping.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDigest, splitMessages, escapeHtml, istDateTimeLabel } = require('../src/digest');
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

test('empty stores are omitted entirely: no heading, no "no deals" line', () => {
  const deals = { Croma: [], Blinkit: [deal('Low', 10)], 'Amazon Now': [deal('Good 60', 60)] };
  const msgs = formatDigest(deals, CFG);
  const text = msgs.join('\n');
  assert.ok(!text.includes('Croma'), 'empty store must not appear: ' + text.slice(0, 300));
  assert.ok(!text.includes('Blinkit'), 'all-below-min store must not appear');
  assert.ok(!text.includes('no deals above'), 'no "no deals" line may appear at 15-minute cadence');
  assert.ok(text.includes('<b>Amazon Now</b>'), 'store with deals must keep its bold heading');
  assert.ok(text.includes('Good 60'));
});

test('empty input returns []: no deals anywhere means no message at all', () => {
  assert.deepEqual(formatDigest({}, CFG), []);
  assert.deepEqual(formatDigest({ 'Amazon Now': [] }, CFG), []);
  assert.deepEqual(formatDigest({ Blinkit: [deal('Low', 10)] }, CFG), []);
  assert.deepEqual(formatDigest(undefined, CFG), []);
});

test('istDateTimeLabel: IST date and time, e.g. Thu, 19 Nov 2026 · 6:15 PM IST', () => {
  // 2026-11-19T12:45:00Z is 18:15 IST (a Thursday).
  assert.equal(istDateTimeLabel('2026-11-19T12:45:00Z'), 'Thu, 19 Nov 2026 · 6:15 PM IST');
  assert.equal(istDateTimeLabel('2026-11-10T00:00:00Z'), 'Tue, 10 Nov 2026 · 5:30 AM IST');
});

test('HTML escaping: titles cannot break out of the markup', () => {
  const deals = { Zepto: [deal('<script>alert("x")</script> & Sons', 80)] };
  const text = formatDigest(deals, CFG).join('\n');
  assert.ok(!text.includes('<script>'), 'raw script tag leaked');
  assert.ok(text.includes('&lt;script&gt;'), 'escaped tag missing');
  assert.ok(text.includes('&amp;'), 'ampersand not escaped');
  assert.equal(escapeHtml('a"b<c>d&e'), 'a&quot;b&lt;c&gt;d&amp;e');
});

test('header carries the IST date and time plus the terms (50%+, 15 min, deduped)', () => {
  const text = formatDigest({ 'Amazon Now': [deal('X', 60)] }, CFG).join('\n');
  assert.ok(text.includes('Tue, 10 Nov 2026'), 'IST date missing: ' + text.slice(0, 200));
  assert.ok(text.includes('5:30 AM IST'), 'IST time missing: ' + text.slice(0, 200));
  assert.ok(text.includes('Fresh Deals'), 'fresh-deals header missing');
  assert.ok(text.includes('50%+ off'), 'terms must state 50%+ off');
  assert.ok(text.includes('every 15 minutes'), 'terms must state the 15-minute cadence');
  assert.ok(text.includes('duplicates removed'), 'terms must state duplicates are removed');
  assert.ok(text.includes('Free subscriber digest'), 'free-subscriber header missing');
  assert.ok(text.includes('prices change fast, check the link before buying'), 'header disclaimer missing');
  assert.ok(!text.includes('Daily Digest'), '"Daily Digest" copy must be gone');
  assert.ok(!text.includes('9 AM'), '"9 AM" copy must be gone');
  assert.ok(!text.includes('tomorrow'), '"tomorrow" copy must be gone');
  assert.ok(!text.includes('₹49/month'), 'paid plan note must be gone');
  assert.ok(!/₹49/.test(text), 'no price may appear in the header');
});

test('deal renders as one block: linked name, price, struck-through MRP, discount %, store', () => {
  const text = formatDigest({ 'Amazon Now': [deal('Oil 1L', 60, 100, 250)] }, CFG).join('\n');
  assert.ok(text.includes('<b>Amazon Now</b>'), 'bold store heading missing');
  assert.ok(text.includes('<a href="https://example.com/Oil%201L">Oil 1L</a>'), 'linked deal name missing: ' + text);
  assert.ok(text.includes('₹100'), 'sell price missing');
  assert.ok(text.includes('<s>₹250</s>'), 'struck-through MRP missing');
  assert.ok(text.includes('(60% off)'), 'discount % missing');
  // The deal is one indivisible line: exactly one '• ' line, holding everything.
  const lines = text.split('\n').filter(l => l.startsWith('• '));
  assert.equal(lines.length, 1, 'expected exactly one deal line, got ' + lines.length);
  assert.ok(/\(60% off\) — Amazon Now$/.test(lines[0]), 'deal line must end with the store: ' + lines[0]);
});

test('deal without a URL still renders (plain name, no empty link)', () => {
  const msgs = formatDigest({ 'Amazon Now': [{ title: 'No Link Deal', price: 100, mrp: 200, disc: 70, url: '', cat: 'Test' }] }, CFG);
  const text = msgs.join('\n');
  assert.ok(text.includes('No Link Deal'));
  assert.ok(!text.includes('<a href'), 'no link must be emitted when there is no URL');
  assert.ok(text.includes('<s>₹200</s>'));
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
  // Dropped-deals note uses the 15-minute cadence, not "tomorrow's digest".
  const text = msgs.join('\n');
  assert.ok(text.includes('in the next update'), 'reworded dropped-deals note missing: ' + text.slice(-200));
  assert.ok(!text.includes("tomorrow's digest"), 'old "tomorrow\'s digest" note must be gone');
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

test('fixture loads: 9 stores, Croma empty and omitted, one 95% deal', () => {
  const deals = loadFixture();
  assert.equal(Object.keys(deals).length, 9);
  assert.deepEqual(deals.Croma, []);
  const all = Object.values(deals).flat();
  assert.ok(all.some(d => d.disc === 95), 'no 95% deal in fixture');
  assert.ok(all.length >= 30, `fixture too thin: ${all.length} deals`);
  const text = formatDigest(deals, CFG).join('\n');
  assert.ok(text.includes('95% off'));
  assert.ok(!text.includes('Croma'), 'empty Croma must be omitted from the digest');
  assert.ok(!text.includes('no deals above'), 'no "no deals" line may appear');
});
