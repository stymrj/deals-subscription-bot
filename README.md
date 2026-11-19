# Deals Subscription Bot 🤖

A Telegram bot that gives anyone a **free subscription** to a digest of
the best PriceDrop Hunter deals (50%+ off) across Amazon, Blinkit,
Flipkart Minutes, BigBasket, Zepto, Swiggy Instamart, Myntra, Croma and
JioMart. No payment, no expiry — subscribe once and fresh deals arrive
**every 15 minutes**, with duplicates removed (a deal is never sent
twice within 7 days).

Hosting: **Vercel (free Hobby) + Turso (free)** — the bot runs as Vercel
serverless functions (webhook for messages, digest endpoint), subscribers
live in a hosted Turso (SQLite) database, and a **GitHub Actions
workflow** calls the digest endpoint every 15 minutes (Vercel Hobby
cron allows at most one run a day, so it cannot drive a 15-minute
cadence). No server to manage, nothing sleeps.

> ⚠️ **Honest status: the bot is live, the feed is not.** The bot is
> deployed at https://deals-subscription-bot.vercel.app with the webhook
> connected and the 15-minute workflow ready — but no scanner `feed`
> branch exists yet, so the live digest currently finds no deals and
> sends nothing. Until the `scanner-patches/` are applied (see (i)),
> test with `npm run digest:dry` (fixtures).

---

## (a) What this bot is, and how the free subscription works

In plain words:

1. **Someone finds your bot on Telegram and taps `/start`.** They get a
   welcome message with a **Subscribe** button.
2. **They tap Subscribe — that is all.** The subscription is free: no
   payment and no expiry date.
3. **Every 15 minutes** they get a digest message — but only when there
   are new deals: the top 5 deals per store, only deals at 50% off or
   more, with the price, discount and link. A deal already sent in the
   last 7 days is never sent again, and if nothing new dropped since
   the last run, nothing is sent at all (no empty "no deals" spam).
4. **They can stop anytime** with `/stop` — the digest stops immediately.
   They can re-subscribe anytime with `/start` → Subscribe.
5. **They can check their subscription** with `/status`.
6. **They can pick their stores** with `/stores` — an inline keyboard
   with ✅/❌ toggles for each of the 9 stores. The digest then only
   covers their enabled stores.
7. **They can set their own discount threshold** with
   `/setdiscount <10-90>` — e.g. `/setdiscount 30` gets deals at 30%+
   off instead of the default 50%. `/status` shows the threshold.
8. **They can ask for deals on demand** — `/deals` shows the current
   top deals right now (their stores + threshold), `/top` shows the
   single best deal right now. On-demand sends never consume deals
   from the digest stream (no dedupe writes).
9. **They can watch keywords** — `/watch <keyword>` (max 10), and
   whenever a new deal's title contains that keyword, they get a
   separate 🔔 alert in addition to the digest, once per deal.
   `/unwatch <keyword>` removes one, `/watchlist` lists them.

You are the only admin. Only your account (the `ADMIN_ID`) can use the
admin commands — `/subscribers` and `/broadcast` (see (j)). Nobody else
can message all subscribers.

---

## (b) Create the bot with @BotFather and get BOT_TOKEN

1. Open Telegram and search for **@BotFather** (the verified one, with the
   blue tick).
2. Send `/newbot`.
3. BotFather asks for a **name** (shown to users, e.g. `PriceDrop Hunter
   Deals`) and then a **username** (must end in `bot`, e.g.
   `pricedrop_hunter_deals_bot`). If the username is taken, try another.
4. BotFather replies with a message containing your **token** — a long
   string like `123456789:AAE…` (yours will differ). **That is
   your `BOT_TOKEN`.** Keep it secret like a password: anyone with it can
   control your bot.
5. Optional, still in BotFather: `/setdescription` (a one-line "what this
   bot does") and `/setabouttext`. Skip this if you like — the bot works
   without it.

---

## (c) Get your ADMIN_ID via the bot's /myid command

1. First finish (e) below and start the bot once (locally is fine).
2. Open Telegram and message **your own bot** (the username from step (b)).
3. Send `/myid`.
4. The bot replies with your numeric Telegram user ID, e.g. `123456789`.
   That number is your **`ADMIN_ID`**. Put it in `.env` and restart the
   bot — until then, the admin commands (`/subscribers`, `/broadcast`)
   have no admin to run as.

> If `/myid` does not answer, the bot is not running or `BOT_TOKEN` is
> wrong — see troubleshooting (k).

---

## (d) No payment, no price — the subscription is free

There is nothing to set up for payment, because there is none. The bot
collects no money and has no price and no expiry:

- There are **no payment-related environment variables**. If you see an
  old guide or an old `.env` mentioning payment details or a monthly
  price, it is from the earlier paid design — ignore it. The
  current `.env.example` has no such variables.
- Subscribers never pay anything and are never asked to. There is no
  renewal and no expiry to manage.
- Paid plans (manual payment / Razorpay) can be added back later behind a
  plan gate — that is a future step, not this bot (see REPORT.md).

---

## (e) Every environment variable

Copy `.env.example` to `.env` and fill it in. Required variables have no
default — the bot exits with `Missing required env var: <NAME>` if one is
blank. Optional variables already have defaults in the code; uncomment a
line in `.env` only if you want to change its default.

On Vercel these same variables go in the **Vercel dashboard → Project →
Settings → Environment Variables** (see (h)) — do not commit a `.env`
file to the repo.

| Variable | Required? | Default | Where to get it |
|---|---|---|---|
| `BOT_TOKEN` | Yes | — | @BotFather, after `/newbot` — see (b) |
| `ADMIN_ID` | Yes | — | Your Telegram user ID — send `/myid` to your bot — see (c) |
| `TURSO_DATABASE_URL` | Yes on Vercel; no locally | — | Turso dashboard or CLI: `turso db show <name> --url` — see (g) |
| `TURSO_AUTH_TOKEN` | Yes for a remote Turso DB | — | Turso CLI: `turso db tokens create <name>` — see (g) |
| `CRON_SECRET` | Yes on Vercel; no locally | — | Shared secret that authorises the digest endpoint — create one value and set it in BOTH places: the Vercel env var `CRON_SECRET` AND the GitHub repo secret `CRON_SECRET` (repo → Settings → Secrets and variables → Actions). See (h) step 8 |
| `MIN_DISCOUNT` | No | `50` | Only deals with ≥ this % off enter the digest |
| `DIGEST_TOP_PER_STORE` | No | `5` | Max deals per store in one digest |
| `DIGEST_HOUR_IST` | No | `9` | No longer drives the digest (kept for compatibility) — the digest runs every 15 minutes, triggered by GitHub Actions on Vercel and by a `*/15` cron in local polling mode |
| `BOT_MODE` | No | `polling` | `polling` for local testing; `webhook` on Vercel |
| `PORT` | No | `3000` | HTTP port in webhook mode. Vercel sets it — don't set it there |
| `WEBHOOK_URL` | Only in webhook mode | — | Public base URL of your deployed bot, e.g. `https://deals-subscription-bot.vercel.app` (no trailing slash). The bot registers `<WEBHOOK_URL>/telegram` as its Telegram webhook |
| `DATABASE_PATH` | No | `./data/subscribers.db` | Local-dev only: path of the local SQLite file used when `TURSO_DATABASE_URL` is blank |
| `FEED_URLS` | No | built-in 9-store list | Override the deal feeds: comma-separated `store=url` pairs, no spaces — see (i) |

---

## (f) Run locally for a test

You need **Node.js 20+** installed. Check with `node --version`.
Locally the bot uses polling mode and a **local SQLite file** (no Turso
account needed): leave `TURSO_DATABASE_URL` blank and it falls back to
`file:<DATABASE_PATH>`.

```bash
# 1. Install dependencies (first time only)
npm install

# 2. Copy the env template and fill in the 2 required values
cp .env.example .env
# Edit .env: BOT_TOKEN, ADMIN_ID
# Leave BOT_MODE unset (polling is the default — correct for local testing).

# 3. Start the bot
npm run dev   # or `npm start` — both run the same bot.

# 4. Run the tests (optional but recommended before deploying)
npm test

# 5. Print the digest from fixtures without sending anything
npm run digest:dry
```

**Test it with a second Telegram account** (your main account stays the
admin; the second account plays the subscriber — a friend's phone, or
Telegram on a second device with another number):

1. From the subscriber account, open your bot and send `/start` → you
   should get the welcome message with a Subscribe button.
2. Tap **Subscribe** → the subscription should activate immediately, for
   free. Nothing is charged and nothing is asked for.
3. Send `/status` → it should say the subscription is active.
4. From the **admin** account, send `/subscribers` → it should list the
   subscriber counts, including your test subscriber.
5. From the **admin** account, send `/broadcast` with a short test message
   → the subscriber account should receive it.
6. From the subscriber account, send `/stop` → the digest stops. Send
   `/start` → Subscribe again to confirm re-subscribing works.
7. Stop the bot with `Ctrl+C`. Your test subscribers live in
   `data/subscribers.db` — delete that file before going live so test users
   don't get the real digest. (On Vercel the subscribers live in Turso,
   not in a file — see (j) for how to see them there.)

---

## (g) Create the Turso database (free)

Turso is hosted SQLite — the subscriber list lives there instead of in a
file, because Vercel serverless functions have no persistent disk. The
free tier (5 GB, no card) is far more than this bot needs.

1. Create a Turso account at https://turso.tech (GitHub sign-in works).
2. Install the CLI and log in:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```
3. Create the database (any name, e.g. `deals-subscribers`):
   ```bash
   turso db create deals-subscribers
   ```
4. Get its URL and an auth token (copy both — the token is shown once):
   ```bash
   turso db show deals-subscribers --url
   turso db tokens create deals-subscribers
   ```
   These are your `TURSO_DATABASE_URL` (looks like
   `libsql://deals-subscribers-<username>.turso.io`) and
   `TURSO_AUTH_TOKEN`. The bot creates the `subscribers` table itself on
   first run — there is nothing to create by hand.
5. Keep the token secret like a password: anyone with it can read and
   write your subscriber list.

> Turso free databases are archived after 10 days of inactivity — this
> bot reads/writes the database every 15 minutes (the digest + dedupe
> writes), so it stays active. If you ever stop the bot for weeks,
> re-activate the database in the Turso dashboard before restarting it.

---

## (h) Deploy on Vercel (free Hobby) — step by step

1. Push this repo to GitHub (private repo is fine).
2. Vercel Dashboard → **Add New → Project** → **Import** the repo.
   Framework preset: **Other**. Root directory: the repo root (leave it).
   Build command: leave the default (none needed). **Do not set a
   custom install/build command** — Vercel runs `npm install` itself.
3. In **Environment Variables**, add (all three scopes, or at least
   Production):
   - `BOT_TOKEN` — from (b)
   - `ADMIN_ID` — from (c)
   - `TURSO_DATABASE_URL` — from (g)
   - `TURSO_AUTH_TOKEN` — from (g)
   - `CRON_SECRET` — create one value, set it here AND as a GitHub repo secret (see step 8)
   - `BOT_MODE` = `webhook`
   - `WEBHOOK_URL` — see step 5 (leave it blank for the first deploy;
     the deploy works without it, the bot just can't receive messages yet)
4. Click **Deploy**. Wait for it to finish and copy the domain Vercel
   gives the project, e.g. `https://deals-subscription-bot.vercel.app`.
5. Set `WEBHOOK_URL` to that domain (no trailing slash, no path) in the
   Vercel dashboard → **Settings → Environment Variables**, then
   **Deployments → ⋯ → Redeploy** so the new value takes effect.
6. Register the webhook with Telegram — nothing in the code does this
   on Vercel, so set it by opening this URL in a browser (replace
   `<BOT_TOKEN>` and `<your-domain>` with the real values — never paste
   the reply anywhere public):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-domain>/api/webhook
   ```
   It should reply `{"ok":true,...}`. Then verify with:
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
   ```
   The reply should show `"url": "https://<your-domain>/api/webhook"`
   (the serverless function route — NOT `/telegram`, which only exists
   on the local webhook server).
7. Message the bot `/start` from Telegram. If it replies, the webhook is
   live. If not, see troubleshooting (k).
8. The digest runs **every 15 minutes via GitHub Actions**
   (`.github/workflows/digest-15min.yml` — `*/15 * * * *` plus a manual
   `workflow_dispatch`). It POSTs to
   `https://<your-domain>/api/cron-digest` with the `CRON_SECRET` in the
   `x-cron-secret` header. There is NO Vercel cron anymore (`vercel.json`
   is `{}`) because Vercel Hobby allows at most one cron run per day.
   Before the workflow can succeed, set `CRON_SECRET` to the SAME value
   in both places: (1) the Vercel env var (step 3, then redeploy),
   (2) the GitHub repo secret (repo → Settings → Secrets and variables
   → Actions → New repository secret, name `CRON_SECRET`). Until both
   match, the workflow's calls return 401 and nothing is sent. Verify
   with a manual run: repo → Actions → "Digest (every 15 min)" → Run
   workflow — it should finish green; the Vercel function logs for
   `/api/cron-digest` should show 200 and a JSON body like
   `{"ok":true,"sent":N,...}`. (The endpoint also accepts Vercel's own
   `x-vercel-cron` header, so it keeps working if a Vercel cron is ever
   re-added.)

> **Vercel Hobby is non-commercial use only.** That is fine while the
> subscription is free. If paid plans ever come back, Vercel expects the
> project on Pro ($20/seat/month) — that is a billing decision for then,
> not a code change.

---

## (i) How the 15-minute digest gets its deals (the feed-branch design)

Each of the 9 PriceDrop Hunter scanner repos publishes its latest deals as
a JSON file, and the bot fetches those files every 15 minutes — it does **not**
run the scanners itself.

- Each scanner repo has a GitHub workflow (`deals-feed.yml`) that runs the
  scanner and **commits `deals.json` to a `feed` branch** in that repo.
- The bot fetches the 9 raw files, filters to deals at or above
  `MIN_DISCOUNT` (default 50%), keeps the top `DIGEST_TOP_PER_STORE`
  (default 5) per store, then drops any deal already sent in the last
  7 days (see dedupe below) and sends only the new ones. If nothing is
  new, it sends nothing at all that run.
- **Dedupe (7 days):** every sent deal is recorded in the Turso
  `posted_deals` table (key = store + deal URL, or store + title +
  price when there is no URL). A deal sent within the last 7 days is
  never sent again; after 7 days it may be sent again if it is still
  live. Keys are marked only after at least one subscriber actually
  received the digest, so a failed run never burns deals. `npm run
  digest:dry` prints what would be sent and never touches this table.
- The feed-publishing workflow and any per-repo patches live in the
  **`scanner-patches/`** directory of this repo. They are **staged diffs
  only — not yet applied** to the scanner repos, so no `feed` branch
  exists yet. Until they are applied, the digest has no live feed — test
  with `npm run digest:dry` (fixtures).
- The 9 feeds, by the built-in default:

| Store | Feed URL (default) |
|---|---|
| Amazon | `https://raw.githubusercontent.com/stymrj/Amazon-Now-Deals/feed/deals.json` |
| Blinkit | `https://raw.githubusercontent.com/stymrj/Blinkit-Deals/feed/deals.json` |
| Flipkart Minutes | `https://raw.githubusercontent.com/stymrj/Flipkart-Minute-Deals/feed/deals.json` |
| BigBasket | `https://raw.githubusercontent.com/stymrj/BigBasket-Deals/feed/deals.json` |
| Zepto | `https://raw.githubusercontent.com/stymrj/Zepto-Deals/feed/deals.json` |
| Swiggy Instamart | `https://raw.githubusercontent.com/stymrj/Swiggy-Instamart-Deals/feed/deals.json` |
| Myntra | `https://raw.githubusercontent.com/stymrj/Myntra-Deals/feed/deals.json` |
| Croma | `https://raw.githubusercontent.com/stymrj/Croma-Deals/feed/deals.json` |
| JioMart | `https://raw.githubusercontent.com/stymrj/JioMart-Deals/feed/deals.json` |

- **Override:** set `FEED_URLS` to a comma-separated list of
  `store=url` pairs (no spaces) to replace the built-in list — useful for
  testing one store, or pointing at a different branch.
- **If a store's feed is stale or missing** (its workflow failed, or the
  `feed` branch was never created), that store is simply skipped in that
  run's digest — the other stores still go out. Check the Vercel
  function logs for a fetch error naming the store.

> Status: **not yet verified live.** No `feed` branch exists yet, so the
> URLs above are the *designed* locations, not fetched-and-confirmed ones.
> The first live check is: open one URL in a browser — it should show JSON
> with recent deals. If it 404s, the feed workflow for that store is not
> publishing yet.

---

## (j) Day-to-day running: subscribers and broadcasts

These are the admin flows. There is no payment flow to manage: nobody
pays, nothing expires, and there are no approvals.

- **See subscribers:** send `/subscribers` from the admin account (the
  `ADMIN_ID` account). The bot replies with the subscriber counts. Anyone
  else who sends it gets an admin-only reply. The full subscriber list
  lives in Turso — look at it with the Turso CLI:
  `turso db shell deals-subscribers "SELECT user_id, name, username, status FROM subscribers;"`
  (or the Turso dashboard). Back it up with
  `turso db dump deals-subscribers > subscribers-backup.sql` (do it
  weekly, and before any upgrade).
- **Broadcast a message to all subscribers:** send `/broadcast` from the
  admin account, followed by the message text. Use it sparingly (one
  message, only for something subscribers need — e.g. a digest outage).
  **Do not broadcast by hand from your personal account** — you don't
  have the subscriber list in Telegram.
- **A subscriber stops:** they send `/stop` themselves and the digest
  stops immediately. They can re-subscribe anytime with `/start` →
  Subscribe. There is nothing for you to do.
- **Your own ID:** `/myid` replies with the sender's numeric Telegram
  user ID — that is how you found your `ADMIN_ID` in (c).

---

## (k) Troubleshooting

| Problem | What to check |
|---|---|
| **Bot does not reply to `/start`** | Vercel dashboard → Deployments → the latest deployment → **Functions** logs: is there an error on `/api/webhook`? First suspects: a wrong `BOT_TOKEN` (copy it again from @BotFather), a missing required env var (the log says `Missing required env var: ...`), or `WEBHOOK_URL` still blank / wrong (see step (h)5–6 — run `getWebhookInfo` and check the URL is `https://<your-domain>/api/webhook`). Also: did you message the right bot username? Locally: is `node src/index.js` still running with no error? |
| **Bot worked, then stopped replying** | Vercel: did the latest deploy fail, or did an env var change without a redeploy? (Env changes need a redeploy to take effect.) Check the Functions logs for the last `/api/webhook` call. Telegram retries undelivered updates for a while, then drops them — a deploy that was down for hours may need a fresh `/start` from the user. |
| **Webhook vs polling confusion** | Only ONE mode may be active. `BOT_MODE=polling` = the bot fetches updates itself; correct locally, **wrong on Vercel** (a serverless function cannot hold a polling connection). `BOT_MODE=webhook` = Telegram pushes updates to `WEBHOOK_URL`; correct on Vercel. If you switch modes, delete the old webhook first: with polling the bot sets no webhook; with webhook the bot registers `<WEBHOOK_URL>/telegram`. A bot stuck in the wrong mode usually shows as "replies sometimes / never" — check `BOT_MODE` and `WEBHOOK_URL` in the Vercel dashboard, redeploy, and test `/start` again. |
| **Digest didn't arrive / nothing in 15 min** | (1) GitHub repo → Actions → "Digest (every 15 min)": did the latest run finish green? A 401 means `CRON_SECRET` differs between Vercel and the repo secret (or one side is blank) — set both to the same value and redeploy Vercel. A non-200 run means the function errored — open its Vercel logs. (2) Are the feeds fresh — open one feed URL from (i) in a browser; a 404 or days-old file means the scanner workflow for that store isn't publishing (and with no live feed the digest correctly sends nothing). (3) Is the subscriber still subscribed (did they send `/stop`)? (4) Dedupe: if the only live deals were already sent in the last 7 days, nothing is sent — that is correct behaviour, not a failure. |
| **Admin commands don't work (`/subscribers`, `/broadcast`)** | Check `ADMIN_ID` in the Vercel env vars — it must be *your* numeric Telegram ID (from `/myid`), not your @username and not the bot's ID. Redeploy after changing it. Also confirm you are messaging from the same account that owns that ID. |
| **"Missing required env var" on start** | A required variable is blank — in `.env` (local) or in the Vercel dashboard (deployed). On Vercel, `BOT_MODE=webhook` additionally requires `TURSO_DATABASE_URL` (and a token for a remote Turso URL). Fill the blanks in and redeploy. |
| **Turso errors (`401`, `failed to connect`, `database not found`)** | The URL or token is wrong, or the database was archived after 10 idle days (see (g)). Re-copy the URL from `turso db show <name> --url` and mint a fresh token with `turso db tokens create <name>`, update the Vercel env vars, redeploy. |
| **Digest run times out** | The digest (9 feed fetches + one send per subscriber) should fit Vercel's default function limit, but if a run ever times out, the workflow's curl has a 300 s cap; add `"functions": {"api/cron-digest.js": {"maxDuration": 60}}` to `vercel.json` and redeploy. |

---

## (l) What is NOT built (and the upgrade path)

- **No payment flow.** The subscription is free — there is no price, no
  expiry and no admin approval step. Paid plans (manual payment /
  Razorpay) can be added back later behind a plan gate — that is a future
  step, not this bot (see REPORT.md). Note: paid plans would also make
  the project commercial, and Vercel Hobby is non-commercial — that would
  mean moving to Vercel Pro (see (h)).
- **No admin dashboard / web UI.** Subscriber management is the Turso
  database + the bot's admin commands (see (j)).
- **No per-deal price-drop tracking** (e.g. "alert me when this exact
  product falls below ₹X"). Keyword watch alerts (`/watch`) cover
  titles, not prices.

---

## Files in this repo

| File | What it is |
|---|---|
| `src/index.js` | Entry point for local dev / polling — wires the bot + the 15-min digest job (NOT used on Vercel) |
| `src/bot.js`, `src/config.js`, `src/db.js`, `src/digest.js`, `src/feed.js`, `src/jobs.js` | Bot, config, Turso database layer, digest, feed fetching, scheduler |
| `src/dedupe.js` | Deal keys + 7-day dedupe filter (`posted_deals`) used by `runDigest` |
| `api/_bot.js`, `api/webhook.js`, `api/cron-digest.js` | Vercel serverless functions: shared lazy bot, Telegram webhook receiver, 15-min digest endpoint (called by GitHub Actions, gated on `CRON_SECRET`) |
| `vercel.json` | No crons (`{}`) — the digest is triggered by GitHub Actions, not a Vercel cron (Hobby allows one run/day) |
| `.github/workflows/digest-15min.yml` | GitHub Actions: POSTs to `/api/cron-digest` every 15 min (`*/15 * * * *`) + manual dispatch, secret via `x-cron-secret` header |
| `.env.example` | Env template — copy to `.env` locally, never commit a real `.env` |
| `fixtures/deals.json` | Sample deals for tests and the dry-run digest |
| `tests/` | Automated tests (`npm test`) |
| `README.md` | This file |
| `REPORT.md` | Build report: architecture, decisions, verification evidence |
| `scanner-patches/` | Feed-publishing patches for the 9 scanner repos (staged diffs, not yet applied) |

*Last updated: 2026-11-19 — digest is every 15 minutes via GitHub Actions (Vercel cron removed), with 7-day dedupe and a redesigned message; /start and /help list all 9 stores. The bot is deployed and the webhook is verified live; the digest sends nothing until the scanner feed branches exist — see the notice at the top.*
