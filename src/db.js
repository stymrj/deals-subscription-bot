'use strict';

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

/**
 * Subscriber store on @libsql/client (Turso / local SQLite file).
 *
 * Tables:
 *   subscribers(user_id INTEGER PRIMARY KEY, name TEXT, username TEXT,
 *     status TEXT ('active'|'expired'), created_at INTEGER)
 *   posted_deals(deal_key TEXT PRIMARY KEY, store TEXT, title TEXT,
 *     posted_at INTEGER) — digest dedupe: keys of deals already sent,
 *     posted_at is epoch ms (see getRecentPostedKeys / markPosted).
 *
 * The subscription is free: there is no plan, no expiry and no payments
 * table. A fresh row (e.g. created by /start alone) starts as 'expired' —
 * /start alone does NOT subscribe; only the Subscribe button sets the
 * status to 'active'.
 *
 * initDb(url) is ASYNC: `const store = await initDb(url)`.
 * `url` may be:
 *   - a Turso URL (libsql://... or https://...),
 *   - a `file:` URL (e.g. `file:./data/subscribers.db`),
 *   - the literal string ':memory:' (mapped to an in-memory libsql client).
 * All data methods are async and return Promises. Row objects have the
 * shape {user_id, name, username, status, created_at} with user_id as a
 * NUMBER (libsql may return bigint for INTEGER PRIMARY KEY).
 */

function normalizeRow(row) {
  if (!row) return null;
  return {
    user_id: typeof row.user_id === 'bigint' ? Number(row.user_id) : row.user_id,
    name: row.name ?? null,
    username: row.username ?? null,
    status: row.status ?? null,
    created_at:
      typeof row.created_at === 'bigint' ? Number(row.created_at) : row.created_at,
  };
}

async function initDb(url, authToken) {
  let clientUrl = url;

  if (url === ':memory:') {
    // cache=private (NOT shared): each initDb gets its own isolated
    // in-memory DB, matching better-sqlite3 ':memory:' semantics.
    // cache=shared would leak rows between stores in the same process.
    clientUrl = 'file::memory:?cache=private';
  } else if (typeof url === 'string' && url.startsWith('file:')) {
    // Local file: make sure the parent directory exists (same as before).
    const filePath = url.slice('file:'.length);
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  }

  const client = createClient(
    authToken ? { url: clientUrl, authToken } : { url: clientUrl }
  );

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS subscribers (
      user_id INTEGER PRIMARY KEY,
      name TEXT,
      username TEXT,
      status TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS posted_deals (
      deal_key TEXT PRIMARY KEY,
      store TEXT,
      title TEXT,
      posted_at INTEGER
    );
  `);

  const now = () => Date.now();

  return {
    db: client,

    async getSubscriber(userId) {
      const res = await client.execute({
        sql: 'SELECT * FROM subscribers WHERE user_id = ?',
        args: [userId],
      });
      return res.rows.length ? normalizeRow(res.rows[0]) : null;
    },

    async upsertSubscriber({ user_id, name, username }) {
      const existing = await this.getSubscriber(user_id);
      if (existing) {
        await client.execute({
          sql: 'UPDATE subscribers SET name = ?, username = ? WHERE user_id = ?',
          args: [name || existing.name, username || existing.username, user_id],
        });
      } else {
        await client.execute({
          sql: `INSERT INTO subscribers
                  (user_id, name, username, status, created_at)
                VALUES (?, ?, ?, 'expired', ?)`,
          args: [user_id, name, username, now()],
        });
      }
      return this.getSubscriber(user_id);
    },

    /** Set a subscriber's status ('active' | 'expired'). */
    async setStatus(userId, status) {
      await client.execute({
        sql: 'UPDATE subscribers SET status = ? WHERE user_id = ?',
        args: [status, userId],
      });
      return this.getSubscriber(userId);
    },

    async listSubscribers() {
      const res = await client.execute(
        'SELECT * FROM subscribers ORDER BY created_at ASC'
      );
      return res.rows.map(normalizeRow);
    },

    /** Subscribers whose status is 'active'. No expiry check — free subs never expire. */
    async getActiveSubscribers() {
      const res = await client.execute(
        "SELECT * FROM subscribers WHERE status = 'active' ORDER BY created_at ASC"
      );
      return res.rows.map(normalizeRow);
    },

    /**
     * Dedupe: deal_keys posted at/after sinceMs (epoch ms). Returns a Set.
     * runDigest passes now - DEDUPE_WINDOW_MS (7 days) so only recent
     * sends suppress a re-send.
     */
    async getRecentPostedKeys(sinceMs) {
      const res = await client.execute({
        sql: 'SELECT deal_key FROM posted_deals WHERE posted_at >= ?',
        args: [sinceMs],
      });
      return new Set(res.rows.map(r => r.deal_key));
    },

    /**
     * Dedupe: record sent deals. entries: [{deal_key, store, title,
     * posted_at}] with posted_at as epoch ms.
     * INSERT OR REPLACE (not IGNORE): re-marking a deal that was re-sent
     * after its window expired refreshes posted_at, so its 7-day window
     * restarts from the latest send. IGNORE would keep the stale
     * first-send time and let the deal re-send on every run once the
     * window had expired.
     */
    async markPosted(entries) {
      for (const e of entries || []) {
        await client.execute({
          sql: `INSERT OR REPLACE INTO posted_deals
                  (deal_key, store, title, posted_at)
                VALUES (?, ?, ?, ?)`,
          args: [e.deal_key, e.store ?? null, e.title ?? null, e.posted_at],
        });
      }
    },

    async close() {
      client.close();
    },
  };
}

module.exports = { initDb };
