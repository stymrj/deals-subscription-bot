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

// Per-user selection: filter dealsByStore to the user's enabled stores
// only, then run the shared selectDeals with the USER's min-discount
// threshold (top-N per store still comes from config, as selectDeals
// already does). Only stores with >= 1 selected deal are returned.
// prefs: { stores: string[], min_discount: number } (W1's getUserPrefs
// shape; defaults: all 9 stores, 50). A missing/partial prefs object
// falls back to every store present in dealsByStore and the config min.
function selectUserDeals(dealsByStore, prefs, config = {}) {
  const stores = Array.isArray(prefs && prefs.stores)
    ? prefs.stores
    : Object.keys(dealsByStore || {});
  const min = Number(
    (prefs && prefs.min_discount) ?? config.MIN_DISCOUNT ?? config.minDiscount ?? 50
  );
  const filtered = {};
  for (const store of stores) {
    if (dealsByStore && Object.prototype.hasOwnProperty.call(dealsByStore, store)) {
      filtered[store] = dealsByStore[store];
    }
  }
  // Pass the user's min explicitly (MIN_DISCOUNT wins over minDiscount
  // inside selectDeals, so the config's MIN_DISCOUNT must not leak in).
  return selectDeals(filtered, {
    MIN_DISCOUNT: min,
    DIGEST_TOP_PER_STORE: config.DIGEST_TOP_PER_STORE,
    topPerStore: config.topPerStore,
  });
}

module.exports = { DEDUPE_WINDOW_MS, normalizeUrl, normalizeTitle, dealKey, selectDeals, selectUserDeals };
