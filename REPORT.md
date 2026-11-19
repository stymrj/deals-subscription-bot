# Telegram Subscription Bot — report

## 2026-11-19: Feature upgrade — /stores, /setdiscount, /deals + /top, /watch (current state)

**What changed:** on 2026-11-19 Satyam said the bot was "too much basic
and no features". Built the same evening by three workers in parallel
(scratch copies, merged by the coordinator into the live tree). Nothing
pushed, nothing deployed, no new env vars, no credentials used.

- **Per-store picks — /stores.** Inline keyboard with ✅/❌ toggles for
  all 9 stores (callback data `store:toggle:<index>` — index into
  `STORE_ORDER`, never raw names); tapping toggles that store for that
  user and edits the message to the new state. Stored per user in a new
  `user_prefs` table (`user_id PK, stores TEXT JSON, min_discount INT`).
  Default: all 9 stores ON. The 15-minute digest sends each user only
  their enabled stores; a user with zero stores enabled gets nothing
  (not an error).
- **Own discount threshold — /setdiscount <10-90>.** Validated
  10–90; success replies with the new threshold, bad input replies with
  a usage hint + the current threshold. The digest, `/deals` and `/top`
  all filter by the user's own threshold (default 50). `/status` shows
  the threshold, the enabled-store count and the watchlist count (and
  the "every 15 minutes · N%+ off" line now renders the user's own
  threshold instead of a hardcoded 50%).
- **On-demand deals — /deals and /top.** `/deals` fetches the feeds
  right now and replies with the current top deals (user's stores +
  threshold, reused `formatDigest`); `/top` replies with the single
  best deal (highest discount, tie-break biggest saving). Both write NO
  dedupe state — on-demand sends never consume deals from the digest
  stream. Empty → one polite "no deals right now" line. No
  active-subscription gate (anyone messaging the bot can use them).
- **Keyword watchlist — /watch, /unwatch, /watchlist.** Max 10 keywords
  per user (stored lowercased; match is a case-insensitive substring on
  the deal title). `/watchlist` lists them. Inside `runDigest`, after
  the per-user dedupe selection, each NEW deal is checked against that
  user's keywords; a match sends one separate `🔔 Watch alert:
  <keyword> — <deal line>` message per deal per user, in addition to
  the digest. Alerts reuse the `posted_deals` keying (they only fire for
  fresh deals, and every sent fresh key is marked posted), so a deal is
  never alerted twice. New table `watchlist(user_id, keyword, PK
  (user_id, keyword))`.
- **/start + /help current.** Both render one shared `commandsText()`
  helper (store list + all commands incl. the 7 new ones), so they
  cannot drift. `createBot` accepts an optional `fetchDeals` override
  (test seam; production passes nothing).
- **No new env vars.** The deploy checklist is unchanged: push to main
  (Vercel auto-deploys), no Vercel env changes, no GitHub secret
  changes.

**Test evidence (coordinator re-run on the merged tree):** `npm install`
clean; `node --check` clean on all changed src + tests JS;
**`npm test`: 113 pass, 0 fail** (70 baseline + 16 new db tests + 17
new jobs/dedupe tests + 10 new bot tests). Coverage: store toggle
on/off persists + message edit + toggle-back; threshold valid/invalid
+ digest filters per user + `/status` shows it; `/deals` + `/top`
return current deals, write NO `posted_deals` rows, empty → polite
one-liner; watch add/remove/list, max 10, case-insensitive match,
one alert per deal per user, no alert for non-matching / already-posted
/ store-excluded deals. One existing jobs test rewritten (expected
return shape gained `alertsSent: 0`); all other existing tests pass
unmodified. `npm run digest:dry` still works (2 messages, 9 fixture
stores, not sent). Greps clean: no real tokens/values; no leftover
"daily / 9 AM" copy in user-facing messages. Merge notes: the merge
took W1's `src/db.js` + `tests/db.test.js`, W2's `src/jobs.js` +
`src/dedupe.js` + `tests/jobs.test.js` + `tests/dedupe.test.js`, W3's
`src/bot.js` + `tests/bot.test.js`; W3's local `db.js`/`dedupe.js`
scaffolding was discarded (W3's `db.js` used a `watches` table name
vs W1's `watchlist` — internal only, method signatures were
identical). `runDigest` now returns `alertsSent` in addition to the
previous fields; `api/cron-digest.js` forwards the result verbatim, so
it is unaffected.

**Honest note:** live feeds are still pending — the 9 scanner repos'
feed branches are PR #3s, open and unmerged (separate coordinator).
Until they merge and the repos publish `deals.json`, the live digest,
`/deals`, `/top` and watch alerts all correctly find nothing. The feed
publishes once daily (08:30 IST), so the 15-minute digest re-reads the
same daily feed — new deals appear daily, not every 15 minutes, unless
feed cadence is raised (separate decision).

## 2026-11-19: 15-minute digest + dedupe + better design (current state)

**What changed:** on 2026-11-19 Satyam asked for the digest every 15
minutes instead of once a day, with no duplicate sends, a better message
design, and the covered stores listed on `/start`. Built the same evening
in the already-deployed repo (Vercel + Turso live since 18:19 IST):

- **Trigger — GitHub Actions, not Vercel Cron.** Vercel Hobby allows at
  most ONE cron run per day, so a 15-minute cadence cannot be a Vercel
  cron (Pro is $20/mo — the bot stays free everywhere). `vercel.json`
  is now `{}` (no crons). New `.github/workflows/digest-15min.yml`:
  schedule `*/15 * * * *` + `workflow_dispatch`, concurrency group
  `digest-15min` with `cancel-in-progress: false`, one `ubuntu-latest`
  job that POSTs to `https://deals-subscription-bot.vercel.app/api/cron-digest`
  with `curl --fail --max-time 300`, the secret sent only as the
  `x-cron-secret` header from `${{ secrets.CRON_SECRET }}` (never in
  the URL, no literal value anywhere).
- **Auth on the endpoint.** `api/cron-digest.js` now gates BEFORE any
  bot work: accept if (a) the `x-vercel-cron` header is present
  (keeps working if a Vercel cron is ever re-added; header alone is
  NOT security — a spoofed hit can at worst trigger one extra digest
  send), or (b) `CRON_SECRET` is configured and the request carries
  the exact value via `?secret=` or the `x-cron-secret` header
  (constant-time compare). Anything else → 401
  `{ok:false,error:'Unauthorized'}` and nothing is sent. The secret is
  env `CRON_SECRET` (`src/config.js`, optional, never throws when
  missing). No secret value was invented or stored anywhere — the
  parent creates it at deploy time and sets it in TWO places to the
  same value: the Vercel env var AND the GitHub repo secret
  `CRON_SECRET`. Until both match, workflow calls 401.
- **Dedupe — 7 days, in Turso.** New `posted_deals` table
  (`deal_key TEXT PRIMARY KEY, store TEXT, title TEXT, posted_at
  INTEGER`) + store methods `getRecentPostedKeys(sinceMs)` and
  `markPosted(entries)` (INSERT OR REPLACE, so a deal re-sent after its
  window expired restarts its 7-day clock). Key = `store|normalized
  URL` when a URL exists, else `store|normalized title|sell price`
  (URL: trim/strip-trailing-slashes/lowercase; title:
  trim/collapse-whitespace/lowercase). New `src/dedupe.js` holds
  `dealKey`, `selectDeals` (mirrors `formatDigest` exactly: disc ≥ min,
  sort disc desc then savings desc, slice top N — with a
  must-stay-in-sync comment) and `DEDUPE_WINDOW_MS`. `runDigest`
  drops deals posted within 7 days, omits stores with zero new deals,
  and if nothing is new sends NOTHING (no "no deals" spam every 15
  minutes) — return `{sent:0, failed:[], subscribers:<count>,
  messages:0, newDeals:0}`. Keys are marked only if `sent > 0`, so a
  failed or subscriber-less run never burns deals. `npm run
  digest:dry` prints what would be sent and never touches dedupe
  state. Local polling cron moved from `0 9 * * *` to `*/15 * * * *`
  (Asia/Kolkata), matching production. `runDigest` degrades gracefully
  if a store lacks the dedupe methods (treats recent as empty, skips
  marking) so the API tests' fake store still works.
- **Better digest design.** `formatDigest` redesigned (parse_mode
  HTML kept, ≤3900 chars, ≤2 messages, never cut mid-deal): header
  "🛒 PriceDrop Hunter — Fresh Deals" + IST date AND time (new
  exported `istDateTimeLabel`) + terms line "50%+ off · fresh deals
  every 15 minutes · duplicates removed"; one section per store with
  the store name bold; each deal one indivisible line (linked name,
  sell price, `<s>` MRP, discount %). Stores with no deals are omitted
  entirely; empty input → `[]` (no message). Dropped-deals note now
  reads "… +N more deals in the next update". (19 Nov 2026 is a
  Thursday — the brief's "Tue" example was wrong; the label computes
  the real weekday.)
- **Stores on /start and /help.** Both render all 9 stores from the
  ONE shared constant `STORE_ORDER` in `src/feed.js` (via a
  `storeListText()` helper in `src/bot.js`) — no second hardcoded list.
  Both state: free subscription, fresh deals every 15 minutes, only
  50%+ off, duplicates removed, plus the commands. All "9 AM IST /
  every morning / daily" copy is gone from `src/bot.js` and
  `src/digest.js` (including the `/stop` reply). `nextDigestLabel`
  now returns the next 15-minute IST boundary (name and signature
  kept, `digestHourIst` param ignored and documented; also exported
  for tests). `config.digestHourIst` still exists but no longer drives
  anything in `bot.js`.
- **Coordinator merge fixes:** 4 stale "Vercel cron / daily digest"
  comments in `src/index.js` and `src/jobs.js` corrected to the
  GitHub Actions trigger. No code changes beyond comments.
- **Verified (coordinator re-run, merged tree):** `npm install` clean;
  `node --check` clean on all src + api + tests JS; workflow YAML
  parses (schedule `*/15 * * * *`, dispatch, concurrency,
  ubuntu-latest, curl step); **`npm test`: 70 tests, 70 pass, 0 fail**
  (was 39: +6 auth, +16 dedupe/jobs, +3 bot, digest rewritten, plus
  parity/graceful-degradation coverage); `npm run digest:dry` prints
  the new format, 2 messages (3895 + 1468 chars), Croma (empty in
  fixture) omitted, sends nothing; greps clean — no `30 3 * * *` in
  code (only dated history in this report), no literal secret value
  (only `${{ secrets.CRON_SECRET }}` + the fake test value), no
  bot-token pattern, no "9 AM / every morning / Daily Digest" in
  src/ or api/, no `better-sqlite3` reintroduction (only the
  pre-existing `:memory:` comment in `src/db.js` + dated history
  below). Full evidence at the bottom of this report.
- **Not done / honest note:** NOTHING pushed, NOT deployed, NO
  secrets created — the parent pushes to main (auto-deploys on
  Vercel), creates `CRON_SECRET` in both places, and verifies with a
  manual `workflow_dispatch` run. And the live digest STILL sends
  nothing until the 9 scanner `feed` branches exist
  (`scanner-patches/` staged, not applied) — the 15-minute runs will
  200 with `sent:0` until then, which is correct behaviour, not a
  failure.

## 2026-11-19: Vercel + Turso adaptation (superseded the same evening by the 15-minute change above — kept as history)

**What changed:** on 2026-11-19 Satyam picked **Vercel + Turso (free)**
as the hosting, after saying something already runs on his Oracle
account (Oracle is out). The free bot was adapted from a local SQLite
file + polling server to Vercel serverless + hosted Turso:

- **DB layer:** `better-sqlite3` (local `data/subscribers.db`) replaced
  by `@libsql/client` (Turso). `src/db.js` is now async (`await
  initDb(url)`, all methods async) with the same subscribers schema and
  the same method contracts; `config.databaseUrl` resolves to
  `TURSO_DATABASE_URL` when set, else a local `file:<DATABASE_PATH>`
  fallback (local dev needs no Turso account). New required-in-production
  vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (config throws in
  webhook mode without Turso, and for a remote URL without a token).
  One real bug found at merge: libsql's `file::memory:?cache=shared`
  shares state between clients in one process, so test stores leaked
  rows into each other (4 tests failed); `:memory:` now maps to
  `file::memory:?cache=private`, which is isolated per store — matching
  the old better-sqlite3 semantics. A second merge fix: the two
  `initDb` call sites (`src/index.js`, `api/_bot.js`) now pass
  `config.tursoAuthToken` as the second argument — without it a remote
  Turso client would fail auth.
- **Vercel shape:** new `api/webhook.js` (Telegram webhook receiver —
  POST only, 405 otherwise, malformed updates still answer 200 so
  Telegram never retry-storms, init failure answers 500),
  `api/cron-digest.js` (Vercel Cron — calls the same shared
  `runDigest` from `src/jobs.js`, no duplicated send logic), and
  `api/_bot.js` (shared lazy `getBot()` with a test seam
  `__setTestOverrides`). `vercel.json` has exactly one cron:
  `/api/cron-digest` at `30 3 * * *` (= 09:00 IST; Hobby allows one
  cron/day and the digest runs once/day). `src/index.js` stays the
  local-dev entry (polling); the node-cron digest job now only starts
  in polling mode — in webhook mode `startJobs` schedules nothing, so
  the digest can never double-send.
- **Removed:** `render.yaml` (Render), `deals-subscription-bot.service`
  (Oracle/systemd), `Dockerfile` (old polling container with a local
  SQLite volume — stale for serverless). The repo has no deploy file
  left except `vercel.json`.
- **Verified (coordinator re-run, merged tree):** `npm test` **39 tests,
  39 pass, 0 fail** (33 pre-existing + 6 new API tests); `node --check`
  clean on all src + api + tests JS; `npm run digest:dry` still prints
  the same 2-message fixture digest (3891 + 1468 chars), sends nothing;
  `vercel.json` parses with exactly the cron above; config fail-fast
  verified live (webhook-without-Turso throws, remote-URL-without-token
  throws, webhook+Turso loads); polling smoke with a dummy token fails
  only at Telegram `getMe` on network (VM egress), no code error;
  secret grep clean; `package-lock.json` has 0 `better-sqlite3`
  matches. Full evidence at the bottom of this report.
- **Not done:** no Vercel deploy, no Turso database created, no live
  Turso round-trip (no credentials exist yet), no live Telegram
  round-trip. First deploy still needs his `BOT_TOKEN`, the Turso DB +
  token, and the Vercel project import — see "What still needs him".

## 2026-11-19: payment removed — free subscription

**What changed:** on 2026-11-19 Satyam changed his mind — the subscription
is **free for now**. The whole payment flow was removed from the bot, the
docs and the config:

- **Removed:** the ₹49/month price (`PRICE_MONTHLY_PAISA`), the 30-day
  plan (`PLAN_DAYS`), the 3-day free trial (`TRIAL_DAYS`), the UPI
  payment step (`UPI_ID`, `UPI_PAYEE`), the `upi://` payment URI and QR
  code, payment-proof collection (screenshot / UTR), and the admin
  Approve/Reject flow. The `payments` table and `src/payments.js` are
  gone with it.
- **Kept, unchanged:** free subscribe (`/start` → Subscribe), the daily
  9 AM IST digest (top 5 deals per store, ≥50% off), the feed-branch
  design (scanners publish `deals.json` to `feed` branches, the bot
  fetches the raw URLs), the admin commands (`/subscribers`,
  `/broadcast`, `/myid`), `/stop`, and the hosting options
  (systemd/polling on a 24/7 server, webhook on Render free tier).
- **Why:** he decided to launch free first and add payment later if the
  bot proves useful, instead of gating the digest behind a manual UPI
  payment from day one.
- **What this means for him:** a UPI ID is **no longer needed**. The
  only things still needed from him are the bot token (from @BotFather)
  and the hosting pick — see "What still needs him" below.

**History — the paid MVP (2026-11-10, superseded):** the first version
sold the subscription at ₹49/month with a 3-day free trial, paid by
manual UPI (the bot showed his UPI ID + a QR code, the subscriber sent a
screenshot or UTR as proof, and he approved or rejected each payment by
hand, activating 30 days on approval). That design was built, merged and
verified (33 tests passing, dry-run digest from fixtures), but it was
never pushed, deployed, or used with real money — and on 2026-11-19 it
was replaced by the free version described above. The paid design is
recorded here only as history; nothing in this report or the README is a
live instruction to collect payment.

**Future note — paid plans can come back:** if the free bot works and he
wants to charge later, paid plans (manual UPI, or Razorpay for automatic
verification) can be added back behind a plan gate — e.g. a `PLAN_*`
config set, a paywall state for lapsed subscribers, and the old
approve/reject flow reintroduced as an admin step. None of that is built
now; this is only the path, noted so the rework does not have to be
designed from scratch.

---

## What the free bot is (current state, 2026-11-19)

Same stack minus the payment pieces: Node 20, Telegraf,
@libsql/client (Turso), node-cron. No TypeScript. The payment module, the
payment-proof handling, the expiry jobs and the price/plan config are
removed; the digest, feed fetching, subscriber store and
admin commands are unchanged. The Vercel + Turso adaptation landed
2026-11-19 (see the top section): `npm test` 39/39 green, digest
dry-run 2 messages (3891 + 1468 chars) from fixtures, removal greps
clean. The README and `.env.example` in this repo describe the free bot
on Vercel + Turso.

| File (free bot, Vercel + Turso) | What it does |
|---|---|
| `src/index.js` | Entry for local dev / polling ONLY — Vercel does not use it |
| `src/config.js` | Single env reader; throws on missing required vars; all defaults in one place |
| `src/db.js` | Turso store (`@libsql/client`): subscribers table, all contract methods (async) |
| `src/bot.js` | /start, /help, /status, /stop, /myid, /subscribers, /broadcast (admin-only); free Subscribe flow |
| `api/_bot.js`, `api/webhook.js`, `api/cron-digest.js` | Vercel serverless: shared lazy bot, Telegram webhook receiver, 15-min digest endpoint (GitHub Actions trigger, gated on `CRON_SECRET`) |
| `vercel.json` | No crons (`{}`) — digest triggered by GitHub Actions, not a Vercel cron |
| `.github/workflows/digest-15min.yml` | GitHub Actions: POSTs to `/api/cron-digest` every 15 min + manual dispatch |
| `src/dedupe.js` | Deal keys + 7-day dedupe filter (`posted_deals`) used by `runDigest` |
| `src/feed.js` | Fetches the 9 store `deals.json` feeds (10 s timeout each; one failed store = empty list + warning, never crashes the digest); `FEED_URLS` override; fixture loader |
| `src/digest.js` | Formats the digest: IST date+time header, top 5/store ≥ MIN_DISCOUNT, per-deal `title — ₹price <s>₹mrp</s> (disc% off) — store` with link, stores with no deals omitted, empty digest → no message, HTML-escaped, split into ≤2 messages of ≤3900 chars, never cut mid-deal |
| `src/jobs.js` | node-cron, Asia/Kolkata: digest every 15 minutes (fetch → dedupe → send) — polling/local mode only; webhook mode schedules nothing |
| `src/*.test.js` + `tests/api.test.js` | Tests, `node:test`, all stubbed (no network, no real token, no live Turso) |
| `fixtures/deals.json` | Realistic stub deals, 9 stores, 40 deals, Croma empty, one 95% deal |
| `scripts/dry-run-digest.js` | `npm run digest:dry` — prints the formatted digest from fixtures, sends nothing |
| `scanner-patches/` | `--json` diffs + PATCH-NOTES per scanner repo, `deals-feed.yml` workflow template, README |
| `.env.example`, `README.md`, `.gitignore` | 12 env vars (blanks for required); end-to-end setup; ignores `.env`, `data/`, `node_modules/` |

## Architecture in words (free bot)

```
9 scanner repos (GitHub Actions, every 30 min)
  └─ once a day 08:30 IST: deals-feed.yml runs scanner --json,
     commits deals.json to the repo's `feed` branch
        └─ raw.githubusercontent.com/stymrj/<Repo>/feed/deals.json (public)
              └─ subscriber bot (every 15 min): fetch 9 feeds → drop deals
                   sent in the last 7 days → format → send only new deals
                   (nothing if none new)
User → /start → Subscribe (free, nothing to pay)
  → subscriber, digest every 15 minutes (new deals only)
  → /stop anytime to stop the digest; /start → Subscribe to re-join
Admin → /subscribers (counts) • /broadcast (message all subscribers)
```

## Digest-feed decision: option (b) — feed branches, bot only reads

The 9 scanners currently send straight to Telegram and keep no shared deal store. Options considered: (a) subscriber bot runs the scanner code itself; (b) scanners publish a daily `deals.json` to a `feed` branch, bot fetches the 9 public raw URLs; (c) vendor scanner code into this repo.

**Picked (b).** Rationale: platform session cookies stay in GitHub Secrets where they already are — the host running the subscriber bot needs **no** platform cookies, only its own `BOT_TOKEN`. Scanners keep running exactly as they do today; the only scanner change is a minimal `--json` mode (skip Telegram sends, skip state writes, print `{store, generatedAt, deals}` as the last stdout line, top 20 by discount, disc ≥ MIN_DISCOUNT). Validated against the real scanner code: `--json` is feasible for **all 9 repos**, none infeasible. The 6 Node `core.js` repos share one diff shape (3 md5 variants, byte-identical patch anchors); Zepto/Swiggy `bot-v2` and JioMart Python each have their own small equivalent. All 9 diffs were re-verified by the coordinator: `patch -p1 --dry-run` applies cleanly on pristine copies, patched files pass `node --check` / `py_compile`.

Coverage caveats (from worker 2, not blockers): Zepto feed covers only 5 staples sub-categories + Blockbuster; Swiggy's per-campaign floors are 60–85%, so few 50–59% Swiggy deals appear; `--json` uses the single 50% env floor, ignoring per-group 60% floors; JioMart drops the pincode tag. The `deals-feed.yml` template (cron `0 3 * * *` = 08:30 IST, `BOT_ENABLED` gate, force-push `feed` branch) is in `scanner-patches/`.

## Coordinator merge fixes (2026-11-10 build — history; workers built in parallel, reconciled)

1. **`startJobs` signature mismatch** — worker 1's `index.js` called `startJobs({bot, store, config, …})` (object); worker 2 exports `startJobs(bot, db, config)` (positional). Fixed `index.js` to the positional call; jobs now stop cleanly on shutdown.
2. **Missing config keys** — worker 1's `config.js` parsed neither `WEBHOOK_URL` nor `FEED_URLS`. Added both + fail-fast: webhook mode without `WEBHOOK_URL` throws a clear error; invalid `BOT_MODE` throws. Standardised on `WEBHOOK_URL` (worker 1 had used `WEBHOOK_DOMAIN`); `index.js` now derives the bare domain from it and registers the webhook at `<WEBHOOK_URL>/telegram` (hookPath `/telegram`).
3. **Missing `db.updateSubscriber`** — worker 2's expiry check needs it to persist `renewal_reminded_at` / `expired_noticed_at` / `status:'expired'`. Added (allowlisted fields only). Verified: persists correctly in `:memory:` DB. (Removed again in the 2026-11-19 free rework, with the expiry check itself.)
4. **Merged `package.json`** — union of both workers' deps (`better-sqlite3 ^12.11.1` — v12, not v11: v11 has no prebuilt binary for the Node 24 runtime here and its source build fails; `node-cron` added), scripts `start` / `dev` / `test` (`node --test tests/*.test.js`) / `digest:dry`. Ran `npm install` once in the merged tree so `package-lock.json` exists (`npm ci` in Dockerfile/render.yaml needs it).
5. **`/stop` was promised but missing** — the digest footer said "Stop anytime with /stop" but no handler existed. Implemented `/stop` in `bot.js` (active subscriber → status expired, digest stops immediately; no active subscription → polite reply) + a test.

## Env vars (free bot on Vercel + Turso — names only, no values anywhere)

Required (blank in `.env.example`, bot refuses to start without them): `BOT_TOKEN` (from @BotFather), `ADMIN_ID` (via the bot's `/myid`). Required in production (webhook mode): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (remote Turso URL only — a `file:` URL needs no token), `CRON_SECRET` (shared secret authorising the digest endpoint — same value in the Vercel env var AND the GitHub repo secret; optional locally, where only `x-vercel-cron` calls pass). Optional with defaults: `MIN_DISCOUNT=50`, `DIGEST_TOP_PER_STORE=5`, `DIGEST_HOUR_IST=9` (no longer drives the digest — kept for compatibility), `BOT_MODE=polling`, `PORT=3000`, `DATABASE_PATH=./data/subscribers.db` (local-dev file fallback only), `FEED_URLS` (blank = built-in 9-store list), `WEBHOOK_URL` (webhook mode only). Removed 2026-11-19: `UPI_ID`, `UPI_PAYEE`, `PRICE_MONTHLY_PAISA`, `PLAN_DAYS`, `TRIAL_DAYS`.

## Setup steps for Satyam (full detail in README.md)

1. @BotFather → /newbot → copy the token into `BOT_TOKEN`.
2. Copy `.env.example` → `.env`; fill `ADMIN_ID` (message the bot `/myid` once running, or @userinfobot).
3. Local test: `npm install`, `npm run dev`, test with a second Telegram account (/start → Subscribe, free → /status → /stop → re-subscribe; admin: /subscribers, /broadcast). Locally the bot uses a file DB — no Turso needed.
4. Deploy — Vercel + Turso (full detail in README.md sections (g)–(h)): create the Turso database (`turso db create`, `turso db show --url`, `turso db tokens create`); import the repo into Vercel; set `BOT_TOKEN`, `ADMIN_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BOT_MODE=webhook`, `WEBHOOK_URL` (set after the first deploy, then redeploy), `CRON_SECRET` (same value ALSO as the GitHub repo secret); verify with `getWebhookInfo` + `/start` + a manual `workflow_dispatch` run of "Digest (every 15 min)" (expect green + `{"ok":true,...}`). Oracle is NOT available (2026-11-19: something already runs on the Oracle account); the Render/systemd/Docker deploy files were removed in the Vercel adaptation.
5. Scanner side (separate step, not done here): apply the `scanner-patches/` `--json` diffs + add `deals-feed.yml` to each of the 9 scanner repos, so the `feed` branches start publishing. Until then the bot's digest has no live feed — test with `npm run digest:dry` (fixtures).

## What still needs him (exact missing inputs)

- **Bot token** — he creates the bot with @BotFather.
- **Hosting — DECIDED 2026-11-19: Vercel + Turso (free).** Still to do at deploy time: create the Turso database + auth token, import the repo into Vercel, set the env vars (`BOT_TOKEN`, `ADMIN_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BOT_MODE=webhook`, `WEBHOOK_URL`), redeploy, verify `getWebhookInfo` + `/start` + the first cron run. The parent is handling the Vercel login (Google) and deploy after this adaptation. Oracle is NOT available (2026-11-19: something already runs on the Oracle account); Render/systemd/Docker paths were removed.
- **Scanner patches** — staged diffs only, NOT applied to the scanner repos and NOT pushed; applying them is a separate step (9 small patches + 1 workflow file each).
- **Admin id** — fetched via `/myid` once the bot runs.
- **NOT needed anymore: UPI ID + payee name.** Payment was removed 2026-11-19 — do not ask him for these.

## Test evidence (2026-11-19 Vercel + Turso build — superseded the same evening by the 15-minute change at the top: 70/70 green)

- `npm install` clean (merged tree, `package-lock.json` regenerated: +22 / −38 packages, `better-sqlite3` → `@libsql/client ^0.15.0`); `node --check` clean on all src + api + tests JS files.
- `npm test`: **39 tests, 39 pass, 0 fail** — the 33 free-build tests (migrated to the async store) plus 6 new API tests (webhook POST /start end-to-end through real `createBot` + fake async store → 200; non-POST → 405; malformed bodies → 200 with zero outbound calls; init failure → 500; cron runs the fixture digest → `{sent:1, failed:[], subscribers:1, messages:2}` with both texts byte-identical to `formatDigest(loadFixture())`; vercel.json shape). Two merge bugs were found and fixed by the coordinator: (1) libsql `file::memory:?cache=shared` shares state between clients in one process — 4 bot tests failed on leaked rows until `:memory:` was mapped to `cache=private` (verified isolated with a throwaway probe); (2) both `initDb` call sites were missing the auth-token argument — now passed as `config.tursoAuthToken`.
- Dry-run digest (`npm run digest:dry`, `DIGEST_DATE=2026-11-10`, fixtures): **2 messages, 3891 + 1468 chars, not sent** — unchanged from the free build.
- `vercel.json` parses: exactly one cron, `/api/cron-digest` at `30 3 * * *` (= 09:00 IST).
- Config fail-fast verified live: `BOT_MODE=webhook` without `TURSO_DATABASE_URL` throws; remote Turso URL without `TURSO_AUTH_TOKEN` throws; webhook + Turso URL + token loads with `databaseUrl` = the Turso URL.
- Polling smoke with a dummy token: bot loads, wires jobs, fails only at Telegram `getMe` with a network error (VM egress), no code error.
- Secret grep: clean — only env-var names and blank `.env.example` values. `package-lock.json` has 0 `better-sqlite3` matches. `render.yaml`, `deals-subscription-bot.service`, `Dockerfile` confirmed deleted.
- History — test evidence for the superseded builds is below, kept for the record.

## Test evidence (2026-11-19 free build — superseded by the Vercel build above)

- `npm install` clean (merged tree, `package-lock.json` regenerated without `qrcode`); `node --check` clean on all src + tests JS files.
- `npm test`: **33 tests, 33 pass, 0 fail** on the free build — free subscribe (instant + idempotent re-tap), `/stop` both cases, `/status` Free wording with no price/expiry text, photo → "no payment needed" (subscribed and unsubscribed, no admin forward), `trial` and `approve:`/`reject:` callbacks inert, admin Active vs Stopped counts + admin-only broadcast, digest top-5/filter/split/no-deals, `runExpiryCheck` absent, `startJobs` creates exactly one cron job (digest only). Two first-run failures were bugs in the new tests themselves, fixed in the tests.
- Dry-run digest (`npm run digest:dry`, `DIGEST_DATE=2026-11-10`, fixtures): **2 messages, 3891 + 1468 chars, not sent** — same 2-message shape as the paid build (char counts shifted slightly because the header changed to the free wording). Amazon 5, Blinkit 3, Flipkart 4, BigBasket 5, Myntra 5 (incl. a Roadster tee, 95% off), Croma "no deals above 50% today", Zepto 4 across both messages, Swiggy 3, JioMart 5. The 48% Parle-G correctly filtered out.
- Removal greps (coordinator): no `UPI`, `upi://`, `PRICE_`, `TRIAL`, `qrcode` in src/ + tests/ except negative-test probes asserting those things do NOT exist; no `approve:`/`reject:` handlers, no payments table/methods, no `expires_at`; `src/payments.js` deleted; `qrcode` absent from package.json. Allowed "payment" mentions: the user-facing "No payment needed…" photo replies and the "Free subscription — no payment, no expiry" welcome line.
- History: the 2026-11-10 paid build was also verified 33/33 green with a 2-message dry-run digest (3761 + 1610 chars) before it was replaced; that evidence is superseded, not lost.
- Scanner patches: all 9 `patch -p1 --dry-run` apply cleanly on pristine copies; patched files pass `node --check` / `py_compile`. (One coordinator dry-run initially failed for the 6 core.js diffs because the test harness put `core.js` at the wrong path — harness error, not a patch error; re-run with the correct `bot/core.js` layout passed.)
- Webhook fail-fast: `BOT_MODE=webhook` without `WEBHOOK_URL` throws `BOT_MODE=webhook requires WEBHOOK_URL…` before launching.
- Polling smoke with a dummy token: bot loads, wires jobs, and fails only at Telegram `getMe` with a network/SSL error (VM egress proxy) — no code error. Live Telegram was not reachable from the VM.
- `render.yaml` parses (1 service); `systemd-analyze verify` on the unit exits 0 (worker 3's run caught a real misplaced-directive bug, fixed).
- Secret grep: clean — only env-var names and blank `.env.example` values. `BOT_TOKEN` line verified byte-empty (`od -c`: `BOT_TOKEN=\n`).

## What could NOT be verified / is NOT built

- No live Vercel deploy and no live Turso round-trip (no credentials exist yet): the webhook/cron paths are verified only through stubbed harnesses (fake async store, patched `callApi`, stubbed fetch). The first real deploy needs `BOT_TOKEN`, `ADMIN_ID`, `BOT_MODE=webhook`, `WEBHOOK_URL`, and the Turso vars set in Vercel, plus registering the webhook URL with Telegram. A remote Turso `libsql://` connection has never been opened from this code — only constructed.
- No live Telegram round-trip (no real token exists yet): polling launch, real Subscribe tap, real admin `/broadcast` are verified only through stubbed `handleUpdate` tests.
- No live feed: no `feed` branch exists yet (patches not applied); digest tested from fixtures only. No live GitHub Actions run of `deals-feed.yml`.
- No `maxDuration` set on the digest function in `vercel.json` (deliberate — the plan's ceiling can't be verified without a Vercel account; if a digest run ever times out, add `"functions": {"api/cron-digest.js": {"maxDuration": 60}}`). The GitHub Actions workflow gives curl `--max-time 300`.
- No `GET /healthz` endpoint. The `x-vercel-cron` header is accepted as an auth signal on `/api/cron-digest` (anyone can send it) alongside the `CRON_SECRET` — an unauthenticated hit without either is 401; a spoofed `x-vercel-cron` hit can at worst trigger one extra digest send.
- **NOT built (upgrade paths):** paid plans — manual UPI or Razorpay/Telegram Payments auto-payments — can be added back later behind a plan gate (see the 2026-11-19 note at the top); per-deal price-drop tracking ("alert me when this exact product falls below ₹X") — keyword watch alerts cover titles, not prices. Vercel Hobby is non-commercial — if paid plans return, the project belongs on Vercel Pro.
