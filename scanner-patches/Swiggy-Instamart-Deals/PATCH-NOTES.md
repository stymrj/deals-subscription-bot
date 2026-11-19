# PATCH-NOTES — Swiggy-Instamart-Deals (`bot-v2/src/bot.js`)

Applies with: `patch -p1 < bot-json.diff` from the repo root (verified
`patch --dry-run` clean + `node --check` on the patched file, 2026-11-10).

## What it does
Adds `--json` mode (`node bot-v2/src/bot.js --json`): scans as usual, then
prints ONE JSON object as the **last** stdout line and exits:
`{"store": "Swiggy Instamart", "generatedAt": "…", "deals": [{title, price, mrp, disc, url, cat}]}`,
top 20 by discount desc, in-stock only. No Telegram send, no
`data/posted.json` / `data/prices.json` writes.

## Exact lines
1. After `const DRY = …` adds `const JSON_MODE = process.argv.includes('--json');`
2. Campaign filter: `!posted[p.id]` → `(JSON_MODE || !posted[p.id])`.
3. After `found.sort(…)` inserts the `if (JSON_MODE) { … return; }` block,
   before the price-history loop.

## Notes / caveats
- The per-campaign floors in `config.json` (60–85% depending on campaign)
  still gate collection — `MIN_DISCOUNT` env is only a floor *over* them.
  So even with `MIN_DISCOUNT=50`, the feed will contain almost no
  50–59% deals from Swiggy; that is the scanner's existing behaviour,
  not a `--json` limitation. (If 50%+ coverage is wanted, lower the
  campaign floors in `config.json` — out of scope for this patch.)
- `SWIGGY_COOKIE` + store ids are still required; the missing-cookie /
  missing-store-id checks are unchanged and still exit 1.
- Swiggy may rate-limit GitHub IPs (429); a rate-limited run yields a
  partial/empty feed — the workflow's JSON validation step will fail the
  run loudly if the output is not valid JSON.
- `[bot] …` log lines stay on stdout — the workflow extracts the JSON
  with `tail -n 1`.
- Run it: `MIN_DISCOUNT=50 node bot-v2/src/bot.js --json | tail -n 1 > deals.json`
