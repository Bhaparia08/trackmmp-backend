/**
 * eCPM calculator for the internal auction.
 *
 * eCPM = expected revenue per 1000 impressions
 *      = (conversions / impressions) × payout × 1000
 *
 * For a (campaign × inventory) pair, we look at the last LOOKBACK_DAYS of
 * activity:
 *   impressions  — rows in the `impressions` table with this campaign+inventory
 *   clicks       — rows in `clicks` with this campaign+inventory
 *   conversions  — rows in `postbacks` for those clicks where status = attributed
 *   revenue      — SUM(postbacks.payout) for those conversions
 *
 * Then:
 *   eCPM = (revenue / impressions) × 1000
 *
 * Cold-start fallback (when impressions < MIN_IMPRESSIONS):
 *   We don't have enough data to trust the rate.  Use a per-vertical
 *   "expected eCPM" baseline derived from the campaign's payout × an
 *   industry-rule-of-thumb conversion-funnel multiplier:
 *     baseline_ecpm = payout × VERTICAL_CONV_RATE × CLICK_THROUGH_RATE × 1000
 *
 * Conservative defaults err low so a real-data eCPM will always beat a
 * cold-start estimate (which is the desired behavior — let proven offers win).
 */
const db = require('../db/init');

const LOOKBACK_DAYS    = 30;
const MIN_IMPRESSIONS  = 100;   // below this, we trust cold-start more

// Cold-start vertical multipliers — used when no historical data exists.
// CTR = clicks/impressions. CR = conversions/clicks.
// Numbers are industry averages, intentionally conservative.
const VERTICAL_DEFAULTS = {
  'us-betting':    { ctr: 0.020, cr: 0.060 },   // 2.0% CTR × 6% CR
  'us-finance':    { ctr: 0.015, cr: 0.040 },
  'us-insurance':  { ctr: 0.012, cr: 0.030 },
  'us-other':      { ctr: 0.010, cr: 0.020 },
  'in-finance':    { ctr: 0.018, cr: 0.030 },
  'in-health':     { ctr: 0.015, cr: 0.020 },
  'br-finance':    { ctr: 0.018, cr: 0.030 },
  'mx-finance':    { ctr: 0.018, cr: 0.030 },
  '_default':      { ctr: 0.010, cr: 0.020 },
};

function computeEcpm({ campaign_id, inventory_id }) {
  const cutoff = Math.floor(Date.now() / 1000) - (LOOKBACK_DAYS * 86400);

  // Active impressions in the window for this pair
  const imp = db.prepare(`
    SELECT COUNT(*) AS n FROM impressions
    WHERE campaign_id = ? AND inventory_id = ? AND created_at >= ?
  `).get(campaign_id, inventory_id, cutoff).n;

  // Clicks in the window (we only need the count for diagnostics)
  const clicks = db.prepare(`
    SELECT COUNT(*) AS n FROM clicks
    WHERE campaign_id = ? AND inventory_id = ? AND created_at >= ?
  `).get(campaign_id, inventory_id, cutoff).n;

  // Conversions + revenue — JOIN postbacks to clicks on the (campaign, inventory)
  // pair so we don't have to hand-roll a string-split.
  const conv = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(pb.payout), 0) AS rev
    FROM postbacks pb
    JOIN clicks   cl ON cl.click_id = pb.click_id
    WHERE cl.campaign_id = ? AND cl.inventory_id = ?
      AND pb.status = 'attributed'
      AND pb.created_at >= ?
  `).get(campaign_id, inventory_id, cutoff);
  const conversions = conv.n;
  const revenue     = conv.rev || 0;

  let ecpm, source;
  if (imp >= MIN_IMPRESSIONS) {
    ecpm   = (revenue / imp) * 1000;
    source = 'measured';
  } else {
    // Cold-start: estimate using the campaign's payout × vertical defaults
    const camp = db.prepare(`
      SELECT payout, vertical FROM campaigns WHERE id = ?
    `).get(campaign_id);
    const inv  = db.prepare(`
      SELECT vertical FROM owned_inventory WHERE id = ?
    `).get(inventory_id);
    const vertKey = (camp?.vertical || inv?.vertical || '_default').toLowerCase();
    const def     = VERTICAL_DEFAULTS[vertKey] || VERTICAL_DEFAULTS._default;
    const payout  = Number(camp?.payout) || 0;
    ecpm   = payout * def.ctr * def.cr * 1000;
    source = 'cold_start';
  }

  return {
    ecpm:        Number(ecpm.toFixed(4)),
    sample_size: imp,
    impressions: imp,
    clicks,
    conversions,
    revenue:     Number(revenue.toFixed(2)),
    source,
  };
}

/**
 * Compute eCPM for every approval row owned by a user (or globally if userId
 * is null) and persist the result.  Returns a summary {updated, errors}.
 */
function recomputeForOwner(userId) {
  const rows = userId
    ? db.prepare(`SELECT id, campaign_id, inventory_id FROM campaign_inventory_approvals WHERE user_id = ?`).all(userId)
    : db.prepare(`SELECT id, campaign_id, inventory_id FROM campaign_inventory_approvals`).all();

  const upd = db.prepare(`
    UPDATE campaign_inventory_approvals
    SET ecpm_estimate = ?, ecpm_sample_size = ?, ecpm_computed_at = unixepoch()
    WHERE id = ?
  `);
  let updated = 0, errors = [];
  for (const r of rows) {
    try {
      const e = computeEcpm({ campaign_id: r.campaign_id, inventory_id: r.inventory_id });
      upd.run(e.ecpm, e.sample_size, r.id);
      updated++;
    } catch (err) {
      errors.push({ approval_id: r.id, error: err.message });
    }
  }
  return { evaluated: rows.length, updated, errors };
}

module.exports = { computeEcpm, recomputeForOwner, LOOKBACK_DAYS, MIN_IMPRESSIONS };
