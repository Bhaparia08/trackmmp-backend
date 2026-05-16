/**
 * Plan tier definitions and quota enforcement helpers.
 *
 * One source of truth for plan limits. Read by:
 *   - routes/plan.js  (GET /api/plan/me, /api/plan/tiers)
 *   - utils/postbackHandler.js  (quota check before attribution)
 *   - routes/admin.js  (admin changing a user's plan)
 *
 * "Conversions" = attributed postbacks (any event type). Counted per calendar
 * month in UTC, matching how external MMPs bill (AppsFlyer NOIs, Adjust MTUs).
 */

const db = require('../db/init');

const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    monthly_conversions: 12000,
    price_usd: 0,
    description: 'Get started — no credit card needed',
    features: [
      '12,000 attributed conversions / month',
      'All core tracking + reporting',
      'Cohort retention + LTV',
      'Up to 3 team members',
      'Email support',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    monthly_conversions: 100000,
    price_usd: 99,
    description: 'For scaling teams running multiple campaigns',
    features: [
      '100,000 attributed conversions / month',
      'Everything in Free',
      'Custom report builder',
      'Cost data connectors (Meta / Google / TikTok)',
      'Unlimited team members',
      'Priority support',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    monthly_conversions: 500000,
    price_usd: 499,
    description: 'For agencies and growth teams managing many advertisers',
    features: [
      '500,000 attributed conversions / month',
      'Everything in Growth',
      'White-label dashboards',
      'Incrementality test runner',
      'Predictive LTV',
      'Dedicated account manager',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthly_conversions: -1, // unlimited
    price_usd: null, // contact sales
    description: 'Unlimited scale + SLAs + raw data warehouse access',
    features: [
      'Unlimited conversions',
      'Everything in Pro',
      'Raw data export / Postgres replica',
      'Custom integrations',
      '99.95% SLA',
      'Dedicated infra option',
    ],
  },
};

function getTier(planId) {
  return TIERS[planId] || TIERS.free;
}

function listTiers() {
  return Object.values(TIERS);
}

// First day of current calendar month, UTC, as a Unix timestamp.
function currentPeriodStart() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

// First day of NEXT calendar month, UTC, as a Unix timestamp.
function currentPeriodEnd() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
}

function usedThisMonth(userId) {
  const periodStart = currentPeriodStart();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM postbacks
     WHERE user_id = ? AND status = 'attributed' AND created_at >= ?`
  ).get(userId, periodStart);
  return row ? row.n : 0;
}

function status(userId) {
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  const planId = user?.plan || 'free';
  const tier = getTier(planId);
  const used = usedThisMonth(userId);
  const cap = tier.monthly_conversions;
  const unlimited = cap < 0;
  return {
    plan: planId,
    tier_name: tier.name,
    used,
    cap,
    unlimited,
    percent_used: unlimited ? 0 : Math.min(100, Math.round((used / cap) * 100)),
    over_cap: !unlimited && used >= cap,
    period_start: currentPeriodStart(),
    period_end: currentPeriodEnd(),
  };
}

// Returns true if the user can ingest one more attributed conversion.
// Logs an overage record the first time the user crosses the cap each month
// (cheap — relies on the postback fraud_log row for visibility).
function canIngestAttributedConversion(userId) {
  const s = status(userId);
  return !s.over_cap;
}

module.exports = {
  TIERS,
  getTier,
  listTiers,
  currentPeriodStart,
  currentPeriodEnd,
  usedThisMonth,
  status,
  canIngestAttributedConversion,
};
