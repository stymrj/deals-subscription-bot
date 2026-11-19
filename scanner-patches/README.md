# scanner-patches — `--json` feed patches for the 9 scanner repos

Staged diffs only. Nothing here has been applied to any scanner repo, and
nothing has been pushed anywhere. The coordinator (or Satyam) applies each
diff in its own repo, copies `deals-feed.yml` into
`.github/workflows/deals-feed.yml`, and the feed branches start publishing.

## Validation (2026-11-10, against `~/workspace/deals-v2`)
- All 9 diffs apply cleanly: `patch -p1 --dry-run` green on pristine copies.
- All 9 patched files pass syntax checks (`node --check` for the 8 JS files,
  `python3 -m py_compile` for JioMart `bot.py`).
- Functional smoke test of the patched `core.js` `--json` mode with a stub
  platform: last stdout line is valid JSON
  `{"store":"Amazon Now","generatedAt":"…","deals":[…]}`, 25%-off and
  out-of-stock items correctly excluded, exit 0, no `data/state.json`
  written, no Telegram call attempted (no token configured).

## Feed decision — validated, no repo infeasible
Option (b) stands: scanners keep running on GitHub Actions, publish
`deals.json` to a `feed` branch daily ~08:30 IST; the subscriber bot fetches
the 9 public raw URLs at digest time. `--json` is feasible for **all 9**
repos — no repo needs omitting. Verified facts behind that:
- The 6 Node `bot/core.js` files are one shared template in 3 md5 variants
  (Amazon=Blinkit, BigBasket=Flipkart, Croma=Myntra) differing only in the
  `price()` key list, the missing-Telegram-token return code, and the
  sorted-by-discount early-break test. The three patch anchors (the `dry`
  line, the token guard, the `Scanned …` log) are byte-identical in all 6,
  so one diff shape fits all 6.
- Zepto/Swiggy `bot-v2/src/bot.js` share the same structure (dedupe filter
  + `found.sort` + price-history + Telegram loop); the patch bypasses the
  dedupe filter and returns after the sort, before any writes/sends.
- JioMart `bot.py` already has a `--dry-run`/`--once`/`--export` structure
  and a `parse_product` normaliser returning exactly the fields the feed
  needs (`name`, `effective_price`, `mrp`, `discount_pct`, `url`,
  `categories`, `in_stock`, `uid`); the patch bypasses `analyze_deals`
  and prints the snapshot after the pincode loop.

## Per-repo caveats (feed coverage is NOT uniform — see each PATCH-NOTES.md)
- **Core.js repos**: `--json` uses the single env floor `MIN_DISCOUNT`
  (default 50) for all groups, ignoring per-group `minDiscount` in
  `bot/config.json` (default 60) and `THRESHOLDS`. Intended per spec.
- **Zepto**: scanner covers only the 5 staples sub-categories + Blockbuster
  Deals; the feed will never contain the wider catalogue.
- **Swiggy**: per-campaign floors in `config.json` are 60–85%, so even with
  `MIN_DISCOUNT=50` almost no 50–59% Swiggy deals will appear.
- **JioMart**: multi-pincode runs dedupe by `uid`, keeping the lowest price;
  the pincode tag is dropped (the digest has no per-pincode concept).
- **All repos**: the JSON object is the LAST stdout line; the workflow
  extracts it with `tail -n 1` because the scanners keep their normal log
  lines on stdout. A blocked session (dead cookie) exits non-zero with no
  JSON, so the workflow fails loudly instead of publishing a stale feed.

## Layout
- `deals-feed.yml` — template workflow (cron `0 3 * * *` = 08:30 IST,
  `BOT_ENABLED` gate, scan → `tail -n 1` → validate → force-push `feed`
  branch). Per-repo command/env table is in the file header.
- `<Repo>/core-json.diff` or `bot-json.diff` — the unified diff.
- `<Repo>/PATCH-NOTES.md` — exact lines, run command, caveats.
