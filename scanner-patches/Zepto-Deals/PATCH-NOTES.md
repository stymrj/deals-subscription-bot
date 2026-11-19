# PATCH-NOTES — Zepto-Deals (`bot-v2/src/bot.js`)

Applies with: `patch -p1 < bot-json.diff` from the repo root (verified
`patch --dry-run` clean + `node --check` on the patched file, 2026-11-10).

## What it does
Adds `--json` mode (`node bot-v2/src/bot.js --json`): scans as usual, then
prints ONE JSON object as the **last** stdout line and exits:
`{"store": "Zepto", "generatedAt": "…", "deals": [{title, price, mrp, disc, url, cat}]}`,
top 20 by discount desc, `disc >= MIN_DISCOUNT` (env, default
`config.minDiscount` = 50), in-stock only. No Telegram send, no
`data/posted.json` / `data/prices.json` writes.

## Exact lines
1. After `const DRY = …` adds `const JSON_MODE = process.argv.includes('--json');`
2. Staples filter and Blockbuster filter: `!posted[p.id]` →
   `(JSON_MODE || !posted[p.id])` — the dedupe filter is bypassed in
   `--json` mode so the feed is a full snapshot, not just unseen deals.
3. After `found.sort(…)` inserts the `if (JSON_MODE) { … return; }` block,
   before the price-history `record()` loop — so no history is recorded.

## Notes / caveats
- Scope is narrow by design: the scanner only covers the 5 staples
  sub-categories (Atta, Oil, Ghee, Dals, Rice) + Blockbuster Deals — the
  feed will never contain the wider Zepto catalogue until the scanner does.
- The `ZEPTO_COOKIE` / `ZEPTO_XSRF_TOKEN` session is still required
  (BFF returns 401 without it); the cookie check at the top of `main()`
  is unchanged and still exits 1 when missing.
- Per-sub-category floors (`sub.minDiscount`, 10–20%) still apply at
  collection time; the `--json` filter then applies the env floor on top.
- `[bot] …` log lines stay on stdout — the workflow extracts the JSON
  with `tail -n 1`.
- Run it: `MIN_DISCOUNT=50 node bot-v2/src/bot.js --json | tail -n 1 > deals.json`
