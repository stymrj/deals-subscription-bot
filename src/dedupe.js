// dedupe.js — persistent 7-day dedupe for the digest (worker 2).
// Pure functions, no I/O: dealKey(store, deal) and selectDeals(...).
// The digest now runs every 15 minutes, so a deal selected once must not
// be sent again until its key ages out of the 7-day window (see
// DEDUPE_WINDOW_MS). Posted keys live in the `posted_deals` table in
// src/db.js; runDigest in src/jobs.js does the read/filter/mark.
'use strict';

const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeTitle(title) {
  return String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Deal key: store + '|' + normalized URL when the deal has a non-empty
// url, else store + '|' + normalized title + '|' + numeric sell price.
// The store is part of the key, so the same URL in two stores is two
// distinct keys. Normalization: URL — trim, strip trailing slashes,
// lowercase; title — trim, collapse internal whitespace, lowercase.
function dealKey(store, deal) {
  const url = String((deal && deal.url) || '').trim();
  if (url) return `${store}|${normalizeUrl(url)}`;
  const price = deal && Number.isFinite(Number(deal.price))
    ? String(Number(deal.price))
    : String((deal && deal.price) ?? '');
  return `${store}|${normalizeTitle(deal && deal.title)}|${price}`;
}

// MUST stay in sync with formatDigest in src/digest.js: same min-discount
// filter (disc >= min), same sort (disc desc, then savings mrp - price
// desc), same top-N cut per store. Only stores with >= 1 selected deal
// are returned (formatDigest renders an explicit "no deals" line for
// empty stores; runDigest instead omits those stores entirely).
function selectDeals(dealsByStore, config = {}) {
  const min = Number(config.MIN_DISCOUNT ?? config.minDiscount ?? 50);
  const top = Number(config.DIGEST_TOP_PER_STORE ?? config.topPerStore ?? 5);
  const out = {};
  for (const store of Object.keys(dealsByStore || {})) {
    const picked = ((dealsByStore || {})[store] || [])
      .filter(d => d && Number(d.disc) >= min)
      .sort((a, b) => b.disc - a.disc || (b.mrp - b.price) - (a.mrp - a.price))
      .slice(0, top);
    if (picked.length) out[store] = picked;
  }
  return out;
}

module.exports = { DEDUPE_WINDOW_MS, normalizeUrl, normalizeTitle, dealKey, selectDeals };
