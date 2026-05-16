/**
 * /api/preview/predicted-ltv — Predictive D7/D30 LTV per recent cohort.
 *
 * Method (kept honest + interpretable, not a black-box ML model):
 *   1. Build "training" baselines from MATURE cohorts (installed ≥ 30 days ago):
 *      for each segment (default: campaign_id), compute mean D30 ARPU + std
 *      + sample size + mean D0 ARPU + mean D7 ARPU. These are the segment
 *      historical baselines.
 *   2. For each RECENT install cohort (last 30 days), look up its segment's
 *      historical D30 ARPU. Adjust for observed D0 revenue: if this cohort's
 *      D0 ARPU diverges from the segment's mean D0 ARPU by a factor f, scale
 *      the predicted D30 ARPU by f (bounded to [0.25, 4.0] to avoid extremes).
 *   3. Report 95% confidence interval from Wald on the segment mean
 *      (std/sqrt(n)), plus a confidence label based on sample size.
 *
 * This is a deliberately simple model. It's transparent, fast, and good enough
 * for the data volumes most TrackMMP tenants have. Swap for XGBoost/PyMC once
 * any segment has 1000+ installs and you have non-linear interaction effects.
 */

const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const DEFAULT_MATURITY_DAYS = 30;
const FALLBACK_MATURITY_LADDER = [30, 21, 14, 7];
const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

// Confidence band from segment sample size.
function confidenceLabel(n) {
  if (n >= 100) return 'high';
  if (n >= 30)  return 'medium';
  if (n >= 10)  return 'low';
  return 'insufficient';
}

router.get('/predicted-ltv', (req, res, next) => {
  try {
    const { campaign_id } = req.query;
    const now = NOW();

    // Maturity selection:
    //   - explicit override via ?maturity_days=N
    //   - else auto-pick largest ladder rung that yields ≥1 mature device,
    //     so demo data with limited history still produces meaningful results.
    let MATURITY_DAYS = parseInt(req.query.maturity_days, 10);
    let maturityAutoSelected = false;
    if (!MATURITY_DAYS || MATURITY_DAYS < 1) {
      maturityAutoSelected = true;
      // Quick probe: oldest install for scope
      const probeArgs = [];
      const probeUserFilter = req.user.role === 'advertiser' ? 'AND c.advertiser_id = ?' : '';
      if (req.user.role === 'advertiser') probeArgs.push(req.user.id);
      const probeCampFilter = campaign_id ? 'AND pb.campaign_id = ?' : '';
      if (campaign_id) probeArgs.push(campaign_id);
      const oldest = db.prepare(
        `SELECT MIN(pb.created_at) AS oldest FROM postbacks pb
         JOIN campaigns c ON c.id = pb.campaign_id
         WHERE pb.status='attributed' AND pb.event_type='install' AND pb.advertising_id IS NOT NULL
           ${probeUserFilter} ${probeCampFilter}`
      ).get(...probeArgs);
      const oldestAgeDays = oldest?.oldest ? Math.floor((now - oldest.oldest) / DAY) : 0;
      MATURITY_DAYS = DEFAULT_MATURITY_DAYS;
      for (const rung of FALLBACK_MATURITY_LADDER) {
        if (oldestAgeDays >= rung) { MATURITY_DAYS = rung; break; }
      }
    }
    const maturityCutoff = now - MATURITY_DAYS * DAY;
    const recentCutoff   = now - MATURITY_DAYS * DAY; // installs newer than this are "recent"

    // Role scope (advertiser sees only their own data).
    const userFilter = req.user.role === 'advertiser' ? 'AND c.advertiser_id = ?' : '';
    const userArgs = req.user.role === 'advertiser' ? [req.user.id] : [];
    const campaignFilter = campaign_id ? 'AND pb.campaign_id = ?' : '';
    const campaignArgs = campaign_id ? [campaign_id] : [];

    // 1. Per-device first-install timestamps (the "cohort key" per device).
    //    Joining campaigns to allow advertiser scoping.
    const installs = db.prepare(`
      SELECT pb.advertising_id,
             pb.campaign_id,
             MIN(pb.created_at) AS install_ts
      FROM postbacks pb
      JOIN campaigns c ON c.id = pb.campaign_id
      WHERE pb.status = 'attributed'
        AND pb.event_type = 'install'
        AND pb.advertising_id IS NOT NULL
        ${userFilter}
        ${campaignFilter}
      GROUP BY pb.advertising_id
    `).all(...userArgs, ...campaignArgs);

    if (installs.length === 0) {
      return res.json({ segments: [], recent_cohorts: [], note: 'No installs with advertising_id yet.' });
    }

    // 2. Pull all revenue postbacks for those devices.
    const idList = installs.map(r => r.advertising_id);
    const revByDevice = new Map();
    const CHUNK = 800;
    for (let i = 0; i < idList.length; i += CHUNK) {
      const chunk = idList.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT pb.advertising_id, pb.created_at AS ts, COALESCE(pb.revenue,0) AS revenue
        FROM postbacks pb
        WHERE pb.status = 'attributed'
          AND pb.advertising_id IN (${placeholders})
      `).all(...chunk);
      for (const r of rows) {
        if (!revByDevice.has(r.advertising_id)) revByDevice.set(r.advertising_id, []);
        revByDevice.get(r.advertising_id).push({ ts: r.ts, revenue: r.revenue });
      }
    }

    // 3. Compute per-device features: D0 rev, D-mid rev, D-target rev, is_mature.
    //    D-mid = floor(MATURITY/2), used as the early-signal day; D-target is
    //    the prediction horizon. With MATURITY=30 these are 7/30 as before.
    const D_MID = Math.max(1, Math.floor(MATURITY_DAYS / 2));
    const deviceFeatures = installs.map(inst => {
      const evs = revByDevice.get(inst.advertising_id) || [];
      let d0 = 0, dMid = 0, dTarget = 0;
      for (const e of evs) {
        const daysSince = Math.floor((e.ts - inst.install_ts) / DAY);
        if (daysSince < 0) continue;
        if (daysSince <= 0)             d0      += e.revenue;
        if (daysSince <= D_MID)         dMid    += e.revenue;
        if (daysSince <= MATURITY_DAYS) dTarget += e.revenue;
      }
      const isMature = (now - inst.install_ts) >= MATURITY_DAYS * DAY;
      return {
        advertising_id: inst.advertising_id,
        campaign_id: inst.campaign_id,
        install_ts: inst.install_ts,
        install_date: new Date(inst.install_ts * 1000).toISOString().slice(0, 10),
        d0_revenue: d0,
        d7_revenue: dMid,        // kept key name for stable frontend
        d30_revenue: dTarget,    // kept key name for stable frontend
        is_mature: isMature,
      };
    });

    // 4. Build segment baselines from MATURE devices, grouped by campaign_id.
    const segments = new Map(); // segment_key → stats
    for (const f of deviceFeatures) {
      if (!f.is_mature) continue;
      const key = f.campaign_id || 0;
      if (!segments.has(key)) segments.set(key, {
        segment_key: key, n: 0,
        d0_sum: 0, d7_sum: 0, d30_sum: 0,
        d30_sq_sum: 0,
      });
      const s = segments.get(key);
      s.n += 1;
      s.d0_sum  += f.d0_revenue;
      s.d7_sum  += f.d7_revenue;
      s.d30_sum += f.d30_revenue;
      s.d30_sq_sum += f.d30_revenue * f.d30_revenue;
    }

    // Finalize segment stats: mean + sample stddev.
    const segmentStats = Array.from(segments.values()).map(s => {
      const mean_d0 = s.d0_sum / s.n;
      const mean_d7 = s.d7_sum / s.n;
      const mean_d30 = s.d30_sum / s.n;
      const variance = s.n > 1 ? Math.max(0, (s.d30_sq_sum - s.n * mean_d30 * mean_d30) / (s.n - 1)) : 0;
      const std_d30 = Math.sqrt(variance);
      const se = s.n > 0 ? std_d30 / Math.sqrt(s.n) : 0;
      const ci_low  = +(Math.max(0, mean_d30 - 1.96 * se)).toFixed(3);
      const ci_high = +(mean_d30 + 1.96 * se).toFixed(3);
      const campaignRow = s.segment_key ? db.prepare('SELECT name FROM campaigns WHERE id = ?').get(s.segment_key) : null;
      return {
        segment_key: s.segment_key,
        campaign_name: campaignRow?.name || '(unknown)',
        sample_n: s.n,
        mean_d0_arpu: +mean_d0.toFixed(4),
        mean_d7_arpu: +mean_d7.toFixed(4),
        mean_d30_arpu: +mean_d30.toFixed(4),
        std_d30: +std_d30.toFixed(4),
        ci_low_d30: ci_low,
        ci_high_d30: ci_high,
        confidence: confidenceLabel(s.n),
      };
    }).sort((a, b) => b.sample_n - a.sample_n);

    // 5. For each RECENT install cohort (grouped by install_date + campaign),
    //    compute predicted D30 by:
    //      base = segment.mean_d30
    //      adjustment factor = cohort_mean_d0 / segment.mean_d0   (clamped to [0.25, 4])
    //      predicted_d30 = base * factor
    //    Cohort = (install_date, campaign_id)
    const cohorts = new Map();
    for (const f of deviceFeatures) {
      const key = f.install_date + '|' + (f.campaign_id || 0);
      if (!cohorts.has(key)) cohorts.set(key, {
        install_date: f.install_date,
        campaign_id: f.campaign_id || null,
        is_mature_cohort: f.is_mature, // approximate; all devices in same cohort have same maturity
        n: 0, d0_sum: 0, d7_sum: 0, d30_sum_to_date: 0,
      });
      const c = cohorts.get(key);
      c.n += 1;
      c.d0_sum += f.d0_revenue;
      c.d7_sum += f.d7_revenue;
      c.d30_sum_to_date += f.d30_revenue;
    }

    const segmentById = new Map(segmentStats.map(s => [s.segment_key, s]));

    const recentCohorts = Array.from(cohorts.values())
      .sort((a, b) => b.install_date.localeCompare(a.install_date))
      .slice(0, 40)
      .map(c => {
        const seg = segmentById.get(c.campaign_id || 0);
        const observed_d0 = c.n > 0 ? c.d0_sum / c.n : 0;
        const observed_d7 = c.n > 0 ? c.d7_sum / c.n : 0;
        const observed_d30 = c.is_mature_cohort && c.n > 0 ? c.d30_sum_to_date / c.n : null;

        let predicted_d30 = null;
        let predicted_d7 = null;
        let factor = 1;
        let confidence = 'insufficient';
        if (seg && seg.sample_n >= 10) {
          if (seg.mean_d0_arpu > 0.0001) {
            factor = observed_d0 / seg.mean_d0_arpu;
            factor = Math.max(0.25, Math.min(4, factor));
          }
          predicted_d30 = +(seg.mean_d30_arpu * factor).toFixed(4);
          predicted_d7  = +(seg.mean_d7_arpu  * factor).toFixed(4);
          confidence = seg.confidence;
        }

        return {
          install_date: c.install_date,
          campaign_id: c.campaign_id,
          campaign_name: seg?.campaign_name || '(unknown)',
          cohort_size: c.n,
          observed_d0_arpu: +observed_d0.toFixed(4),
          observed_d7_arpu: +observed_d7.toFixed(4),
          observed_d30_arpu: observed_d30 !== null ? +observed_d30.toFixed(4) : null,
          predicted_d7_arpu: predicted_d7,
          predicted_d30_arpu: predicted_d30,
          prediction_factor: +factor.toFixed(2),
          confidence,
        };
      });

    res.json({
      method: 'segment-baseline + D0-revenue adjustment',
      maturity_days: MATURITY_DAYS,
      maturity_auto_selected: maturityAutoSelected,
      mid_day: D_MID,
      segments: segmentStats,
      recent_cohorts: recentCohorts,
      meta: {
        total_devices: deviceFeatures.length,
        mature_devices: deviceFeatures.filter(f => f.is_mature).length,
        segments_with_baseline: segmentStats.length,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
