// feed.js — fetch the per-store deals.json feeds published by the 9 scanner
// repos (Option b: scanners run on GitHub Actions, publish a `feed` branch;
// this bot only reads the public raw URLs, so it needs NO platform cookies).
// No Telegram, no DB, no credentials here. Pure fetch + normalise.
'use strict';

const fs = require('fs');
const path = require('path');

const STORE_ORDER = [
  'Amazon Now', 'Blinkit', 'Flipkart Minutes', 'BigBasket', 'Myntra',
  'Croma', 'Zepto', 'Swiggy Instamart', 'JioMart',
];

const REPO_BY_STORE = {
  'Amazon Now': 'Amazon-Now-Deals',
  'Blinkit': 'Blinkit-Deals',
  'Flipkart Minutes': 'Flipkart-Minute-Deals',
  'BigBasket': 'BigBasket-Deals',
  'Myntra': 'Myntra-Deals',
  'Croma': 'Croma-Deals',
  'Zepto': 'Zepto-Deals',
  'Swiggy Instamart': 'Swiggy-Instamart-Deals',
  'JioMart': 'JioMart-Deals',
};

const FETCH_TIMEOUT_MS = 10_000;

function defaultFeedUrls() {
  const out = {};
  for (const store of STORE_ORDER) {
    out[store] = `https://raw.githubusercontent.com/stymrj/${REPO_BY_STORE[store]}/feed/deals.json`;
  }
  return out;
}

// FEED_URLS env: comma-separated `Store=url` pairs, e.g.
//   FEED_URLS="Amazon Now=https://example.com/a.json,Zepto=https://example.com/z.json"
// Stores not listed keep their default URL; unknown store names are kept too.
function parseFeedUrls(str) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const store = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim();
    if (store && url) out[store] = url;
  }
  return out;
}

function resolveFeedUrls(feedUrls) {
  const base = defaultFeedUrls();
  if (!feedUrls) {
    return { ...base, ...parseFeedUrls(process.env.FEED_URLS) };
  }
  if (Array.isArray(feedUrls)) {
    // [{store, url}] or ['Store=url', ...]
    const out = { ...base };
    for (const item of feedUrls) {
      if (typeof item === 'string') Object.assign(out, parseFeedUrls(item));
      else if (item && item.store && item.url) out[item.store] = item.url;
    }
    return out;
  }
  if (typeof feedUrls === 'object') return { ...base, ...feedUrls };
  return base;
}

function normaliseDeal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (raw.price == null || raw.mrp == null || raw.disc == null) return null;
  const price = Number(raw.price);
  const mrp = Number(raw.mrp);
  const disc = Number(raw.disc);
  if (!title || !Number.isFinite(price) || price < 0) return null;
  if (!Number.isFinite(mrp) || mrp < price) return null;
  if (!Number.isFinite(disc)) return null;
  return {
    title,
    price,
    mrp,
    disc: Math.round(disc),
    url: String(raw.url || ''),
    cat: String(raw.cat || ''),
  };
}

// Fetch every store feed. A failed store (timeout, 404, bad JSON) yields an
// empty list + a warning — it never crashes the digest.
// fetchDeals(feedUrls?, fetchFn?) — feedUrls may be omitted, a {store:url}
// map, or an array; fetchFn defaults to global fetch (injectable for tests).
async function fetchDeals(feedUrls, fetchFn) {
  if (typeof feedUrls === 'function') { fetchFn = feedUrls; feedUrls = undefined; }
  const urls = resolveFeedUrls(feedUrls);
  const fetchImpl = fetchFn || globalThis.fetch;
  const out = {};
  // Fixed store order first, then any extra (env-added) stores.
  const stores = [...STORE_ORDER.filter(s => s in urls), ...Object.keys(urls).filter(s => !STORE_ORDER.includes(s))];
  for (const store of stores) {
    try {
      if (typeof fetchImpl !== 'function') throw new Error('no fetch available');
      const res = await fetchImpl(urls[store], { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const rawDeals = Array.isArray(body) ? body : (Array.isArray(body && body.deals) ? body.deals : []);
      out[store] = rawDeals.map(normaliseDeal).filter(Boolean);
    } catch (err) {
      console.warn(`[feed] ${store}: ${err && err.message ? err.message : err} — using empty list`);
      out[store] = [];
    }
  }
  return out;
}

// Local-test fixture loader. fixtures/deals.json is a plain
// {store: [deal, ...]} map (same shape fetchDeals returns).
function loadFixture(filePath) {
  const file = filePath || path.join(__dirname, '..', 'fixtures', 'deals.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = data && data.stores ? data.stores : data;
  const out = {};
  for (const store of Object.keys(map)) {
    out[store] = (Array.isArray(map[store]) ? map[store] : []).map(normaliseDeal).filter(Boolean);
  }
  return out;
}

module.exports = {
  STORE_ORDER, REPO_BY_STORE, FETCH_TIMEOUT_MS,
  defaultFeedUrls, parseFeedUrls, resolveFeedUrls,
  fetchDeals, loadFixture, normaliseDeal,
};
