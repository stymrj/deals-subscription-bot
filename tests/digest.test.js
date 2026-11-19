// digest.test.js — formatting rules: top-5 cap, min-discount filter,
// empty stores omitted (15-minute cadence: no "no deals" spam),
// empty digest sends nothing, 3900-char split into <=2 messages without
// cutting a deal, HTML escaping. All message strings come from
// src/design.js; digest.js only assembles blocks from it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDigest, splitMessages, escapeHtml, istDateTimeLabel } = require('../src/digest');
const design = require('../src/design');
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
  assert.ok(text.includes('<b>🛒 Amazon Now</b>'), 'store with deals must keep its bold emoji heading');
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
  assert.ok(text.includes('<b>🛒 PriceDrop Hunter — Fresh Deals</b>'), 'brand header missing: ' + text.slice(0, 200));
  assert.ok(text.includes('📅 Tue, 10 Nov 2026'), 'date line missing: ' + text.slice(0, 200));
  assert.ok(text.includes('Tue, 10 Nov 2026'), 'IST date missing: ' + text.slice(0, 200));
  assert.ok(text.includes('5:30 AM IST'), 'IST time missing: ' + text.slice(0, 200));
  assert.ok(text.includes('Fresh Deals'), 'fresh-deals header missing');
  assert.ok(text.includes('Fresh deals every 15 minutes · 50%+ off · duplicates removed'), 'cadence line must be the pinned wording');
  assert.ok(text.includes('50%+ off'), 'terms must state 50%+ off');
  assert.ok(text.includes('every 15 minutes'), 'terms must state the 15-minute cadence');
  assert.ok(text.includes('duplicates removed'), 'terms must state duplicates are removed');
  assert.ok(text.includes('Free subscriber digest'), 'free-subscriber header missing');
  assert.ok(text.includes('prices change fast, check the link before buying'), 'header disclaimer missing');
  assert.ok(text.includes('PriceDrop Hunter · /start · /stores · /stop'), 'pinned footer missing');
  assert.ok(!text.includes('💎'), '💎 is not in the pinned emoji set');
  assert.ok(!text.includes('Manage your subscription'), 'old footer wording must be gone');
  assert.ok(!text.includes('Daily Digest'), '"Daily Digest" copy must be gone');
  assert.ok(!text.includes('9 AM'), '"9 AM" copy must be gone');
  assert.ok(!text.includes('tomorrow'), '"tomorrow" copy must be gone');
  assert.ok(!text.includes('₹49/month'), 'paid plan note must be gone');
  assert.ok(!/₹49/.test(text), 'no price may appear in the header');
});

test('deal renders as one block: linked name, price, struck-through MRP, discount %, store', () => {
  const text = formatDigest({ 'Amazon Now': [deal('Oil 1L', 60, 100, 250)] }, CFG).join('\n');
  assert.ok(text.includes('<b>🛒 Amazon Now</b>'), 'bold emoji store heading missing');
  assert.ok(text.includes('<a href="https://example.com/Oil%201L">Oil 1L</a>'), 'linked deal name missing: ' + text);
  assert.ok(text.includes('<b>₹100</b>'), 'bold sell price missing');
  assert.ok(text.includes('<s>₹250</s>'), 'struck-through MRP missing');
  assert.ok(text.includes('(60% off)'), 'discount % missing');
  // The deal is one indivisible line: exactly one '• ' line, holding everything.
  const lines = text.split('\n').filter(l => l.startsWith('• '));
  assert.equal(lines.length, 1, 'expected exactly one deal line, got ' + lines.length);
  assert.ok(/\(60% off\) — 🛒 Amazon Now$/.test(lines[0]), 'deal line must end with the emoji store label: ' + lines[0]);
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

// ---------- design.js: the pinned API ----------

test('design: escapeHtml / inr / istDateLabel', () => {
  assert.equal(design.escapeHtml(null), '');
  assert.equal(design.escapeHtml(undefined), '');
  assert.equal(design.escapeHtml('a"b<c>d&e'), 'a&quot;b&lt;c&gt;d&amp;e');
  assert.equal(design.inr(1234), '₹1,234');
  assert.equal(design.inr(1234.6), '₹1,235');
  assert.equal(design.inr(null), '₹0');
  assert.equal(design.istDateLabel('2026-11-19T12:45:00Z'), 'Thu, 19 Nov 2026');
  // digest.js keeps re-exporting the helpers so existing imports work.
  const digest = require('../src/digest');
  assert.equal(digest.escapeHtml, design.escapeHtml);
  assert.equal(digest.inr, design.inr);
  assert.equal(digest.istDateLabel, design.istDateLabel);
  assert.equal(digest.istDateTimeLabel, design.istDateTimeLabel);
  assert.equal(digest.dealLine, design.dealLine);
});

test('design: storeEmoji / storeLabel / sectionTitle', () => {
  assert.equal(design.storeEmoji('Amazon Now'), '🛒');
  assert.equal(design.storeEmoji('Zepto'), '🚀');
  assert.equal(design.storeEmoji('No Such Store'), '');
  assert.equal(design.storeLabel('Blinkit'), '⚡ Blinkit');
  assert.equal(design.storeLabel('No Such Store'), 'No Such Store');
  assert.equal(design.storeLabel('A<&>"B'), 'A&lt;&amp;&gt;&quot;B');
  assert.equal(design.sectionTitle('Myntra'), '<b>👗 Myntra</b>');
  assert.equal(design.sectionTitle('No Such Store'), '<b>No Such Store</b>');
  assert.equal(Object.keys(design.STORE_EMOJI).length, 9, 'one emoji per tracked store');
});

test('design: header / footer / cadenceLine', () => {
  assert.equal(
    design.header('Fresh Deals', 'Thu, 19 Nov 2026 · 6:15 PM IST'),
    '<b>🛒 PriceDrop Hunter — Fresh Deals</b>\n📅 Thu, 19 Nov 2026 · 6:15 PM IST'
  );
  assert.equal(design.header('Fresh Deals'), '<b>🛒 PriceDrop Hunter — Fresh Deals</b>');
  assert.equal(design.footer(), '\n—\nPriceDrop Hunter · /start · /stores · /stop');
  assert.equal(design.cadenceLine(50), 'Fresh deals every 15 minutes · 50%+ off · duplicates removed');
  assert.equal(design.cadenceLine(30), 'Fresh deals every 15 minutes · 30%+ off · duplicates removed');
  assert.equal(design.BRAND_NAME, 'PriceDrop Hunter');
  assert.equal(design.MAX_LEN, 3900);
});

test('design: noDealsLine matches the bot one-liner verbatim', () => {
  assert.equal(
    design.noDealsLine(),
    'No deals right now matching your stores and discount threshold — check back soon, fresh deals arrive every 15 minutes.'
  );
});

test('design: dealLine with emoji store label, URL-less deal, escaping', () => {
  const line = design.dealLine({ title: 'Oil 1L', price: 100, mrp: 250, disc: 60, url: 'https://example.com/oil' }, 'Amazon Now');
  assert.equal(line, '• <a href="https://example.com/oil">Oil 1L</a> — <b>₹100</b> <s>₹250</s> (60% off) — 🛒 Amazon Now');
  const noUrl = design.dealLine({ title: 'Plain', price: 50, mrp: 100, disc: 50, url: '' }, 'Zepto');
  assert.ok(!noUrl.includes('<a href'), 'no link when there is no URL');
  assert.ok(noUrl.endsWith('— 🚀 Zepto'), 'unknown-free store label: ' + noUrl);
  const unknown = design.dealLine({ title: 'X', price: 1, mrp: 2, disc: 50, url: '' }, 'Mystery Mart');
  assert.ok(unknown.endsWith('— Mystery Mart'), 'unknown store renders bare: ' + unknown);
  const evil = design.dealLine({ title: '<b>&"q"</b>', price: 1, mrp: 2, disc: 50, url: 'https://e.com/?a=1&b=2' }, 'Blinkit');
  assert.ok(!evil.includes('<b>&'), 'raw markup leaked into title');
  assert.ok(evil.includes('&lt;b&gt;&amp;&quot;q&quot;&lt;/b&gt;'), 'title must be escaped');
  assert.ok(evil.includes('a=1&amp;b=2'), 'URL ampersand must be escaped');
});

test('design: watchAlert is bold quoted keyword + deal line + footer', () => {
  const alert = design.watchAlert('ghee', { title: 'Ghee 500ml', price: 149, mrp: 349, disc: 57, url: 'https://example.com/ghee' }, 'Zepto');
  assert.ok(alert.startsWith('🔔 <b>Watch alert: "ghee"</b>\n• '), 'alert header wrong: ' + alert.slice(0, 80));
  assert.ok(alert.includes('(57% off) — 🚀 Zepto'), 'deal line missing emoji store label');
  assert.ok(alert.endsWith(design.footer()), 'alert must end with the pinned footer');
  const evil = design.watchAlert('<script>', { title: 'X', price: 1, mrp: 2, disc: 50, url: '' }, 'Zepto');
  assert.ok(!evil.includes('<script>'), 'raw keyword leaked');
  assert.ok(evil.includes('&lt;script&gt;'), 'keyword must be escaped');
});

test('design: only pinned emoji appear in design.js output', () => {
  // Every emoji the design module can emit: brand 🛒, date 📅, alert 🔔,
  // plus the 9 store emoji. ✅ ❌ 🎉 live in bot.js (W2), not here.
  const samples = [
    design.header('Fresh Deals', 'Thu, 19 Nov 2026 · 6:15 PM IST'),
    design.footer(), design.cadenceLine(50), design.noDealsLine(),
    design.sectionTitle('Zepto'),
    design.dealLine({ title: 'X', price: 1, mrp: 2, disc: 50, url: '' }, 'Swiggy Instamart'),
    design.watchAlert('kw', { title: 'X', price: 1, mrp: 2, disc: 50, url: '' }, 'JioMart'),
  ].join('\n');
  for (const banned of ['👋', '🆓', '📋', '🏬', '🏆', '📊', '💎']) {
    assert.ok(!samples.includes(banned), 'unpinned emoji in design output: ' + banned);
  }
});
