'use strict';

// api/webhook.js — Vercel Serverless Function: Telegram webhook entrypoint.
//
// Telegram POSTs each update to this endpoint (set as the bot webhook, e.g.
// https://<deployment>.vercel.app/api/webhook). The bot is built lazily via
// api/_bot.js (shared with the cron function) and is NEVER launched —
// updates are fed in with bot.handleUpdate(update), which needs no launch.
//
// Behaviour:
//   - Non-POST -> 405 JSON { ok:false, error:'Method not allowed' }.
//   - Malformed body (unparseable string, non-object) -> still 200 JSON
//     { ok:true }: Telegram retries on non-200, and a bad update must not
//     cause a retry storm. The bad body is logged (no payload contents —
//     updates can contain user text) and dropped.
//   - Bot fails to initialise (e.g. missing env) -> 500 JSON
//     { ok:false, error:'Bot failed to initialise' }, so a deploy
//     misconfiguration is visible instead of silently swallowing updates.
//   - handleUpdate throws for a bad update -> log + still 200 { ok:true }.
//   - Success -> 200 JSON { ok:true }.
//   - No secrets are ever logged (only error messages, never env values or
//     update payloads).
//
// CommonJS: module.exports is the handler. No new dependencies.
// The test seam lives in api/_bot.js (__setTestOverrides); this handler
// itself needs no factory export.

const { getBot } = require('./_bot');

function parseUpdate(body) {
  if (body == null) return null;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof body === 'object' && !Array.isArray(body)) return body;
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Vercel parses JSON bodies for us; also accept a raw string body.
  const update = parseUpdate(req.body);
  if (!update) {
    console.warn('[webhook] ignoring malformed update body');
    return res.status(200).json({ ok: true });
  }

  let built;
  try {
    built = await getBot();
  } catch (err) {
    console.error(
      '[webhook] bot failed to initialise:',
      err && err.message ? err.message : err
    );
    return res.status(500).json({ ok: false, error: 'Bot failed to initialise' });
  }

  try {
    await built.bot.handleUpdate(update);
  } catch (err) {
    // A bad update must not trigger Telegram retries — log and ack anyway.
    console.error(
      '[webhook] failed to handle update:',
      err && err.message ? err.message : err
    );
  }
  return res.status(200).json({ ok: true });
}

module.exports = handler;
