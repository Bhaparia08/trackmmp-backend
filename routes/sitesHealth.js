/**
 * /api/sites/health — at-a-glance status for every owned site.
 *
 * Powers the "My Sites" dashboard.  One row per active inventory unit with:
 *   - script_installed    boolean (any impression or click in last 7 days?)
 *   - ads_txt_status      string  ('verified' | 'not_checked' — live HTTP check
 *                                  is intentionally NOT done here, too slow;
 *                                  a separate cron should set this)
 *   - offers_serving      int     (approved+active+open campaigns for this inv)
 *   - placements_count    int
 *   - clicks_today        int
 *   - signups_today       int
 *   - earned_today        number  (sum of attributed postback payouts)
 *   - last_click_at       unix    (most recent click timestamp)
 *   - issues              array   (list of friendly issue codes for the UI)
 *
 * Intended for a non-tech operator's daily glance.  Issue codes drive the
 * "fix this" buttons on the My Sites page.
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'account_manager'));

router.get('/health', (req, res, next) => {
  try {
    const userId = req.user.id;

    const rows = db.prepare(`
      SELECT
        i.id, i.name, i.domain, i.type, i.vertical, i.geo, i.status, i.created_at,
        (SELECT COUNT(*) FROM placements WHERE inventory_id = i.id AND status = 'active') AS placements_count,
        (SELECT COUNT(*) FROM campaign_inventory_approvals cia
         JOIN campaigns c ON c.id = cia.campaign_id
         WHERE cia.inventory_id = i.id
           AND cia.status = 'approved'
           AND c.status = 'active'
           AND COALESCE(c.visibility, 'open') != 'private'
        ) AS offers_serving,
        (SELECT COUNT(*) FROM clicks
         WHERE inventory_id = i.id AND created_at >= unixepoch('now', '-1 day')
        ) AS clicks_today,
        (SELECT COUNT(*) FROM postbacks pb
         JOIN clicks cl ON cl.click_id = pb.click_id
         WHERE cl.inventory_id = i.id
           AND pb.status = 'attributed'
           AND pb.created_at >= unixepoch('now', '-1 day')
        ) AS signups_today,
        (SELECT COALESCE(SUM(pb.payout), 0) FROM postbacks pb
         JOIN clicks cl ON cl.click_id = pb.click_id
         WHERE cl.inventory_id = i.id
           AND pb.status = 'attributed'
           AND pb.created_at >= unixepoch('now', '-1 day')
        ) AS earned_today,
        (SELECT MAX(created_at) FROM clicks WHERE inventory_id = i.id) AS last_click_at,
        (SELECT MAX(created_at) FROM impressions WHERE inventory_id = i.id) AS last_impression_at
      FROM owned_inventory i
      WHERE i.user_id = ? AND i.status = 'active'
      ORDER BY earned_today DESC, clicks_today DESC, i.name ASC
    `).all(userId);

    const now = Math.floor(Date.now() / 1000);
    const SEVEN_DAYS = 7 * 86400;

    const sites = rows.map(r => {
      const recentActivity = Math.max(r.last_click_at || 0, r.last_impression_at || 0);
      const script_installed = recentActivity > 0 && (now - recentActivity) < SEVEN_DAYS;

      // ads.txt verification — we don't ping the live site here (would slow
      // this endpoint to seconds).  A separate background job should populate
      // an `ads_txt_verified_at` column on inventory.  Until then:
      const ads_txt_status = 'not_checked';

      const issues = [];
      if (!script_installed)         issues.push({ code: 'script_not_installed', level: 'high', msg: 'No clicks or impressions in 7 days — SDK may not be installed.' });
      if (r.placements_count === 0)  issues.push({ code: 'no_placements',        level: 'high', msg: 'No placements defined — add at least one ad slot.' });
      if (r.offers_serving === 0)    issues.push({ code: 'no_offers',            level: 'medium', msg: 'No campaigns approved for this site — visitors see nothing.' });
      if (script_installed && r.clicks_today === 0 && r.last_click_at && (now - r.last_click_at) > 86400) {
        issues.push({ code: 'no_traffic_today', level: 'low', msg: 'Had clicks before but none today.' });
      }

      // Crude missed revenue estimate: visitors today (impressions) ×
      // industry-average $0.50 RPM × (1 - fill rate).  Only meaningful when
      // we have impressions but no earnings.
      const missed_revenue_estimate =
        (r.clicks_today === 0 && r.offers_serving === 0 && script_installed)
          ? null   // can't estimate without traffic data — UI shows "—"
          : 0;

      return {
        id:                 r.id,
        name:               r.name,
        domain:             r.domain,
        type:               r.type,
        vertical:           r.vertical,
        geo:                r.geo,
        script_installed,
        ads_txt_status,
        placements_count:   r.placements_count,
        offers_serving:     r.offers_serving,
        clicks_today:       r.clicks_today,
        signups_today:      r.signups_today,
        earned_today:       Number(r.earned_today) || 0,
        conversion_rate:    r.clicks_today > 0 ? Number((r.signups_today / r.clicks_today * 100).toFixed(2)) : null,
        last_click_at:      r.last_click_at,
        last_impression_at: r.last_impression_at,
        missed_revenue_estimate,
        issues,
        health_score:       computeHealthScore(r, script_installed),
      };
    });

    // Aggregate summary for the page header
    const summary = {
      total_sites:         sites.length,
      live_and_earning:    sites.filter(s => s.earned_today > 0).length,
      ready_no_traffic:    sites.filter(s => s.script_installed && s.offers_serving > 0 && s.clicks_today === 0).length,
      needs_setup:         sites.filter(s => !s.script_installed || s.offers_serving === 0).length,
      earned_today_total:  Number(sites.reduce((s, x) => s + (x.earned_today || 0), 0).toFixed(2)),
      clicks_today_total:  sites.reduce((s, x) => s + (x.clicks_today || 0), 0),
      signups_today_total: sites.reduce((s, x) => s + (x.signups_today || 0), 0),
    };

    res.json({ summary, sites });
  } catch (err) { next(err); }
});

// 0–100 quick health score per site — for sorting in the UI
function computeHealthScore(r, scriptInstalled) {
  let s = 0;
  if (scriptInstalled)             s += 30;
  if (r.placements_count > 0)      s += 15;
  if (r.offers_serving > 0)        s += 25;
  if (r.clicks_today > 0)          s += 15;
  if (r.signups_today > 0)         s += 10;
  if (r.earned_today > 0)          s += 5;
  return s;
}

module.exports = router;
