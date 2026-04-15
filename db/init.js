const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/tracking.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations: add new columns to existing tables without dropping data
const migrations = [
  // users table new columns
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE users ADD COLUMN company_name TEXT`,
  `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE users ADD COLUMN created_by INTEGER REFERENCES users(id)`,
  `ALTER TABLE users ADD COLUMN account_manager_id INTEGER REFERENCES account_managers(id) ON DELETE SET NULL`,
  `ALTER TABLE account_managers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  // campaigns table
  `ALTER TABLE campaigns ADD COLUMN advertiser_id INTEGER REFERENCES users(id)`,
  // publishers table
  `ALTER TABLE publishers ADD COLUMN publisher_user_id INTEGER REFERENCES users(id)`,
  // clicks: extended sub-params, creative, ad, city, impression link
  `ALTER TABLE clicks ADD COLUMN sub6 TEXT`,
  `ALTER TABLE clicks ADD COLUMN sub7 TEXT`,
  `ALTER TABLE clicks ADD COLUMN sub8 TEXT`,
  `ALTER TABLE clicks ADD COLUMN sub9 TEXT`,
  `ALTER TABLE clicks ADD COLUMN sub10 TEXT`,
  `ALTER TABLE clicks ADD COLUMN creative_id TEXT`,
  `ALTER TABLE clicks ADD COLUMN ad_id TEXT`,
  `ALTER TABLE clicks ADD COLUMN city TEXT`,
  `ALTER TABLE clicks ADD COLUMN impression_id TEXT REFERENCES impressions(impression_id)`,
  // campaigns: cost tracking, impression lookback
  `ALTER TABLE campaigns ADD COLUMN cost REAL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN cost_model TEXT DEFAULT 'cpc'`,
  `ALTER TABLE campaigns ADD COLUMN impression_lookback_days INTEGER DEFAULT 1`,
  // postbacks: goal tracking
  `ALTER TABLE postbacks ADD COLUMN goal_id INTEGER REFERENCES campaign_goals(id)`,
  `ALTER TABLE postbacks ADD COLUMN goal_name TEXT`,
  // campaigns: security_token (kept for DB compat, no longer shown in UI)
  `ALTER TABLE campaigns ADD COLUMN security_token TEXT`,
  // users: account-level postback token (one per user, used in /acquisition)
  `ALTER TABLE users ADD COLUMN postback_token TEXT`,
  // campaigns: track which external platform/offer this campaign was imported from
  `ALTER TABLE campaigns ADD COLUMN source_credential_id INTEGER REFERENCES advertiser_api_credentials(id)`,
  `ALTER TABLE campaigns ADD COLUMN external_offer_id TEXT`,

  // campaigns: separate publisher payout (what we pay publishers) from advertiser payout (what advertiser pays us)
  `ALTER TABLE campaigns ADD COLUMN publisher_payout REAL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN publisher_payout_type TEXT DEFAULT 'cpi'`,

  // campaigns: preview URL (App Store / Google Play link) — separate from destination_url (advertiser tracking link)
  `ALTER TABLE campaigns ADD COLUMN preview_url TEXT DEFAULT ''`,

  // publishers: global postback URL — fired to publisher on every attributed conversion
  `ALTER TABLE publishers ADD COLUMN global_postback_url TEXT DEFAULT ''`,

  // campaigns: visibility / access control
  // private = admin-only, approval_required = publisher must request, open = anyone can run
  `ALTER TABLE campaigns ADD COLUMN visibility TEXT NOT NULL DEFAULT 'open'`,

  // campaign access requests — publishers request approval for approval_required campaigns
  `CREATE TABLE IF NOT EXISTS campaign_access_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    publisher_id INTEGER NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    status       TEXT NOT NULL DEFAULT 'pending',
    note         TEXT,
    reviewed_by  INTEGER REFERENCES users(id),
    reviewed_at  INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(campaign_id, publisher_id)
  )`,

  // Publisher API keys table
  `CREATE TABLE IF NOT EXISTS publisher_api_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id  INTEGER REFERENCES publishers(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id),
    name          TEXT    NOT NULL,
    api_key       TEXT    NOT NULL UNIQUE,
    status        TEXT    NOT NULL DEFAULT 'active',
    last_used_at  INTEGER,
    created_by    INTEGER REFERENCES users(id),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Advertiser external API credentials
  `CREATE TABLE IF NOT EXISTS advertiser_api_credentials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id),
    advertiser_id INTEGER REFERENCES users(id),
    platform      TEXT    NOT NULL,
    label         TEXT,
    api_key       TEXT    NOT NULL,
    api_secret    TEXT,
    network_id    TEXT,
    extra         TEXT,
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Password reset tokens
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
];

const IGNORABLE = [
  'duplicate column',   // ALTER TABLE ADD COLUMN already exists
  'already exists',     // CREATE TABLE IF NOT EXISTS race
  'no such table',      // forward-ref migration on a fresh schema — schema.sql creates it
];

for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {
    const msg = e.message || '';
    if (!IGNORABLE.some(s => msg.toLowerCase().includes(s))) {
      console.error('[migration error]', msg, '\nSQL:', sql.slice(0, 120));
      // Log but do NOT throw — a bad migration must not crash the server
    }
  }
}

// Backfill tokens
const { customAlphabet } = require('nanoid');
const nanoid20hex = customAlphabet('0123456789abcdef', 20);

// Campaign security tokens (legacy, keep backfill for existing rows)
const missingCamp = db.prepare("SELECT id FROM campaigns WHERE security_token IS NULL OR security_token = ''").all();
const fillCamp = db.prepare("UPDATE campaigns SET security_token = ? WHERE id = ?");
for (const row of missingCamp) fillCamp.run(nanoid20hex(), row.id);

// User postback tokens — one per user, this is THE integration token shown in the UI
const missingUsers = db.prepare("SELECT id FROM users WHERE postback_token IS NULL OR postback_token = ''").all();
const fillUser = db.prepare("UPDATE users SET postback_token = ? WHERE id = ?");
for (const row of missingUsers) fillUser.run(nanoid20hex(), row.id);

// ── Auto-seed admin account ───────────────────────────────────────────────────
// If SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD env vars are set AND no admin
// exists yet, create the admin account automatically on first start.
// Safe to leave these env vars set permanently — it only runs when no admin exists.
if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!existingAdmin) {
    try {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync(process.env.SEED_ADMIN_PASSWORD, 12);
      const token = nanoid20hex();
      db.prepare(
        `INSERT INTO users (email, password, name, role, status, postback_token) VALUES (?, ?, ?, 'admin', 'active', ?)`
      ).run(
        process.env.SEED_ADMIN_EMAIL,
        hash,
        process.env.SEED_ADMIN_NAME || 'Admin',
        token
      );
      console.log(`[seed] Admin account created for ${process.env.SEED_ADMIN_EMAIL}`);
    } catch (e) {
      console.error('[seed] Failed to create admin:', e.message);
    }
  }
}

module.exports = db;
