-- Account Managers
CREATE TABLE IF NOT EXISTS account_managers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL UNIQUE,
  phone      TEXT,
  notes      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE,
  password     TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  company_name TEXT,
  role         TEXT    NOT NULL DEFAULT 'admin',
  status       TEXT    NOT NULL DEFAULT 'active',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  plan         TEXT    NOT NULL DEFAULT 'free',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Apps (one per mobile/web property being tracked)
CREATE TABLE IF NOT EXISTS apps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  bundle_id        TEXT,
  platform         TEXT    NOT NULL DEFAULT 'android',

  -- Internal / AppsFlyer-compatible tokens
  dev_key          TEXT    NOT NULL UNIQUE,
  s2s_token        TEXT    NOT NULL UNIQUE,
  push_api_token   TEXT    NOT NULL UNIQUE,
  pull_api_token   TEXT    NOT NULL UNIQUE,

  -- Adjust integration tokens
  adjust_app_token    TEXT,   -- e.g. "4w565xzmb54d"  (from Adjust dashboard)
  adjust_s2s_token    TEXT,   -- S2S Security token for validating inbound Adjust S2S calls
  adjust_api_token    TEXT,   -- Bearer token for Adjust Reporting API (My Profile → API token)

  -- Branch integration (reserved for future use)
  branch_key          TEXT,
  branch_secret       TEXT,

  provider         TEXT    NOT NULL DEFAULT 'internal',
  status           TEXT    NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Adjust event tokens (one per tracked in-app event, per app)
CREATE TABLE IF NOT EXISTS adjust_event_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_name  TEXT    NOT NULL,   -- e.g. "af_purchase", "registration", "level_complete"
  event_token TEXT    NOT NULL,   -- 6-char token from Adjust dashboard e.g. "f0ob4r"
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(app_id, event_name)
);

-- Publishers / Traffic Sources
CREATE TABLE IF NOT EXISTS publishers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  publisher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  email          TEXT,
  pub_token      TEXT    NOT NULL UNIQUE,
  status         TEXT    NOT NULL DEFAULT 'active',
  notes          TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  advertiser_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_id               INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  name                 TEXT    NOT NULL,
  advertiser_name      TEXT,
  campaign_token       TEXT    NOT NULL UNIQUE,
  payout               REAL    NOT NULL DEFAULT 0,
  payout_type          TEXT    NOT NULL DEFAULT 'cpi',
  destination_url      TEXT    NOT NULL DEFAULT '',
  postback_url         TEXT    DEFAULT '',
  status               TEXT    NOT NULL DEFAULT 'active',
  cap_daily            INTEGER DEFAULT 0,
  cap_total            INTEGER DEFAULT 0,
  allowed_countries    TEXT    DEFAULT '',
  click_lookback_days  INTEGER DEFAULT 7,
  is_retargeting       INTEGER DEFAULT 0,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Campaign Goals (multiple conversion goals per campaign)
CREATE TABLE IF NOT EXISTS campaign_goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  name         TEXT    NOT NULL,
  event_name   TEXT    NOT NULL DEFAULT 'install',
  payout       REAL    NOT NULL DEFAULT 0,
  revenue      REAL    NOT NULL DEFAULT 0,
  payout_type  TEXT    NOT NULL DEFAULT 'fixed',
  postback_url TEXT    DEFAULT '',
  is_default   INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Impressions (view-through attribution)
CREATE TABLE IF NOT EXISTS impressions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  impression_id      TEXT    NOT NULL UNIQUE,
  campaign_id        INTEGER REFERENCES campaigns(id),
  publisher_id       INTEGER REFERENCES publishers(id),
  user_id            INTEGER REFERENCES users(id),
  pid                TEXT,
  publisher_click_id TEXT,
  ip                 TEXT,
  user_agent         TEXT,
  country            TEXT,
  device_type        TEXT,
  os                 TEXT,
  platform           TEXT,
  advertising_id     TEXT,
  af_sub1 TEXT, af_sub2 TEXT, af_sub3 TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Fraud Log
CREATE TABLE IF NOT EXISTS fraud_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id     TEXT,
  campaign_id  INTEGER REFERENCES campaigns(id),
  user_id      INTEGER REFERENCES users(id),
  fraud_type   TEXT NOT NULL,
  details      TEXT,
  action       TEXT NOT NULL DEFAULT 'flagged',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Clicks
CREATE TABLE IF NOT EXISTS clicks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id           TEXT    NOT NULL UNIQUE,
  campaign_id        INTEGER NOT NULL REFERENCES campaigns(id),
  publisher_id       INTEGER REFERENCES publishers(id),
  user_id            INTEGER NOT NULL REFERENCES users(id),
  pid                TEXT,
  af_c_id            TEXT,
  af_siteid          TEXT,
  af_sub1            TEXT,
  af_sub2            TEXT,
  af_sub3            TEXT,
  af_sub4            TEXT,
  af_sub5            TEXT,
  publisher_click_id TEXT,
  ip                 TEXT,
  user_agent         TEXT,
  country            TEXT,
  language           TEXT,
  device_type        TEXT,
  os                 TEXT,
  browser            TEXT,
  advertising_id     TEXT,
  platform           TEXT,
  referrer           TEXT,
  -- Adjust-specific identifiers
  adid               TEXT,   -- Adjust's own device ID
  gps_adid           TEXT,   -- Google Play Services Advertising ID
  google_app_set_id  TEXT,   -- Android backup ID (API 30+)
  att_status         TEXT,   -- iOS App Tracking Transparency status (0-3)
  status             TEXT    NOT NULL DEFAULT 'clicked',
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_clicks_click_id           ON clicks(click_id);
CREATE INDEX IF NOT EXISTS idx_clicks_publisher_click_id ON clicks(publisher_click_id);
CREATE INDEX IF NOT EXISTS idx_clicks_campaign_id        ON clicks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_clicks_created_at         ON clicks(created_at);

-- Inbound S2S Postbacks (received from ad networks)
CREATE TABLE IF NOT EXISTS postbacks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id           TEXT,
  publisher_click_id TEXT,
  campaign_id        INTEGER REFERENCES campaigns(id),
  user_id            INTEGER REFERENCES users(id),
  event_type         TEXT    NOT NULL DEFAULT 'install',
  event_name         TEXT,
  event_value        TEXT,
  payout             REAL    DEFAULT 0,
  revenue            REAL    DEFAULT 0,
  currency           TEXT    DEFAULT 'USD',
  advertising_id     TEXT,
  idfa               TEXT,
  idfv               TEXT,
  android_id         TEXT,
  install_unix_ts    INTEGER,
  status             TEXT    NOT NULL DEFAULT 'received',
  blocked_reason     TEXT,
  raw_params         TEXT,
  ip                 TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_postbacks_click_id   ON postbacks(click_id);
CREATE INDEX IF NOT EXISTS idx_postbacks_pub_cid    ON postbacks(publisher_click_id);
CREATE INDEX IF NOT EXISTS idx_postbacks_campaign   ON postbacks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_postbacks_created    ON postbacks(created_at);

-- In-app S2S Events (sent by app SDK/server to platform)
CREATE TABLE IF NOT EXISTS s2s_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id              INTEGER REFERENCES apps(id),
  user_id             INTEGER REFERENCES users(id),
  appsflyer_id        TEXT,
  advertising_id      TEXT,
  customer_user_id    TEXT,
  app_version_name    TEXT,
  event_name          TEXT    NOT NULL,
  event_value         TEXT,
  event_time          INTEGER,
  ip                  TEXT,
  bundle_identifier   TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_s2s_events_app_id    ON s2s_events(app_id);
CREATE INDEX IF NOT EXISTS idx_s2s_events_created   ON s2s_events(created_at);

-- Pre-aggregated daily stats (upserted on every postback)
CREATE TABLE IF NOT EXISTS daily_stats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  app_id       INTEGER,
  campaign_id  INTEGER,
  publisher_id INTEGER,
  date         TEXT    NOT NULL,
  clicks       INTEGER NOT NULL DEFAULT 0,
  installs     INTEGER NOT NULL DEFAULT 0,
  leads        INTEGER NOT NULL DEFAULT 0,
  conversions  INTEGER NOT NULL DEFAULT 0,
  revenue      REAL    NOT NULL DEFAULT 0,
  UNIQUE(user_id, app_id, campaign_id, publisher_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
CREATE INDEX IF NOT EXISTS idx_daily_stats_user ON daily_stats(user_id);
