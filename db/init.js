const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Database = require('better-sqlite3');

// DB path is absolute by default so the same DB is loaded regardless of cwd.
// Override via env var if you really want a different location.
const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'tracking.db');
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

  // ── Per-admin nav visibility config (JSON array of enabled route paths, NULL = all) ──
  `ALTER TABLE users ADD COLUMN admin_nav_config TEXT`,

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

  // campaigns: vertical for publisher-campaign matching
  `ALTER TABLE campaigns ADD COLUMN vertical TEXT DEFAULT ''`,

  // publishers: vertical, geo, website URL for organisation and AI matching
  `ALTER TABLE publishers ADD COLUMN vertical TEXT DEFAULT ''`,
  `ALTER TABLE publishers ADD COLUMN geo TEXT DEFAULT ''`,
  `ALTER TABLE publishers ADD COLUMN website_url TEXT DEFAULT ''`,
  `ALTER TABLE publishers ADD COLUMN traffic_type TEXT DEFAULT 'web'`,

  // ── Phase 0: Owned Inventory Monetization ─────────────────────────────────
  // Owned websites/apps registered as inventory under a publisher (House model).
  `CREATE TABLE IF NOT EXISTS owned_inventory (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    publisher_id INTEGER NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
    type         TEXT    NOT NULL DEFAULT 'website',
    name         TEXT    NOT NULL,
    domain       TEXT,
    bundle_id    TEXT,
    vertical     TEXT    NOT NULL DEFAULT '',
    geo          TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'active',
    notes        TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_owned_inv_publisher ON owned_inventory(publisher_id)`,
  `CREATE INDEX IF NOT EXISTS idx_owned_inv_user      ON owned_inventory(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_owned_inv_vertgeo   ON owned_inventory(vertical, geo)`,

  // Placements: ad slots within an inventory unit.
  `CREATE TABLE IF NOT EXISTS placements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    inventory_id    INTEGER NOT NULL REFERENCES owned_inventory(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    slug            TEXT    NOT NULL,
    placement_type  TEXT    NOT NULL DEFAULT 'comparison_table',
    format          TEXT    NOT NULL DEFAULT 'html',
    max_offers      INTEGER NOT NULL DEFAULT 1,
    status          TEXT    NOT NULL DEFAULT 'active',
    notes           TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(inventory_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_placements_inv ON placements(inventory_id)`,

  // Per-inventory campaign approvals — granular control beyond per-publisher.
  `CREATE TABLE IF NOT EXISTS campaign_inventory_approvals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    inventory_id INTEGER NOT NULL REFERENCES owned_inventory(id) ON DELETE CASCADE,
    status       TEXT    NOT NULL DEFAULT 'pending',
    priority     INTEGER NOT NULL DEFAULT 0,
    weight       INTEGER NOT NULL DEFAULT 100,
    reviewed_by  INTEGER REFERENCES users(id),
    reviewed_at  INTEGER,
    notes        TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(campaign_id, inventory_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cia_inv  ON campaign_inventory_approvals(inventory_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_cia_camp ON campaign_inventory_approvals(campaign_id, status)`,

  // Audit log for inventory approvals — separate from global audit_log.
  `CREATE TABLE IF NOT EXISTS inventory_approval_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id  INTEGER REFERENCES campaign_inventory_approvals(id) ON DELETE SET NULL,
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    inventory_id INTEGER NOT NULL REFERENCES owned_inventory(id) ON DELETE CASCADE,
    actor_id     INTEGER NOT NULL REFERENCES users(id),
    action       TEXT    NOT NULL,
    before_state TEXT,
    after_state  TEXT,
    reason       TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_iaa_inv  ON inventory_approval_audit(inventory_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_iaa_camp ON inventory_approval_audit(campaign_id, created_at)`,

  // Per-slot click attribution (mirrors landing_page_id pattern).
  `ALTER TABLE clicks ADD COLUMN inventory_id INTEGER REFERENCES owned_inventory(id)`,
  `ALTER TABLE clicks ADD COLUMN placement_id INTEGER REFERENCES placements(id)`,
  `CREATE INDEX IF NOT EXISTS idx_clicks_inventory ON clicks(inventory_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clicks_placement ON clicks(placement_id)`,

  // ── Phase 1: Campaign Creatives ────────────────────────────────────────────
  // Rich offer presentation data (logo, headline, bonus, rating, terms, CTA).
  // 1:N from campaigns. Highest-weight active creative is rendered by default;
  // weight enables A/B testing of creative variants per campaign.
  `CREATE TABLE IF NOT EXISTS campaign_creatives (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL DEFAULT 'default',  -- internal label
    -- Visual elements
    logo_url        TEXT    NOT NULL DEFAULT '',         -- brand logo (60x60 ish)
    hero_image_url  TEXT    NOT NULL DEFAULT '',         -- larger hero for offer cards
    -- Copy
    brand_name      TEXT    NOT NULL DEFAULT '',         -- "BetMGM" — overrides campaign.name in render
    headline        TEXT    NOT NULL DEFAULT '',         -- "Up to $1,500 First Bet Offer"
    subheadline     TEXT    NOT NULL DEFAULT '',         -- "Use code WIN2026"
    bonus_amount    TEXT    NOT NULL DEFAULT '',         -- "$1,500" — display value
    bonus_label     TEXT    NOT NULL DEFAULT '',         -- "First Bet Offer"
    terms_short     TEXT    NOT NULL DEFAULT '',         -- "21+ NJ/PA/MI only. Terms apply."
    cta_text        TEXT    NOT NULL DEFAULT 'Get Offer',-- button label
    -- Trust signals
    rating          REAL,                                 -- 4.7 (nullable)
    rating_count    INTEGER NOT NULL DEFAULT 0,           -- 12453
    badge_text      TEXT    NOT NULL DEFAULT '',         -- "EDITOR'S PICK", "BEST OVERALL"
    badge_color     TEXT    NOT NULL DEFAULT '',         -- hex without #, optional
    -- Optimization
    weight          INTEGER NOT NULL DEFAULT 100,        -- A/B weight within campaign
    status          TEXT    NOT NULL DEFAULT 'active',
    notes           TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_creatives_campaign ON campaign_creatives(campaign_id, status)`,

  // ── Phase 1: Discovery Hub — campaign_candidates + validation_queue ────────
  // Discovery Hub aggregates offers pulled from all integrated networks
  // (Everflow, TUNE, Impact, Adjust, Branch, CityAds, Rakuten, Custom),
  // validates landing pages, and scores each candidate against owned inventory.
  // Both tables are ADDITIVE — no existing tables are modified, no foreign keys
  // out of existing schemas are required to function.
  `CREATE TABLE IF NOT EXISTS campaign_candidates (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    source_credential_id     INTEGER,
    source_platform          TEXT    NOT NULL,
    source_offer_id          TEXT    NOT NULL,
    source_advertiser_id     TEXT,
    source_advertiser_name   TEXT,

    name                     TEXT    NOT NULL,
    vertical                 TEXT,
    payout                   REAL    DEFAULT 0,
    payout_type              TEXT,
    payout_currency          TEXT    DEFAULT 'USD',

    allowed_countries        TEXT,                     -- JSON array
    allowed_devices          TEXT,                     -- JSON array
    allowed_os               TEXT,                     -- JSON array

    destination_url          TEXT,
    tracking_url_template    TEXT,
    preview_url              TEXT,

    normalized_payload       TEXT    NOT NULL,         -- JSON of NormalizedOffer
    raw_payload              TEXT,                     -- JSON of original

    validation_status        TEXT    NOT NULL DEFAULT 'pending',  -- pending|valid|broken|redirect_loop|parked|geo_blocked|malware|timeout
    validation_checked_at    INTEGER,
    validation_final_url     TEXT,
    validation_http_code     INTEGER,
    validation_redirect_chain TEXT,                    -- JSON
    validation_notes         TEXT,

    best_match_score         REAL,
    best_match_inventory_id  INTEGER,
    match_breakdown          TEXT,                     -- JSON

    import_status            TEXT    NOT NULL DEFAULT 'new',      -- new|reviewing|approved|imported|rejected|duplicate
    imported_campaign_id     INTEGER,
    reviewed_by              INTEGER,
    reviewed_at              INTEGER,
    rejection_reason         TEXT,

    first_seen_at            INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at             INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_unique ON campaign_candidates(source_platform, source_offer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_status   ON campaign_candidates(import_status, validation_status)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_score    ON campaign_candidates(best_match_score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_advert   ON campaign_candidates(source_advertiser_id)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_seen     ON campaign_candidates(last_seen_at DESC)`,

  `CREATE TABLE IF NOT EXISTS discovery_validation_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    INTEGER NOT NULL,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
    status          TEXT    NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
    last_error      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dvq_pending ON discovery_validation_queue(status, next_attempt_at)`,

  // Phase 3a: Review Queue — admin-overridden vertical mapping
  // (e.g. Insparx returns "Matchmaking" → reviewer maps to internal "Dating")
  // Falls back to candidate.vertical when null. Used at import time.
  `ALTER TABLE campaign_candidates ADD COLUMN mapped_vertical TEXT`,

  // Sync state tracking on advertiser_api_credentials — additive columns only
  `ALTER TABLE advertiser_api_credentials ADD COLUMN auto_sync          INTEGER DEFAULT 1`,
  `ALTER TABLE advertiser_api_credentials ADD COLUMN last_synced_at     INTEGER`,
  `ALTER TABLE advertiser_api_credentials ADD COLUMN last_sync_status   TEXT`,
  `ALTER TABLE advertiser_api_credentials ADD COLUMN last_sync_error    TEXT`,
  `ALTER TABLE advertiser_api_credentials ADD COLUMN last_offer_count   INTEGER DEFAULT 0`,

  // ── Phase 2: Programmatic readiness (freq cap, consent, A/B, Prebid) ──────
  // All additive — no existing data is rewritten.
  //
  // 1) Frequency capping per visitor.  Zero = no cap.
  `ALTER TABLE campaigns ADD COLUMN freq_cap_per_user_per_day     INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN freq_cap_per_user_per_hour    INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaigns ADD COLUMN freq_cap_per_user_per_session INTEGER NOT NULL DEFAULT 0`,

  // 2) A/B testing creatives — running tallies + opt-in auto-rotation.
  `ALTER TABLE campaign_creatives ADD COLUMN impressions   INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaign_creatives ADD COLUMN clicks        INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaign_creatives ADD COLUMN auto_optimize INTEGER NOT NULL DEFAULT 0`,

  // 3) Prebid.js header-bidding hooks per placement.
  `ALTER TABLE placements ADD COLUMN floor_ecpm    REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE placements ADD COLUMN prebid_config TEXT NOT NULL DEFAULT ''`,

  // 4) Extend the existing VTA impressions table with owned-inventory context.
  //    Old rows have NULL placement_id/visitor_id, which is fine — they were
  //    pixel-view impressions, not on-site placement impressions.
  `ALTER TABLE impressions ADD COLUMN visitor_id    TEXT`,
  `ALTER TABLE impressions ADD COLUMN inventory_id  INTEGER REFERENCES owned_inventory(id) ON DELETE SET NULL`,
  `ALTER TABLE impressions ADD COLUMN placement_id  INTEGER REFERENCES placements(id) ON DELETE SET NULL`,
  `ALTER TABLE impressions ADD COLUMN creative_id   INTEGER REFERENCES campaign_creatives(id) ON DELETE SET NULL`,
  `ALTER TABLE impressions ADD COLUMN consent_state TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_imp_visitor_camp ON impressions(visitor_id, campaign_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_imp_placement    ON impressions(placement_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_imp_creative     ON impressions(creative_id, created_at)`,

  // 5) Track creative variant + consent state on each click.
  `ALTER TABLE clicks ADD COLUMN cre_variant_id INTEGER REFERENCES campaign_creatives(id) ON DELETE SET NULL`,
  `ALTER TABLE clicks ADD COLUMN consent_state  TEXT`,

  // 6) Consent audit log (GDPR/CCPA compliance).
  `CREATE TABLE IF NOT EXISTS visitor_consent (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id    TEXT    NOT NULL,
    consent_state TEXT    NOT NULL,       -- 'accepted' | 'rejected' | 'limited' | 'tcf'
    tcf_string    TEXT,                   -- full TCF v2.2 consent string when present
    country       TEXT,
    ip_hash       TEXT,                   -- SHA-256(ip+salt) for audit, never raw IP
    user_agent    TEXT,
    placement_id  INTEGER REFERENCES placements(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_consent_visitor ON visitor_consent(visitor_id, created_at)`,

  // ── Phase 3: Discovery Hub review-queue automation ────────────────────────
  // Vertical alias map: upstream verticals (e.g. "Matchmaking") → our
  // canonical taxonomy (e.g. "us-finance").  Applied on candidate ingestion
  // and re-applicable via bulk-remap so the inventory matcher actually scores
  // incoming offers against your owned sites.
  `CREATE TABLE IF NOT EXISTS vertical_aliases (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    source_vertical   TEXT    NOT NULL,
    mapped_vertical   TEXT    NOT NULL,
    notes             TEXT,
    created_by        INTEGER REFERENCES users(id),
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(source_vertical)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_valias_source ON vertical_aliases(source_vertical)`,

  // Auto-import rules: when a freshly-scanned/validated candidate matches
  // ALL conditions in a rule, the engine imports it as a campaign and (if
  // best_match_inventory_id is set + auto_deploy_to_inventory is true) also
  // approves it onto that inventory in one shot.
  `CREATE TABLE IF NOT EXISTS auto_import_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    priority        INTEGER NOT NULL DEFAULT 100,
    conditions      TEXT    NOT NULL DEFAULT '{}',
    actions         TEXT    NOT NULL DEFAULT '{}',
    matched_count   INTEGER NOT NULL DEFAULT 0,
    last_matched_at INTEGER,
    created_by      INTEGER REFERENCES users(id),
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_air_enabled ON auto_import_rules(enabled, priority)`,

  // Audit trail for bulk + auto-import operations.
  `CREATE TABLE IF NOT EXISTS discovery_bulk_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     INTEGER REFERENCES users(id),
    rule_id      INTEGER REFERENCES auto_import_rules(id) ON DELETE SET NULL,
    action       TEXT    NOT NULL,
    candidate_id INTEGER REFERENCES campaign_candidates(id) ON DELETE CASCADE,
    before_state TEXT,
    after_state  TEXT,
    result       TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dba_candidate ON discovery_bulk_audit(candidate_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dba_rule      ON discovery_bulk_audit(rule_id, created_at)`,

  // ── Phase 4: eCPM auction ─────────────────────────────────────────────────
  // Each approval row carries an estimated revenue-per-1000-impressions
  // figure that /api/v1/serve uses to pick the highest-yielding offer when
  // multiple campaigns compete for the same impression.  NULL = no data yet,
  // fall back to priority/weight ordering.
  `ALTER TABLE campaign_inventory_approvals ADD COLUMN ecpm_estimate    REAL`,
  `ALTER TABLE campaign_inventory_approvals ADD COLUMN ecpm_computed_at INTEGER`,
  `ALTER TABLE campaign_inventory_approvals ADD COLUMN ecpm_sample_size INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_cia_ecpm ON campaign_inventory_approvals(inventory_id, ecpm_estimate DESC)`,

  // CTIT (Click-to-Install Time) fraud analysis
  `ALTER TABLE postbacks ADD COLUMN ctit_seconds INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_postbacks_ctit ON postbacks(ctit_seconds)`,

  // Two-Factor Authentication (TOTP)
  `ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0`,

  // Publisher Payouts
  `CREATE TABLE IF NOT EXISTS publisher_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publishers(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT DEFAULT '',
    payment_ref TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    paid_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publisher_payouts_publisher ON publisher_payouts(publisher_id)`,
  `CREATE INDEX IF NOT EXISTS idx_publisher_payouts_status ON publisher_payouts(status)`,

  // ── Scheduled Reports ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS scheduled_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    report_type TEXT NOT NULL DEFAULT 'summary',
    frequency TEXT NOT NULL DEFAULT 'daily',
    filters TEXT NOT NULL DEFAULT '{}',
    recipients TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'csv',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sent_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_reports_user ON scheduled_reports(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_reports_enabled ON scheduled_reports(enabled, next_run_at)`,

  // ── Conversion Hold & Approval ────────────────────────────────────────────
  `ALTER TABLE postbacks ADD COLUMN hold_until INTEGER`,
  `ALTER TABLE postbacks ADD COLUMN hold_status TEXT DEFAULT ''`,

  // ── Webhook Subscriptions ─────────────────────────────────────────────────
  // User-configured outbound webhooks for events (conversion, cap_reached, etc.)
  `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    name              TEXT    NOT NULL DEFAULT '',
    url               TEXT    NOT NULL,
    events            TEXT    NOT NULL DEFAULT 'conversion',
    secret            TEXT    NOT NULL DEFAULT '',
    status            TEXT    NOT NULL DEFAULT 'active',
    last_triggered_at INTEGER,
    trigger_count     INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_subs_user   ON webhook_subscriptions(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_subs_status ON webhook_subscriptions(status)`,

  // ── Multi-Currency Support ────────────────────────────────────────────────
  `ALTER TABLE users ADD COLUMN preferred_currency TEXT DEFAULT 'USD'`,

  `CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_currency TEXT NOT NULL DEFAULT 'USD',
    target_currency TEXT NOT NULL,
    rate REAL NOT NULL,
    date TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(base_currency, target_currency, date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exchange_rates_target_date ON exchange_rates(target_currency, date)`,
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
      // SECURITY: never use a weak default password on production. In prod the
      // admin must recover access via the forgot-password flow.
      const seedPw = process.env.NODE_ENV === 'production'
        ? require('crypto').randomBytes(24).toString('hex')
        : 'admin123';
      const hash = bcrypt.hashSync(seedPw, 12);
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
      // SECURITY: weak default only in dev. On production, set a strong random
      // password — the admin recovers via forgot-password.
      const isProd = process.env.NODE_ENV === 'production';
      const seedPw = isProd ? require('crypto').randomBytes(24).toString('hex') : 'admin123';
      const hash = bcrypt.hashSync(seedPw, 12);
      const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@test.com' AND role = 'admin' LIMIT 1").get();
      if (admin) {
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hash, admin.id);
        console.log(`[migration] reset_admin_v3: admin@test.com password reset (${isProd ? 'random — use forgot-password' : 'admin123 — dev'})`);
      }
      db.prepare("INSERT INTO migrations (name) VALUES ('reset_admin_v3')").run();
    } catch (e) {
      console.error('[migration] reset_admin_v3 failed:', e.message);
    }
  }
}

// ── Migration: create leelam.s@apogeemobi.com as admin ───────────────────────
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'create_leelam_admin_v1'").get();
  if (!done) {
    try {
      const bcrypt = require('bcrypt');
      const existing = db.prepare("SELECT id FROM users WHERE email = 'leelam.s@apogeemobi.com'").get();
      if (!existing) {
        const hash  = bcrypt.hashSync('Leelam@Apogeemobi2024', 12);
        const token = nanoid20hex();
        const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n;
        db.prepare(
          `INSERT INTO users (email, password, name, role, status, email_verified, postback_token, seq_num)
           VALUES (?, ?, 'Leelam S', 'admin', 'active', 1, ?, ?)`
        ).run('leelam.s@apogeemobi.com', hash, token, maxSeq);
        console.log('[migration] create_leelam_admin_v1: leelam.s@apogeemobi.com created as admin');
      } else {
        // Account exists — ensure it has admin role
        db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE email = 'leelam.s@apogeemobi.com'").run();
        console.log('[migration] create_leelam_admin_v1: leelam.s@apogeemobi.com role set to admin');
      }
      db.prepare("INSERT INTO migrations (name) VALUES ('create_leelam_admin_v1')").run();
    } catch (e) {
      console.error('[migration] create_leelam_admin_v1 failed:', e.message);
    }
  }
}

// ── Ensure: 4 advertiser accounts exist and are assigned to Leelam ─────────────
// Runs on EVERY boot — idempotent (skips if email already exists).
// Guarantees these accounts are always present regardless of migration history.
{
  try {
    const bcrypt = require('bcrypt');

    // 1. Ensure leelam has an account_managers record
    const leelamUser = db.prepare("SELECT id FROM users WHERE email = 'leelam.s@apogeemobi.com'").get();
    let leelamAmId = null;
    if (leelamUser) {
      let amRow = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(leelamUser.id);
      if (!amRow) amRow = db.prepare("SELECT id FROM account_managers WHERE email = 'leelam.s@apogeemobi.com'").get();
      if (!amRow) {
        const r = db.prepare("INSERT INTO account_managers (name, email, user_id) VALUES ('Leelam S', 'leelam.s@apogeemobi.com', ?)").run(leelamUser.id);
        leelamAmId = r.lastInsertRowid;
        console.log('[ensure] Leelam AM record created, id=' + leelamAmId);
      } else {
        leelamAmId = amRow.id;
      }
      // Ensure user_id is set on the AM record
      if (leelamAmId) db.prepare('UPDATE account_managers SET user_id = ? WHERE id = ? AND user_id IS NULL').run(leelamUser.id, leelamAmId);
    }

    // 2. created_by = integration admin
    const integAdmin = db.prepare("SELECT id FROM users WHERE email = 'integration@apogeemobi.com'").get();
    const createdBy  = integAdmin?.id || leelamUser?.id || 1;

    // 3. Ensure each advertiser exists.
    //    Passwords are read from env vars; if missing, a random secure
    //    password is generated and printed once to the console (operator
    //    must capture it from the boot log). Source code never contains
    //    real credentials.
    const advertisers = [
      { name: 'Adgrowth', email: 'admin@adgrowth.com',  envKey: 'SEED_ADGROWTH_PW', company: 'Adgrowth' },
      { name: 'Mobupps',  email: 'admin@mobupps.com',   envKey: 'SEED_MOBUPPS_PW',  company: 'Mobupps'  },
      { name: 'Admattic', email: 'info@admattic.com',   envKey: 'SEED_ADMATTIC_PW', company: 'Admattic' },
      { name: 'Ojo7',     email: 'contact@ojo7.com',    envKey: 'SEED_OJO7_PW',     company: 'Ojo7'     },
    ];

    for (const adv of advertisers) {
      let u = db.prepare('SELECT id, account_manager_id FROM users WHERE email = ?').get(adv.email);
      if (!u) {
        // Use env-supplied password if available, otherwise generate a random
        // one and surface it ONCE in the boot log so the operator can save it.
        let password = process.env[adv.envKey];
        if (!password) {
          password = require('crypto').randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
          console.log(`[ensure] ⚠ ${adv.envKey} not set — generated random password for ${adv.email}: ${password}  (save this; it will not be shown again)`);
        }
        const hash    = bcrypt.hashSync(password, 12);
        const token   = nanoid20hex();
        const nextSeq = db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n;
        const res = db.prepare(
          `INSERT INTO users (email, password, name, company_name, role, status, email_verified,
                              created_by, account_manager_id, postback_token, seq_num)
           VALUES (?, ?, ?, ?, 'advertiser', 'active', 1, ?, ?, ?, ?)`
        ).run(adv.email, hash, adv.name, adv.company, createdBy, leelamAmId, token, nextSeq);
        u = { id: res.lastInsertRowid, account_manager_id: leelamAmId };
        console.log('[ensure] Created advertiser: ' + adv.name + ' (' + adv.email + ') id=' + u.id);
      }
      // Always ensure AM assignment is set
      if (leelamAmId) {
        db.prepare('UPDATE users SET account_manager_id = ? WHERE id = ? AND account_manager_id IS NULL').run(leelamAmId, u.id);
        db.prepare('INSERT OR IGNORE INTO user_account_managers (user_id, account_manager_id) VALUES (?, ?)').run(u.id, leelamAmId);
      }
    }
  } catch (e) {
    console.error('[ensure] advertiser seed failed:', e.message);
  }
}

// ── Migration: reset integration + leelam admin passwords to known values ─────
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'reset_admin_passwords_v1'").get();
  if (!done) {
    try {
      const bcrypt = require('bcrypt');
      // Reset integration@apogeemobi.com
      const hash1 = bcrypt.hashSync('Integration@Apogee2024', 12);
      db.prepare("UPDATE users SET password = ?, role = 'admin', status = 'active', email_verified = 1 WHERE email = 'integration@apogeemobi.com'").run(hash1);
      console.log('[migration] reset_admin_passwords_v1: integration@apogeemobi.com password reset');
      // Reset leelam.s@apogeemobi.com
      const hash2 = bcrypt.hashSync('Leelam@Apogee2024', 12);
      db.prepare("UPDATE users SET password = ?, role = 'admin', status = 'active', email_verified = 1 WHERE email = 'leelam.s@apogeemobi.com'").run(hash2);
      console.log('[migration] reset_admin_passwords_v1: leelam.s@apogeemobi.com password reset');
      db.prepare("INSERT INTO migrations (name) VALUES ('reset_admin_passwords_v1')").run();
    } catch (e) {
      console.error('[migration] reset_admin_passwords_v1 failed:', e.message);
    }
  }
}

// ── Migration: add sent_at column to invoices ─────────────────────────────────
{
  db.prepare("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, ran_at TEXT DEFAULT (datetime('now')))").run();
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = 'invoices_sent_at_v1'").get();
  if (!done) {
    try {
      db.prepare('ALTER TABLE invoices ADD COLUMN sent_at INTEGER').run();
      console.log('[migration] invoices_sent_at_v1: sent_at column added');
      db.prepare("INSERT INTO migrations (name) VALUES ('invoices_sent_at_v1')").run();
    } catch (e) {
      console.error('[migration] invoices_sent_at_v1 failed:', e.message);
    }
  }
}

// ── Ensure: ApogeeMobi House publisher under the operator's primary admin ───
// Phase 0 (owned-inventory monetization): all owned websites/apps register as
// inventory under this single house publisher; reporting is sliced by
// inventory_id. Runs every boot — idempotent.
// Preference: admin@test.com (the primary operator account where the existing
// publisher portfolio lives), then integration@apogeemobi.com, then any admin.
// If the house publisher already exists under a different admin, it's moved
// to the preferred one (preserves pub_token, status, history).
{
  try {
    const admin =
      db.prepare("SELECT id FROM users WHERE email = 'admin@test.com' AND role = 'admin'").get() ||
      db.prepare("SELECT id FROM users WHERE email = 'integration@apogeemobi.com' AND role = 'admin'").get() ||
      db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
    if (admin) {
      const existing = db.prepare(
        "SELECT id, user_id FROM publishers WHERE name = 'ApogeeMobi House' AND status != 'deleted'"
      ).get();
      if (!existing) {
        const nextSeq = db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM publishers').get().n;
        db.prepare(
          `INSERT INTO publishers (user_id, name, pub_token, status, seq_num, vertical, geo, traffic_type, notes)
           VALUES (?, 'ApogeeMobi House', ?, 'active', ?, '', '', 'web', 'Internal house publisher for owned-and-operated inventory')`
        ).run(admin.id, nanoid20hex(), nextSeq);
        console.log('[ensure] ApogeeMobi House publisher created for admin id=' + admin.id);
      } else if (existing.user_id !== admin.id) {
        // Re-point the house publisher to the preferred admin.
        db.prepare('UPDATE publishers SET user_id = ? WHERE id = ?').run(admin.id, existing.id);
        // Re-point any owned_inventory rows so their user_id stays consistent
        // with the publisher's new owner. Same for placements.
        db.prepare('UPDATE owned_inventory SET user_id = ? WHERE publisher_id = ?').run(admin.id, existing.id);
        db.prepare(
          'UPDATE placements SET user_id = ? WHERE inventory_id IN (SELECT id FROM owned_inventory WHERE publisher_id = ?)'
        ).run(admin.id, existing.id);
        console.log('[ensure] ApogeeMobi House publisher moved from user_id=' + existing.user_id + ' to user_id=' + admin.id);
      }
    }
  } catch (e) {
    console.error('[ensure] ApogeeMobi House publisher seed failed:', e.message);
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

// ── onelinks (OneLink wizard — preview feature) ──────────────────────────
// Standalone table; intentionally NOT entangled with smart_links so the
// wizard can ship without breaking existing campaign mappings.
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS onelinks (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                TEXT    NOT NULL,
      slug                TEXT    NOT NULL UNIQUE,
      ios_store_url       TEXT    NOT NULL DEFAULT '',
      android_store_url   TEXT    NOT NULL DEFAULT '',
      web_fallback_url    TEXT    NOT NULL DEFAULT '',
      ios_deep_link       TEXT    NOT NULL DEFAULT '',
      android_deep_link   TEXT    NOT NULL DEFAULT '',
      total_clicks        INTEGER NOT NULL DEFAULT 0,
      status              TEXT    NOT NULL DEFAULT 'active',
      created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_onelinks_user ON onelinks(user_id)`).run();
  // Migration: add expires_at column for OneLink v2 (idempotent).
  try { db.prepare(`ALTER TABLE onelinks ADD COLUMN expires_at INTEGER`).run(); } catch {}
} catch (e) { console.error('[init] onelinks table:', e.message); }

module.exports = db;
