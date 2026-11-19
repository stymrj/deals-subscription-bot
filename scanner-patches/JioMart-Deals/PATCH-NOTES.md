# PATCH-NOTES — JioMart-Deals (`bot-v2/bot.py`)

Applies with: `patch -p1 < bot-json.diff` from the repo root (verified
`patch --dry-run` clean + `python3 -m py_compile` on the patched file,
2026-11-10).

## What it does
Adds `--json` mode (`python bot-v2/bot.py --once --json`): scans as usual,
then prints ONE JSON object (single line) as the **last** stdout line and
exits 0: `{"store": "JioMart", "generatedAt": "…",
"deals": [{title, price, mrp, disc, url, cat}]}`, top 20 by discount desc
then savings desc, `disc >= --min-discount` (default 50), in-stock only.
No Telegram send, no SQLite/differ history writes, no export files.

## Exact lines
1. `argparse`: adds `--json` flag (after `--dry-run`).
2. `scan_once(…)`: adds `json_mode=False` parameter.
3. Inside the per-pincode loop, after `fetcher.close()` and before
   `analyze_deals(…)`: `if json_mode: all_products.extend(pin_products); continue`
   — keeps every fetched product, skips the differ entirely.
4. After the pincode loop, before `if export_fmt:`: the `if json_mode:`
   block — dedupes by `uid` across pincodes (keeps the lowest price),
   filters, sorts, slices 20, prints `json.dumps(out)`, returns 0.
   (Returning before the `strict` checks at the end is intentional:
   `--json` is a snapshot, not an alert run, so "0 fetched" is reported
   as an empty feed, not a crash — the workflow's JSON validation still
   catches a missing/invalid file.)
5. `main()` `--once` call site: passes `json_mode=args.json`.

## Notes / caveats
- Multi-pincode: products are deduped by `uid` keeping the lowest
  `effective_price`; the `pincode` tag is dropped in the feed output
  (the digest has no per-pincode concept). Default pincode is 560045
  unless `JIOMART_PINCODES` / `--pincode` says otherwise.
- `cat` is the first entry of the product's `categories` list (may be
  `""` when the API returns none).
- Per-category `[{pin}][{cat}] …` log lines stay on stdout — the workflow
  extracts the JSON with `tail -n 1`.
- `JIOMART_BEARER` is only needed if the API 401/403s (per the v2 audit);
  the fetcher works without it while the session is valid.
- Run it: `python bot-v2/bot.py --once --json | tail -n 1 > deals.json`
  (after `pip install -r bot-v2/requirements.txt`, Python 3.12).
