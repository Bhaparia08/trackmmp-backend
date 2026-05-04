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

  // ── Smart Links ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS smart_links (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    name         TEXT    NOT NULL,
    token        TEXT    NOT NULL UNIQUE,
    fallback_url TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'active',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS smart_link_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    smart_link_id  INTEGER NOT NULL REFERENCES smart_links(id) ON DELETE CASCADE,
    campaign_id    INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    priority       INTEGER NOT NULL DEFAULT 0,
    weight         INTEGER NOT NULL DEFAULT 100,
    country_codes  TEXT    NOT NULL DEFAULT '',
    device_types   TEXT    NOT NULL DEFAULT '',
    os_names       TEXT    NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // Add smart_link_id to clicks AFTER smart_links table exists
  `ALTER TABLE clicks ADD COLUMN smart_link_id INTEGER REFERENCES smart_links(id)`,

  // Offer tags / categories — comma-separated vertical labels (Gaming, Finance, etc.)
  `ALTER TABLE campaigns ADD COLUMN tags TEXT NOT NULL DEFAULT ''`,

  // Email verification — default 1 so existing accounts stay active
  `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // Geo fallback URL — redirect non-allowed-country traffic to a smart link
  `ALTER TABLE campaigns ADD COLUMN geo_fallback_url TEXT NOT NULL DEFAULT ''`,

  // Stable sequential display numbers — assigned at INSERT, never change
  `ALTER TABLE users ADD COLUMN seq_num INTEGER`,
  `ALTER TABLE campaigns ADD COLUMN seq_num INTEGER`,
  `ALTER TABLE publishers ADD COLUMN seq_num INTEGER`,

  // VTA: impression counts in daily stats + flag on attributed postbacks
  `ALTER TABLE daily_stats ADD COLUMN impressions INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE postbacks ADD COLUMN is_view_through INTEGER NOT NULL DEFAULT 0`,

  // ── Campaign enhancements ─────────────────────────────────────────────────
  `ALTER TABLE campaigns ADD COLUMN start_date TEXT`,
  `ALTER TABLE campaigns ADD COLUMN end_date TEXT`,
  `ALTER TABLE campaigns ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE campaigns ADD COLUMN channel TEXT NOT NULL DEFAULT 'all'`,
  `ALTER TABLE campaigns ADD COLUMN allowed_devices TEXT NOT NULL DEFAULT 'all'`,
  `ALTER TABLE campaigns ADD COLUMN cap_monthly INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN cap_redirect_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE campaigns ADD COLUMN conversion_hold_days INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN featured INTEGER NOT NULL DEFAULT 0`,
  // URL masking: keep our domain in address bar (iframe for web, JS redirect for app stores)
  `ALTER TABLE campaigns ADD COLUMN url_masking INTEGER NOT NULL DEFAULT 0`,
  // Referrer cloaking: strip Referer header so destination can't see our tracking domain
  `ALTER TABLE campaigns ADD COLUMN referrer_cloaking INTEGER NOT NULL DEFAULT 0`,

  // ── Attendance system ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS attendance (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            TEXT    NOT NULL CHECK(type IN ('check_in','check_out')),
    lat             REAL,
    lng             REAL,
    address         TEXT,
    ip              TEXT,
    biometric_verified INTEGER NOT NULL DEFAULT 0,
    note            TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance(user_id, created_at)`,

  // WebAuthn biometric credentials per AM user
  `CREATE TABLE IF NOT EXISTS am_biometric_credentials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   TEXT    NOT NULL UNIQUE,
    public_key      TEXT    NOT NULL,
    counter         INTEGER NOT NULL DEFAULT 0,
    device_name     TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ── Advertiser legal entity fields ───────────────────────────────────────
  `ALTER TABLE users ADD COLUMN legal_name TEXT`,
  `ALTER TABLE users ADD COLUMN legal_address TEXT`,
  `ALTER TABLE users ADD COLUMN legal_country TEXT`,
  `ALTER TABLE users ADD COLUMN tax_id TEXT`,
  `ALTER TABLE users ADD COLUMN company_reg_no TEXT`,

  // ── Invoices ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number  TEXT    NOT NULL UNIQUE,
    entity          TEXT    NOT NULL DEFAULT 'sg',
    advertiser_id   INTEGER NOT NULL REFERENCES users(id),
    created_by      INTEGER NOT NULL REFERENCES users(id),
    issue_date      TEXT    NOT NULL,
    due_date        TEXT    NOT NULL,
    currency        TEXT    NOT NULL DEFAULT 'USD',
    line_items      TEXT    NOT NULL DEFAULT '[]',
    subtotal        REAL    NOT NULL DEFAULT 0,
    tax_rate        REAL    NOT NULL DEFAULT 0,
    tax_amount      REAL    NOT NULL DEFAULT 0,
    total           REAL    NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'draft',
    notes           TEXT    NOT NULL DEFAULT '',
    paid_at         INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ── Multi-AM assignment: many-to-many between users and account_managers ──
  `CREATE TABLE IF NOT EXISTS user_account_managers (
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_manager_id INTEGER NOT NULL REFERENCES account_managers(id) ON DELETE CASCADE,
    assigned_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, account_manager_id)
  )`,

  // ── Historical Invoices ────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS historical_invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number  TEXT    NOT NULL UNIQUE,
    client_name     TEXT    NOT NULL,
    entity          TEXT    NOT NULL DEFAULT 'sg',
    issue_date      TEXT,
    payment_date    TEXT,
    amount          REAL    NOT NULL DEFAULT 0,
    currency        TEXT    NOT NULL DEFAULT 'USD',
    status          TEXT    NOT NULL DEFAULT 'pending',
    notes           TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ── Insertion Orders ──────────────────────────────────────────────────────
  // Signed contracts between Appreach and advertisers.
  // Legal entity info is captured at signing time and used to auto-fill invoices.
  `CREATE TABLE IF NOT EXISTS insertion_orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id),            -- admin who created
    advertiser_id       INTEGER NOT NULL REFERENCES users(id),            -- the advertiser
    io_number           TEXT    NOT NULL UNIQUE,                          -- e.g. AM/IO/2026/001
    campaign_name       TEXT    NOT NULL DEFAULT '',
    io_value            REAL    NOT NULL DEFAULT 0,
    currency            TEXT    NOT NULL DEFAULT 'USD',
    start_date          TEXT,
    end_date            TEXT,
    payment_terms       TEXT    NOT NULL DEFAULT 'NET30',
    billing_cycle       TEXT    NOT NULL DEFAULT 'monthly',
    -- Advertiser legal entity snapshot (from signed IO)
    legal_name          TEXT    NOT NULL DEFAULT '',
    legal_address       TEXT    NOT NULL DEFAULT '',
    legal_country       TEXT    NOT NULL DEFAULT '',
    tax_id              TEXT    NOT NULL DEFAULT '',
    company_reg_no      TEXT    NOT NULL DEFAULT '',
    contact_name        TEXT    NOT NULL DEFAULT '',
    contact_email       TEXT    NOT NULL DEFAULT '',
    contact_phone       TEXT    NOT NULL DEFAULT '',
    -- IO state
    status              TEXT    NOT NULL DEFAULT 'draft',
    notes               TEXT    NOT NULL DEFAULT '',
    signed_at           INTEGER,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ── Per-Publisher Caps ─────────────────────────────────────────────────────
  // Overrides global campaign caps for individual publishers
  `CREATE TABLE IF NOT EXISTS publisher_caps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    publisher_id INTEGER NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    cap_daily    INTEGER NOT NULL DEFAULT 0,
    cap_monthly  INTEGER NOT NULL DEFAULT 0,
    cap_total    INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(campaign_id, publisher_id)
  )`,

  // ── Landing Pages (A/B test per campaign) ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS landing_pages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    name         TEXT    NOT NULL,
    url          TEXT    NOT NULL,
    weight       INTEGER NOT NULL DEFAULT 100,
    clicks       INTEGER NOT NULL DEFAULT 0,
    conversions  INTEGER NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'active',
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // Track which landing page each click hit
  `ALTER TABLE clicks ADD COLUMN landing_page_id INTEGER REFERENCES landing_pages(id)`,

  // ── Cap Types: payout-based and revenue-based caps ─────────────────────────
  `ALTER TABLE campaigns ADD COLUMN cap_type TEXT NOT NULL DEFAULT 'clicks'`,
  `ALTER TABLE campaigns ADD COLUMN cap_daily_payout REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN cap_monthly_payout REAL NOT NULL DEFAULT 0`,

  // ── Fraud Rules ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS fraud_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    name        TEXT    NOT NULL,
    rule_type   TEXT    NOT NULL,
    config      TEXT    NOT NULL DEFAULT '{}',
    action      TEXT    NOT NULL DEFAULT 'block',
    status      TEXT    NOT NULL DEFAULT 'active',
    hit_count   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  // ── Automation Rules ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS automation_rules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    name             TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'active',
    trigger_type     TEXT    NOT NULL,
    trigger_config   TEXT    NOT NULL DEFAULT '{}',
    action_type      TEXT    NOT NULL,
    action_config    TEXT    NOT NULL DEFAULT '{}',
    last_checked_at  INTEGER,
    last_triggered_at INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS automation_rule_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id      INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    triggered_at INTEGER NOT NULL DEFAULT (unixepoch()),
    trigger_data TEXT    NOT NULL DEFAULT '{}',
    action_taken TEXT    NOT NULL DEFAULT ''
  )`,

  // ── Webhook Retry Queue ────────────────────────────────────────────────────
  // Outbound postback URLs that failed are retried with exponential backoff
  `CREATE TABLE IF NOT EXISTS webhook_retry_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    url           TEXT    NOT NULL,
    context_type  TEXT    NOT NULL DEFAULT 'postback',
    context_id    INTEGER,
    attempts      INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 5,
    next_retry_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_error    TEXT,
    status        TEXT    NOT NULL DEFAULT 'pending',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_retry_pending ON webhook_retry_queue(status, next_retry_at)`,

  // ── Alert Rules & Notifications ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT    NOT NULL,
    alert_type     TEXT    NOT NULL,
    campaign_id    INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    publisher_id   INTEGER REFERENCES publishers(id) ON DELETE CASCADE,
    threshold      REAL    NOT NULL DEFAULT 0,
    window_minutes INTEGER NOT NULL DEFAULT 60,
    channel        TEXT    NOT NULL DEFAULT 'in_app',
    webhook_url    TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL DEFAULT 'active',
    last_fired_at  INTEGER,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS alert_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id     INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
    alert_type  TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    data        TEXT    NOT NULL DEFAULT '{}',
    read        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alert_notif_user ON alert_notifications(user_id, read, created_at)`,

  // ── Multi-touch Attribution Touch Points ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS touch_points (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT    NOT NULL,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    publisher_id INTEGER REFERENCES publishers(id) ON DELETE SET NULL,
    click_id     TEXT    NOT NULL,
    touch_type   TEXT    NOT NULL DEFAULT 'click',
    touch_order  INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_touch_points_device ON touch_points(device_id, campaign_id)`,
  `ALTER TABLE campaigns ADD COLUMN attribution_model TEXT NOT NULL DEFAULT 'last_click'`,

  // ── Campaign Cost Tracking ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS campaign_costs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    date        TEXT    NOT NULL,
    amount      REAL    NOT NULL DEFAULT 0,
    cost_type   TEXT    NOT NULL DEFAULT 'media_buy',
    notes       TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_campaign_costs_campaign ON campaign_costs(campaign_id, date)`,

  // ── SKAdNetwork (SKAN) Postbacks ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS skan_postbacks (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id          INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    app_id               TEXT    NOT NULL,
    transaction_id       TEXT    NOT NULL UNIQUE,
    version              TEXT    NOT NULL DEFAULT '3',
    source_app_id        TEXT,
    source_identifier    TEXT,
    conversion_value     INTEGER,
    fine_value           INTEGER,
    coarse_value         TEXT,
    redownload           INTEGER NOT NULL DEFAULT 0,
    did_win              INTEGER NOT NULL DEFAULT 1,
    source_domain        TEXT,
    attribution_signature TEXT,
    postback_sequence_index INTEGER NOT NULL DEFAULT 0,
    ip                   TEXT,
    raw_payload          TEXT    NOT NULL DEFAULT '{}',
    status               TEXT    NOT NULL DEFAULT 'received',
    created_at           INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_skan_campaign ON skan_postbacks(campaign_id, created_at)`,
  `ALTER TABLE campaigns ADD COLUMN skan_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN skan_conversion_schema TEXT NOT NULL DEFAULT '{}' `,

  // ── Deep Link Configuration per Campaign ──────────────────────────────────
  `ALTER TABLE campaigns ADD COLUMN deep_link_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE campaigns ADD COLUMN ios_store_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE campaigns ADD COLUMN android_store_url TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE campaigns ADD COLUMN deferred_deep_link INTEGER NOT NULL DEFAULT 0`,

  // ── Fraud: Device Fingerprint Registry ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS fraud_device_fingerprints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT    NOT NULL UNIQUE,
    ip          TEXT,
    user_agent  TEXT,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    hit_count   INTEGER NOT NULL DEFAULT 1,
    first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fraud_fp ON fraud_device_fingerprints(fingerprint)`,

  // ── Campaign Permissions (granular view/edit per user) ─────────────────────
  `CREATE TABLE IF NOT EXISTS campaign_permissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_view    INTEGER NOT NULL DEFAULT 1,
    can_edit    INTEGER NOT NULL DEFAULT 0,
    can_manage  INTEGER NOT NULL DEFAULT 0,
    granted_by  INTEGER REFERENCES users(id),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(campaign_id, user_id)
  )`,

  // ── Retargeting / Re-engagement ───────────────────────────────────────────
  `ALTER TABLE campaigns ADD COLUMN re_engagement_window_days INTEGER DEFAULT 30`,
  `ALTER TABLE campaigns ADD COLUMN re_engagement_postback_url TEXT DEFAULT ''`,
  `ALTER TABLE daily_stats ADD COLUMN re_engagements INTEGER NOT NULL DEFAULT 0`,

  // ── Fix: link AM users to the primary admin (admin with most publishers) ──
  // AMs who self-registered have created_by IS NULL, so getOwnerId() falls back
  // to their own user_id and they see nothing. Link them to the admin who owns
  // the most data (most publishers). Runs every boot — safe to overwrite.
  `UPDATE users
   SET created_by = (
     SELECT u.id FROM users u
     LEFT JOIN publishers p ON p.user_id = u.id
     WHERE u.role = 'admin'
     GROUP BY u.id
     ORDER BY COUNT(p.id) DESC, u.created_at ASC
     LIMIT 1
   )
   WHERE role = 'account_manager'`,
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

// Backfill seq_num for existing rows that don't have one yet
// Users — assign in created_at ASC order so oldest gets seq 1
{
  const usersWithoutSeq = db.prepare('SELECT id FROM users WHERE seq_num IS NULL ORDER BY created_at ASC, id ASC').all();
  if (usersWithoutSeq.length > 0) {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_num), 0) AS m FROM users WHERE seq_num IS NOT NULL').get().m;
    const fillSeq = db.prepare('UPDATE users SET seq_num = ? WHERE id = ?');
    usersWithoutSeq.forEach((row, i) => fillSeq.run(maxSeq + i + 1, row.id));
  }
}

// Campaigns
{
  const rowsWithoutSeq = db.prepare('SELECT id FROM campaigns WHERE seq_num IS NULL ORDER BY created_at ASC, id ASC').all();
  if (rowsWithoutSeq.length > 0) {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_num), 0) AS m FROM campaigns WHERE seq_num IS NOT NULL').get().m;
    const fillSeq = db.prepare('UPDATE campaigns SET seq_num = ? WHERE id = ?');
    rowsWithoutSeq.forEach((row, i) => fillSeq.run(maxSeq + i + 1, row.id));
  }
}

// Publishers
{
  const rowsWithoutSeq = db.prepare('SELECT id FROM publishers WHERE seq_num IS NULL ORDER BY created_at ASC, id ASC').all();
  if (rowsWithoutSeq.length > 0) {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_num), 0) AS m FROM publishers WHERE seq_num IS NOT NULL').get().m;
    const fillSeq = db.prepare('UPDATE publishers SET seq_num = ? WHERE id = ?');
    rowsWithoutSeq.forEach((row, i) => fillSeq.run(maxSeq + i + 1, row.id));
  }
}

// Backfill user_account_managers from existing users.account_manager_id
{
  try {
    const existing = db.prepare(
      "SELECT id, account_manager_id FROM users WHERE account_manager_id IS NOT NULL AND role IN ('advertiser','publisher')"
    ).all();
    const ins = db.prepare('INSERT OR IGNORE INTO user_account_managers (user_id, account_manager_id) VALUES (?, ?)');
    for (const u of existing) ins.run(u.id, u.account_manager_id);
  } catch {}
}

// ── One-time admin password reset (migration: reset_admin_v2) ────────────────
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'reset_admin_v2'").get();
  if (!done) {
    try {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('admin123', 12);
      const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
      if (existingAdmin) {
        // Reset email + password for whatever admin account exists on this server
        db.prepare("UPDATE users SET email = 'admin@test.com', password = ? WHERE id = ?").run(hash, existingAdmin.id);
        console.log('[migration] reset_admin_v2: admin account updated → admin@test.com');
      } else {
        // No admin exists at all — create one
        db.prepare("INSERT INTO users (email, password, name, role, status, postback_token) VALUES (?, ?, 'Admin', 'admin', 'active', ?)").run('admin@test.com', hash, nanoid20hex());
        console.log('[migration] reset_admin_v2: admin@test.com created');
      }
      db.prepare("INSERT INTO migrations (name) VALUES ('reset_admin_v2')").run();
    } catch (e) {
      console.error('[migration] reset_admin_v2 failed:', e.message);
    }
  }
}

// ── Migration: fix_campaign_click_id_params ──────────────────────────────────
// Scans all imported campaigns (source_credential_id IS NOT NULL) whose
// destination_url does NOT contain {click_id}, and injects the correct
// platform-specific click_id parameter based on URL pattern detection.
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'fix_campaign_click_id_params'").get();
  if (!done) {
    try {
      // Detect platform from URL domain/path patterns → correct click_id param name
      function detectClickIdParam(url) {
        if (!url) return null;
        const u = url.toLowerCase();
        if (u.includes('ad.admitad.com') || u.includes('admitad'))           return 'subid';
        if (u.includes('.eflow.team') || u.includes('everflow'))              return 'transaction_id';
        if (u.includes('hasoffers.com') || u.includes('.go2cloud.org') ||
            u.includes('.go2jump.org')  || u.includes('tune.com'))            return 'transaction_id';
        if (u.includes('trackier.com')  || u.includes('.trackier.'))         return 'transaction_id';
        if (u.includes('affise.com')    || u.includes('.afftrack.com') ||
            u.includes('affise'))                                              return 'clickid';
        if (u.includes('impact.com') || u.includes('impactradius') ||
            u.includes('.sjv.io')    || u.includes('.pxf.io') ||
            u.includes('.7eer.net'))                                           return 'irclickid';
        if (u.includes('trckswrm.com') || u.includes('swaarm'))              return 'sub1';
        if (u.includes('cityads.com') || u.includes('cityad'))               return 'click_id';
        if (u.includes('appsflyer.com') || u.includes('onelink'))            return 'clickid';
        if (u.includes('adjust.com') || u.includes('adj.st'))                return 'reftag';
        // Generic fallback for any imported campaign
        return 'click_id';
      }

      const campaigns = db.prepare(
        "SELECT id, name, destination_url FROM campaigns WHERE source_credential_id IS NOT NULL AND destination_url IS NOT NULL AND destination_url != '' AND destination_url NOT LIKE '%{click_id}%'"
      ).all();

      let fixed = 0;
      for (const c of campaigns) {
        const param = detectClickIdParam(c.destination_url);
        if (!param) continue;
        const sep    = c.destination_url.includes('?') ? '&' : '?';
        const newUrl = c.destination_url + sep + param + '={click_id}';
        db.prepare("UPDATE campaigns SET destination_url = ?, updated_at = unixepoch() WHERE id = ?")
          .run(newUrl, c.id);
        fixed++;
        console.log(`[migration] fix_click_id: campaign #${c.id} "${c.name}" → injected ${param}={click_id}`);
      }
      console.log(`[migration] fix_campaign_click_id_params: fixed ${fixed} / ${campaigns.length} campaigns`);
      db.prepare("INSERT INTO migrations (name) VALUES ('fix_campaign_click_id_params')").run();
    } catch (e) {
      console.error('[migration] fix_campaign_click_id_params failed:', e.message);
    }
  }
}

// ── Migration: fix_campaign_visibility_and_urls ──────────────────────────────
// Fixes ALL campaigns (imported or manually created) that have:
//   1. visibility = 'private'  → set to 'open'
//   2. destination_url missing {click_id} → inject platform-specific param
// Also logs a full audit report of every campaign's status.
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'fix_campaign_visibility_and_urls_v2'").get();
  if (!done) {
    try {
      function detectClickIdParam(url) {
        if (!url) return null;
        const u = url.toLowerCase();
        if (u.includes('ad.admitad.com') || u.includes('admitad'))           return 'subid';
        if (u.includes('.eflow.team')    || u.includes('everflow'))           return 'transaction_id';
        if (u.includes('hasoffers.com') || u.includes('.go2cloud.org') ||
            u.includes('.go2jump.org')  || u.includes('tune.com'))            return 'transaction_id';
        if (u.includes('trackier.com')  || u.includes('.trackier.'))         return 'transaction_id';
        if (u.includes('affise.com')    || u.includes('.afftrack.com') ||
            u.includes('affise'))                                              return 'clickid';
        if (u.includes('impact.com')    || u.includes('impactradius') ||
            u.includes('.sjv.io')       || u.includes('.pxf.io') ||
            u.includes('.7eer.net'))                                           return 'irclickid';
        if (u.includes('trckswrm.com') || u.includes('swaarm'))              return 'sub1';
        if (u.includes('cityads.com')  || u.includes('cityad'))              return 'click_id';
        if (u.includes('appsflyer.com')|| u.includes('onelink'))             return 'clickid';
        if (u.includes('adjust.com')   || u.includes('adj.st'))              return 'reftag';
        return 'click_id';
      }

      const allCampaigns = db.prepare(
        "SELECT id, name, campaign_token, status, visibility, destination_url, source_credential_id FROM campaigns ORDER BY id"
      ).all();

      let fixedVisibility = 0;
      let fixedClickId    = 0;
      let alreadyOk       = 0;

      console.log(`\n[campaign-audit] Checking ${allCampaigns.length} campaigns...\n`);

      for (const c of allCampaigns) {
        const issues = [];
        let newVisibility  = c.visibility;
        let newDestUrl     = c.destination_url;

        // Fix 1: private visibility → open
        if (c.visibility === 'private') {
          newVisibility = 'open';
          issues.push('visibility: private → open');
          fixedVisibility++;
        }

        // Fix 2: destination_url missing {click_id}
        if (c.destination_url && !c.destination_url.includes('{click_id}')) {
          const param = detectClickIdParam(c.destination_url);
          if (param) {
            const sep  = c.destination_url.includes('?') ? '&' : '?';
            newDestUrl = c.destination_url + sep + param + '={click_id}';
            issues.push(`click_id missing → injected ${param}={click_id}`);
            fixedClickId++;
          }
        }

        if (issues.length > 0) {
          db.prepare("UPDATE campaigns SET visibility = ?, destination_url = ?, updated_at = unixepoch() WHERE id = ?")
            .run(newVisibility, newDestUrl, c.id);
          console.log(`[campaign-audit] FIXED #${c.id} "${c.name}" (${c.campaign_token}): ${issues.join(' | ')}`);
        } else {
          alreadyOk++;
          const dest = c.destination_url ? c.destination_url.substring(0, 80) + (c.destination_url.length > 80 ? '…' : '') : '(none)';
          console.log(`[campaign-audit] OK    #${c.id} "${c.name}" | vis=${c.visibility} | dest=${dest}`);
        }
      }

      console.log(`\n[campaign-audit] SUMMARY: ${allCampaigns.length} total | ${alreadyOk} ok | ${fixedVisibility} visibility fixed | ${fixedClickId} click_id injected\n`);
      db.prepare("INSERT INTO migrations (name) VALUES ('fix_campaign_visibility_and_urls_v2')").run();
    } catch (e) {
      console.error('[migration] fix_campaign_visibility_and_urls_v2 failed:', e.message);
    }
  }
}

// ── Migration: seed historical invoices (one-time, on first deploy) ──────────
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'seed_historical_invoices_v1'").get();
  if (!done) {
    try {
      const { seed } = require('../scripts/seed_historical_invoices');
      seed(db);
      db.prepare("INSERT INTO migrations (name) VALUES ('seed_historical_invoices_v1')").run();
      console.log('[migration] seed_historical_invoices_v1: complete');
    } catch (e) {
      console.error('[migration] seed_historical_invoices_v1 failed:', e.message);
    }
  }
}

// ── Migration: reset_admin_v3 — fix password from email-as-password to admin123 ─
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'reset_admin_v3'").get();
  if (!done) {
    try {
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('admin123', 12);
      const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com' AND role = 'admin' LIMIT 1").get();
      if (admin) {
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hash, admin.id);
        console.log('[migration] reset_admin_v3: admin@test.com password → admin123');
      }
      db.prepare("INSERT INTO migrations (name) VALUES ('reset_admin_v3')").run();
    } catch (e) {
      console.error('[migration] reset_admin_v3 failed:', e.message);
    }
  }
}

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
