'use strict';

// api/cron-digest.js — Vercel Cron function: daily 9 AM IST digest.
//
// Invoked by Vercel Cron (see vercel.json: 03:30 UTC == 09:00 IST) at
// /api/cron-digest. Builds the bot the same lazy way as api/webhook.js
// (shared api/_bot.js helper, no bot.launch()), then calls the shared
// runDigest(bot, store, config) from src/jobs.js — no duplicated send logic.
// The HTTP response is sent AFTER the work completes: serverless functions
// do not keep running background work after res ends, so the digest must
// finish inside the request.
//
// NOTE on the `x-vercel-cron` header: its presence is NOT security — anyone
// can send that header. There is no shared secret available to verify cron
// calls with, so this endpoint does NOT gate on it; it just proceeds. The
// only effect of an unauthenticated hit is an extra digest send to the
// current subscribers, which is the same benign outcome as a duplicate cron
// tick. If a verifiable secret becomes available, gate on it here.
//
// Behaviour:
//   - Success -> 200 JSON { ok:true, sent, failed, subscribers, messages }
//     (the runDigest result verbatim, plus ok:true).
//   - Any error (bot init failure, digest failure) -> log + 500 JSON
//     { ok:false, error: <message> }.
//   - No secrets are ever logged.
//
// CommonJS: module.exports is the handler. No new dependencies.
// The test seam lives in api/_bot.js (__setTestOverrides); runDigest's feed
// fetch is stubbed in tests via global fetch (see tests/api.test.js).

const { getBot } = require('./_bot');
const { runDigest } = require('../src/jobs');

async function handler(req, res) {
  // Deliberately not gated on the x-vercel-cron header — see the NOTE above.
  // (Header is logged only at debug level via the request method; nothing
  // about it is trusted.)

  let built;
  try {
    built = await getBot();
  } catch (err) {
    console.error(
      '[cron-digest] bot failed to initialise:',
      err && err.message ? err.message : err
    );
    return res.status(500).json({ ok: false, error: 'Bot failed to initialise' });
  }

  try {
    const result = await runDigest(built.bot, built.store, built.config);
    return res.status(200).json({
      ok: true,
      sent: result.sent,
      failed: result.failed,
      subscribers: result.subscribers,
      messages: result.messages,
    });
  } catch (err) {
    console.error(
      '[cron-digest] digest failed:',
      err && err.message ? err.message : err
    );
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : 'Digest failed',
    });
  }
}

module.exports = handler;
