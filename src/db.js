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

    async close() {
      client.close();
    },
  };
}

module.exports = { initDb };
