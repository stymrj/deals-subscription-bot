# PATCH-NOTES — Amazon-Now-Deals (`bot/core.js`)

Applies with: `patch -p1 < core-json.diff` from the repo root (verified
`patch --dry-run` clean against the v2 tree, 2026-11-10).

## What it does
Adds a `--json` feed mode to the scanner entry (`node bot/run.js --json`).
The scan runs exactly as usual, then — instead of the state/dedupe/digest
gating and Telegram send — it prints ONE JSON object as the **last** stdout
line and exits 0:

```json
{"store": "Amazon Now", "generatedAt": "2026-11-10T03:00:00Z",
  "deals": [{"title": "...", "price": 89, "mrp": 199, "disc": 55,
              "url": "https://…", "cat": "Grocery › Oils"}]}
```
- Deals: in-stock only, `disc >= MIN_DISCOUNT` env (default 50), sorted by
  discount desc then savings desc, top 20.
- Skips: Telegram send (and the `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
  requirement), `data/state.json` read/write, digest-date gating.
- A blocked session (dead cookie, `blocked` set) exits 1 with no JSON, so
  the workflow fails loudly instead of publishing a stale/empty feed.
- An empty scan (not blocked) still prints `{"store": …, "deals": []}`
  and exits 0, so the feed branch gets an explicit empty feed.

## Exact lines (all three anchors are byte-identical in all 6 core.js repos)
1. After `const dry = argv.includes('--dry-run') …` in `run()`:
   adds `const jsonMode = argv.includes('--json');`
2. Token guard `if (!dry && (!token || !chat))` → `if (!jsonMode && !dry && …)`.
3. After the `Scanned … products` log, before `if (!found.size) …`:
   inserts the `if (jsonMode) { … }` block (filter → sort → slice(0, 20)
   → `console.log(JSON.stringify({store: platform.label, …})); return 0;`).

## Notes / caveats for this repo
- `core.js` is a shared template but NOT byte-identical across the 6 repos
  (3 md5 variants: Amazon=Blinkit, BigBasket=Flipkart, Croma=Myntra). The variants differ only in the `price()`
  key list, the missing-Telegram-token return code, and the
  sorted-by-discount early-break test — none of which the patch touches,
  so this one diff shape applies to all 6 (line numbers differ by ±3).
- `--json` uses the single env floor `MIN_DISCOUNT` (default 50) for ALL
  groups, ignoring the per-group `minDiscount` in `bot/config.json`
  (default 60) and `THRESHOLDS`. That is per the digest spec (feed = all
  deals ≥50%); the subscriber bot re-filters at the same 50% floor.
- Non-JSON `console.log` lines (e.g. `Scanned …`, per-aisle `! …` errors)
  stay on stdout — the workflow extracts the JSON with `tail -n 1`.
- Run it: `MIN_DISCOUNT=50 node bot/run.js --json | tail -n 1 > deals.json`
  (secrets needed: the repo's usual platform cookie/brand vars only;
  no Telegram vars needed in `--json` mode).
- Smoke-tested 2026-11-10 with a stub platform: valid JSON last line,
  25%-off and out-of-stock items correctly excluded, exit 0, no
  `data/state.json` written.
