'use strict';

// api/cron-digest.js — digest endpoint, triggered every 15 minutes by
// GitHub Actions (see .github/workflows/digest-15min.yml).
//
// Why GitHub Actions and not a Vercel Cron: Vercel Hobby allows at most
// ONE cron run per day, so a 15-minute cadence cannot be a Vercel cron
// (Pro is $20/mo — the user chose free everywhere). The workflow POSTs
// to this endpoint on a schedule and authenticates with a shared secret
// in the `x-cron-secret` header. vercel.json therefore carries NO crons
// block.
//
// AUTH (checked BEFORE any bot work — an unauthenticated hit builds no
// bot, runs no digest, and sends NOTHING):
//   The request is accepted if ANY of these holds:
//     (a) the `x-vercel-cron` header is present (non-empty) — Vercel
//         sets it on its own cron calls, so the endpoint keeps working
//         if a Vercel cron is ever re-added. The header alone is NOT
//         security (anyone can send it); the only effect of a spoofed
//         hit is an extra digest send, the same benign outcome as a
//         duplicate tick.
//     (b) CRON_SECRET is configured (non-empty) AND the request carries
//         that exact value — either as the `?secret=` query param or as
//         the `x-cron-secret` header. Compared in constant time
//         (crypto.timingSafeEqual on equal-length buffers; a length
//         mismatch rejects immediately).
//   Anything else -> 401 JSON { ok:false, error:'Unauthorized' }.
//   If CRON_SECRET is not configured, (b) can never match and only (a)
//   passes — local dev / tests run without it.
//
// The secret is the env var CRON_SECRET, set to the SAME value in TWO
// places: the Vercel project env vars AND the GitHub repo secret of the
// same name. The value is created at deploy time (never committed,
// never invented here, never logged).
//
// The expected secret is read from the config module (src/config.js,
// `config.cronSecret`) — the same module getBot() loads in production.
// It is read here, before getBot(), so auth can reject before any bot
// work. When the config module cannot load (local dev / tests without
// the required BOT_TOKEN/ADMIN_ID env vars), the env var is read
// directly instead; both paths read the same source, env CRON_SECRET.
//
// Behaviour (once authorised):
//   - Success -> 200 JSON { ok:true, sent, failed, subscribers, messages }
//     (the runDigest result verbatim, plus ok:true).
//   - Any error (bot init failure, digest failure) -> log + 500 JSON
//     { ok:false, error: <message> }.
//   - No secrets are ever logged.
//
// CommonJS: module.exports is the handler. No new dependencies.
// The test seam lives in api/_bot.js (__setTestOverrides); runDigest's feed
// fetch is stubbed in tests via global fetch (see tests/api.test.js).

const crypto = require('node:crypto');
const { getBot } = require('./_bot');
const { runDigest } = require('../src/jobs');

// The config value (src/config.js) is itself `process.env.CRON_SECRET ||
// ''`; reading the env var directly when config cannot load keeps the
// value identical in every environment.
function loadExpectedSecret() {
  try {
    const config = require('../src/config');
    if (config && typeof config.cronSecret === 'string') return config.cronSecret;
  } catch (_) {
    // Config requires BOT_TOKEN/ADMIN_ID — absent in tests / local dev.
  }
  return process.env.CRON_SECRET || '';
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

// Constant-time comparison: equal-length buffers via timingSafeEqual;
// a length mismatch rejects immediately (no early exit on content).
function secretsEqual(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function suppliedSecret(req) {
  const fromHeader = headerValue(req.headers, 'x-cron-secret');
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;
  if (req.query && typeof req.query.secret === 'string' && req.query.secret !== '') {
    return req.query.secret;
  }
  if (typeof req.url === 'string') {
    try {
      const secret = new URL(req.url, 'http://localhost').searchParams.get('secret');
      if (secret) return secret;
    } catch (_) {
      // Malformed URL — no query secret to read.
    }
  }
  return '';
}

function isAuthorized(req) {
  // (a) Vercel's own cron calls carry this header.
  const vercelCron = headerValue(req.headers, 'x-vercel-cron');
  if (typeof vercelCron === 'string' && vercelCron !== '') return true;

  // (b) Shared secret via header or ?secret= query param. Only possible
  // when CRON_SECRET is configured (non-empty).
  const expected = loadExpectedSecret();
  if (!expected) return false;
  const supplied = suppliedSecret(req);
  if (!supplied) return false;
  return secretsEqual(supplied, expected);
}

async function handler(req, res) {
  // Auth BEFORE getBot()/runDigest: an unauthenticated hit sends nothing.
  if (!isAuthorized(req)) {
    console.warn('[cron-digest] unauthorized cron call rejected');
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

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
