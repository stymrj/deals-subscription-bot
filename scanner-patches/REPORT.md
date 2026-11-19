# Feed wiring — REPORT (2026-11-19)

The 9 scanner repos now each have a `--json` feed mode + a daily
`deals-feed.yml` workflow on a `feed-publish` branch, with a PR to main.
**Nothing is merged, nothing was pushed to main.** Satyam merges the 9 PRs
himself.

## PRs (all #3, all open, all `mergeable: true`, all `feed-publish` → `main`)

| Repo | PR | Branch SHA | Patch vs staged diff |
|---|---|---|---|
| Amazon-Now-Deals | https://github.com/stymrj/Amazon-Now-Deals/pull/3 | `17870e97` | ADAPTED — hunk #1: live main's token guard is `console.log(…); return 0;`, not the patch's `console.error(…); return 1;`. Guard now `!jsonMode && !dry && …`; rest identical. |
| Blinkit-Deals | https://github.com/stymrj/Blinkit-Deals/pull/3 | `5a52614a` | ADAPTED — same hunk #1 cause/fix as Amazon. |
| Flipkart-Minute-Deals | https://github.com/stymrj/Flipkart-Minute-Deals/pull/3 | `dd8504cf` | CLEAN (fuzz 2, offset only). |
| BigBasket-Deals | https://github.com/stymrj/BigBasket-Deals/pull/3 | `56612e3c` | CLEAN (fuzz 2). |
| Zepto-Deals | https://github.com/stymrj/Zepto-Deals/pull/3 | `c03cd173` | CLEAN. |
| Swiggy-Instamart-Deals | https://github.com/stymrj/Swiggy-Instamart-Deals/pull/3 | `4ac5da90` | ADAPTED — live main predates the v2 branch: no `DRY` const, no `envMin`. Added `JSON_MODE` + `envMin` (v2-branch definitions); campaign filter is the staged line. See note below. |
| Myntra-Deals | https://github.com/stymrj/Myntra-Deals/pull/3 | `470cf537` | CLEAN. |
| Croma-Deals | https://github.com/stymrj/Croma-Deals/pull/3 | `836d8a7f` | CLEAN. |
| JioMart-Deals | https://github.com/stymrj/JioMart-Deals/pull/3 | `091cfaa6` | ADAPTED — live main predates v2 `strict`/`send_failed` additions: signature gains only `json_mode=False`; JSON block inserted after the pincode loop (no `send_failed` context). |

Each commit is a single commit parented on the verified live main HEAD,
2 files only (`bot/core.js` or `bot-v2/src/bot.js` / `bot-v2/bot.py`
+19/−1-ish, plus `.github/workflows/deals-feed.yml`). All patched files
pass `node --check` / `py_compile`; all 9 workflow YAMLs parse.

## ⚠️ HEADLINE: after he merges, NOTHING flows until secrets + variables are set

Verified by the coordinator via the GitHub API (HTTP 200, count 0 — the
token CAN list them, so this is genuine, not a permission artifact):
**every one of the 9 repos currently has ZERO secrets and ZERO Actions
variables set.** That means:

- `BOT_ENABLED` is unset everywhere → every feed workflow's scheduled run
  will SKIP (same gate as the Telegram workflows). Zepto proves it: its
  `telegram-bot.yml` has 21 runs, latest 2026-11-19 11:24 UTC, every one
  `completed / skipped` on schedule.
- No platform cookie is set anywhere → scans would fail loudly (blocked
  session → exit 1) instead of publishing a feed.

So the merge checklist per repo is: **(1) merge PR #3, (2) set
`BOT_ENABLED=true` (repo variable), (3) set the repo's platform secret(s)
below.** First feed then publishes at the next 08:30 IST run (cron
`0 3 * * *`), or immediately via workflow_dispatch. The `feed` branch is
created by the workflow itself (`checkout -B feed` + force-push of
`deals.json`).

## Per-repo secrets / vars wired into deals-feed.yml (exact names, copied from each repo's own telegram-bot.yml)

| Repo | Secrets needed | Vars needed | Notes |
|---|---|---|---|
| Amazon-Now-Deals | `AMAZON_COOKIE`, `AMAZON_BRAND_ID` | `MIN_DISCOUNT` (optional, default 50) | |
| Blinkit-Deals | `BLINKIT_LAT`, `BLINKIT_LON` (required), `BLINKIT_COOKIE` (optional) | `MIN_DISCOUNT` | `BLINKIT_LOCATIONS` does NOT exist in this repo. |
| Flipkart-Minute-Deals | `FLIPKART_COOKIE`, `PINCODE` (effectively optional — falls back to cookie pincode) | `MIN_DISCOUNT` | |
| BigBasket-Deals | `BIGBASKET_COOKIE` | `BOT_ENABLED`, `RUNNER`, `MIN_DISCOUNT`/`THRESHOLDS`/`GROUPS`/`PAGES`/`MAX_WORKERS` (optional) | **Self-hosted runner required** — GitHub IPs are usually 403'd. Runner mirrored from telegram-bot.yml: `runs-on: ${{ vars.RUNNER \|\| 'ubuntu-latest' }}`; set `RUNNER` to the self-hosted runner name or it falls back to ubuntu-latest and will likely fail. |
| Zepto-Deals | `ZEPTO_COOKIE`, `ZEPTO_XSRF_TOKEN` | `BOT_ENABLED`, `MIN_DISCOUNT`; `ZEPTO_STORE_ID`/`ZEPTO_DEVICE_ID`/`ZEPTO_LAT`/`ZEPTO_LNG` optional (defaults exist) | Feed covers 5 staples sub-categories + Blockbuster only. |
| Swiggy-Instamart-Deals | `SWIGGY_COOKIE` | `BOT_ENABLED`, `SWIGGY_PRIMARY_STORE_ID` (or `SWIGGY_STORE_ID`) required; other store/device vars optional | Per-campaign floors 60–85% gate collection, so few 50–59% deals appear. |
| Myntra-Deals | none | `BOT_ENABLED` (+ optional `MIN_DISCOUNT`/`THRESHOLDS`/`GROUPS`/`PAGES`/`MAX_WORKERS`) | No platform cookie — public gateway API. |
| Croma-Deals | none | `BOT_ENABLED`, `CROMA_PINCODE` (optional, defaults 400049 in scanner) + optional `MIN_DISCOUNT`/… | |
| JioMart-Deals | `JIOMART_BEARER` (optional — only if 401/403) | `BOT_ENABLED`, `JIOMART_PINCODE` (optional, defaults 560045) | |

## Deviations / things that changed vs the staged patches

- **Amazon + Blinkit hunk #1** (above): live main's token guard differs
  from the v2 tree the patches were staged against. Adapted, and the
  coordinator verified the pushed commit diff is exactly the intended
  change.
- **Swiggy + JioMart staged against the v2 branch, live main is older.**
  Both adapted minimally from live-main code (details in the table).
  Side effect to know: Swiggy's NORMAL (non-`--json`) runs now respect
  `MIN_DISCOUNT` as a floor when set — on live main the env var was
  silently ignored, even though `bot-v2/README.md` documents it as the
  global floor (default 70). With it unset, normal-run behaviour is
  identical. No such side effect on JioMart (feed code is purely additive).
- **Myntra, Croma, Swiggy, JioMart have NO `telegram-bot.yml` on live
  main** (their PR #2s are still unmerged). Their feed-workflow env/runner
  names were copied from the `v2` branch's `telegram-bot.yml` (read-only
  via API) and cross-checked against the live-main bot code, which reads
  those names. No names were invented.
- **Zepto PR #2 is MERGED** (closed, merged 2026-11-10T14:32:06Z by
  stymrj) — correction to the earlier "PR #2s unmerged" note. Zepto's main
  therefore already has the Telegram deploy fix + `telegram-bot.yml`. The
  other 8 repos' PR #2s are still open.
- **BigBasket `runs-on`** mirrors its telegram-bot.yml
  (`${{ vars.RUNNER || 'ubuntu-latest' }}`); all other repos use
  `ubuntu-latest` (Zepto/Swiggy/Amazon/Blinkit/Flipkart) or the same
  `vars.RUNNER` fallback (Myntra/Croma, copied from v2).
- **Feed workflow does NOT wire `GROUPS`/`PAGES`/`THRESHOLDS`** for
  Amazon/Blinkit/Flipkart/Zepto/Swiggy (template default) — the feed scans
  all groups at default pages. BigBasket/Myntra/Croma wire them (from
  their telegram-bot.yml). Not a bug, just a difference to know.
- A stray `bot/core.js.orig` patch backup appeared in the BigBasket clone
  and was deleted before pushing; it is in no commit.

## Feed URL cross-check (bot side, read-only)

The bot's `src/feed.js` (`REPO_BY_STORE` + `defaultFeedUrls`) lists
exactly these 9 repos with branch `feed` and file `deals.json` — no
mismatch:
`Amazon-Now-Deals`, `Blinkit-Deals`, `Flipkart-Minute-Deals`,
`BigBasket-Deals`, `Myntra-Deals`, `Croma-Deals`, `Zepto-Deals`,
`Swiggy-Instamart-Deals`, `JioMart-Deals` → store names Amazon Now,
Blinkit, Flipkart Minutes, BigBasket, Myntra, Croma, Zepto,
Swiggy Instamart, JioMart. The workflow force-pushes only `deals.json`
to the `feed` branch; the bot fetches the raw URLs at digest time.

## Verification done by the coordinator (2026-11-19)

- Per repo: `patch --dry-run` clean or adapted + noted; `node --check` /
  `py_compile` clean; workflow YAML parses; `feed-publish` branch exists
  at the stated SHA (re-checked via API); PR #3 open, head
  `feed-publish` → base `main`, `mergeable: true` on all 9.
- Amazon adapted patch re-read from the pushed commit diff — exactly the
  intended change. Swiggy + JioMart adapted patches re-read from the
  pushed commit diffs — correct.
- Secrets/vars: API `GET …/actions/secrets` and `…/actions/variables`
  returned HTTP 200, `total_count: 0`, on all 9 repos.
- Work files: clones + push scripts in `~/workspace/feed-publish/`
  (not part of any repo).

## What still needs him (after the 9 merges)

1. Merge the 9 PR #3s.
2. Set `BOT_ENABLED=true` (repo variable) on all 9 repos.
3. Set the per-repo platform secrets in the table above.
4. BigBasket only: set repo variable `RUNNER` to the self-hosted runner
   name.
5. Optional: trigger each feed workflow manually (workflow_dispatch) to
   get the first `deals.json` immediately instead of waiting for 08:30 IST.
