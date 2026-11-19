# Telegram Subscription Bot — report

## 2026-11-19: Vercel + Turso adaptation (current state)

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
| `api/_bot.js`, `api/webhook.js`, `api/cron-digest.js` | Vercel serverless: shared lazy bot, Telegram webhook receiver, daily digest cron |
| `vercel.json` | Vercel Cron: `/api/cron-digest` at `30 3 * * *` (= 09:00 IST) |
| `src/feed.js` | Fetches the 9 store `deals.json` feeds (10 s timeout each; one failed store = empty list + warning, never crashes the digest); `FEED_URLS` override; fixture loader |
| `src/digest.js` | Formats the daily digest: IST date header, top 5/store ≥ MIN_DISCOUNT, per-deal `title — ₹price <s>₹mrp</s> (disc% off) — store` with link, `<store>: no deals above 50% today` lines, HTML-escaped, split into ≤2 messages of ≤3900 chars, never cut mid-deal |
| `src/jobs.js` | node-cron, Asia/Kolkata: digest 09:00 IST (fetch-then-send inside the one job) — polling/local mode only; webhook mode schedules nothing |
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
              └─ subscriber bot (09:00 IST): fetch 9 feeds → format digest
                   → send to every subscriber
User → /start → Subscribe (free, nothing to pay)
  → subscriber, digest every morning 09:00 IST
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

Required (blank in `.env.example`, bot refuses to start without them): `BOT_TOKEN` (from @BotFather), `ADMIN_ID` (via the bot's `/myid`). Required in production (webhook mode): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (remote Turso URL only — a `file:` URL needs no token). Optional with defaults: `MIN_DISCOUNT=50`, `DIGEST_TOP_PER_STORE=5`, `DIGEST_HOUR_IST=9`, `BOT_MODE=polling`, `PORT=3000`, `DATABASE_PATH=./data/subscribers.db` (local-dev file fallback only), `FEED_URLS` (blank = built-in 9-store list), `WEBHOOK_URL` (webhook mode only). Removed 2026-11-19: `UPI_ID`, `UPI_PAYEE`, `PRICE_MONTHLY_PAISA`, `PLAN_DAYS`, `TRIAL_DAYS`.

## Setup steps for Satyam (full detail in README.md)

1. @BotFather → /newbot → copy the token into `BOT_TOKEN`.
2. Copy `.env.example` → `.env`; fill `ADMIN_ID` (message the bot `/myid` once running, or @userinfobot).
3. Local test: `npm install`, `npm run dev`, test with a second Telegram account (/start → Subscribe, free → /status → /stop → re-subscribe; admin: /subscribers, /broadcast). Locally the bot uses a file DB — no Turso needed.
4. Deploy — Vercel + Turso (full detail in README.md sections (g)–(h)): create the Turso database (`turso db create`, `turso db show --url`, `turso db tokens create`); import the repo into Vercel; set `BOT_TOKEN`, `ADMIN_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BOT_MODE=webhook`, `WEBHOOK_URL` (set after the first deploy, then redeploy); verify with `getWebhookInfo` and a `/start`; check the Cron Job run after the first 9 AM IST digest. Oracle is NOT available (2026-11-19: something already runs on the Oracle account); the Render/systemd/Docker deploy files were removed in the Vercel adaptation.
5. Scanner side (separate step, not done here): apply the `scanner-patches/` `--json` diffs + add `deals-feed.yml` to each of the 9 scanner repos, so the `feed` branches start publishing. Until then the bot's digest has no live feed — test with `npm run digest:dry` (fixtures).

## What still needs him (exact missing inputs)

- **Bot token** — he creates the bot with @BotFather.
- **Hosting — DECIDED 2026-11-19: Vercel + Turso (free).** Still to do at deploy time: create the Turso database + auth token, import the repo into Vercel, set the env vars (`BOT_TOKEN`, `ADMIN_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BOT_MODE=webhook`, `WEBHOOK_URL`), redeploy, verify `getWebhookInfo` + `/start` + the first cron run. The parent is handling the Vercel login (Google) and deploy after this adaptation. Oracle is NOT available (2026-11-19: something already runs on the Oracle account); Render/systemd/Docker paths were removed.
- **Scanner patches** — staged diffs only, NOT applied to the scanner repos and NOT pushed; applying them is a separate step (9 small patches + 1 workflow file each).
- **Admin id** — fetched via `/myid` once the bot runs.
- **NOT needed anymore: UPI ID + payee name.** Payment was removed 2026-11-19 — do not ask him for these.

## Test evidence (2026-11-19 Vercel + Turso build — current; coordinator re-run, merged tree)

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
- No `maxDuration` set on the cron function in `vercel.json` (deliberate — the plan's ceiling can't be verified without a Vercel account; if a cron run ever times out, add `"functions": {"api/cron-digest.js": {"maxDuration": 60}}`).
- No `GET /healthz` endpoint. The `x-vercel-cron` header is NOT treated as authentication (anyone can send it) — an unauthenticated hit on `/api/cron-digest` can at worst trigger one extra digest send; noted in the code.
- **NOT built (upgrade paths):** paid plans — manual UPI or Razorpay/Telegram Payments auto-payments — can be added back later behind a plan gate (see the 2026-11-19 note at the top); instant 90%+ deal alerts (v2 — digest only for now); multi-plan pricing (no plans at all while the subscription is free). Vercel Hobby is non-commercial — if paid plans return, the project belongs on Vercel Pro.
