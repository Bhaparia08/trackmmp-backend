/**
 * Incrementality test runner — retrospective analysis on existing clicks.
 *
 * Concept: pick a campaign + date window + holdout %. Devices in the window
 * are deterministically split into "exposed" and "holdout" buckets by hashing
 * advertising_id + the test salt. Conversion rates are compared between buckets
 * with a Wald 95% CI and two-tailed z-test p-value.
 *
 * Notes for honesty / scope:
 * - This is retrospective: it bucketizes already-served clicks. It does NOT
 *   actually withhold ads — both buckets received the ad. So lift here measures
 *   noise floor in your audience splits, useful as a sanity check on
 *   randomization and as a UI shell to demo. Real RCT incrementality requires
 *   click-time bucketing that actually suppresses the ad for the holdout.
 * - Stats are exact (Wald CI + normal-CDF p-value); the data interpretation is
 *   the caveat. Documented in the UI.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Lazy-create table on module load (preview-feature pattern).
db.prepare(`
  CREATE TABLE IF NOT EXISTS incrementality_tests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    campaign_id     INTEGER REFERENCES campaigns(id),
    holdout_pct     INTEGER NOT NULL DEFAULT 10,
    from_date       TEXT    NOT NULL,
    to_date         TEXT    NOT NULL,
    test_salt       TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'active',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )
`).run();

// ── Stats helpers ──────────────────────────────────────────────────────────
// Normal CDF (Abramowitz & Stegun 26.2.17) — sufficient for p-values.
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function proportionTest(xExposed, nExposed, xHoldout, nHoldout) {
  if (nExposed === 0 || nHoldout === 0) {
    return { p_exposed: 0, p_holdout: 0, lift_abs: 0, lift_pct: 0, ci_low: 0, ci_high: 0, p_value: 1, z: 0 };
  }
  const p1 = xExposed / nExposed;
  const p2 = xHoldout / nHoldout;
  const diff = p1 - p2;
  const se = Math.sqrt(p1 * (1 - p1) / nExposed + p2 * (1 - p2) / nHoldout);
  const z = se > 0 ? diff / se : 0;
  const pValue = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  const ci = 1.96 * se;
  return {
    p_exposed: +(p1 * 100).toFixed(3),
    p_holdout: +(p2 * 100).toFixed(3),
    lift_abs: +(diff * 100).toFixed(3),
    lift_pct: p2 > 0 ? +(((p1 - p2) / p2) * 100).toFixed(1) : null,
    ci_low: +((diff - ci) * 100).toFixed(3),
    ci_high: +((diff + ci) * 100).toFixed(3),
    p_value: +pValue.toFixed(4),
    z: +z.toFixed(3),
    significant: pValue < 0.05,
  };
}

// Deterministic hash to bucket [0, 99]
function bucketOf(advertising_id, salt) {
  const h = crypto.createHash('sha256').update((advertising_id || '') + '|' + salt).digest();
  return h[0] % 100; // 0–99
}

function genSalt() {
  return crypto.randomBytes(6).toString('hex');
}

// ── CRUD ────────────────────────────────────────────────────────────────────
router.get('/incrementality', (req, res) => {
  const filter = req.user.role === 'admin' ? '' : 'WHERE user_id = ?';
  const args = req.user.role === 'admin' ? [] : [req.user.id];
  const rows = db.prepare(
    `SELECT it.*, c.name AS campaign_name
     FROM incrementality_tests it
     LEFT JOIN campaigns c ON c.id = it.campaign_id
     ${filter}
     ORDER BY it.created_at DESC`
  ).all(...args);
  res.json(rows);
});

router.post('/incrementality', (req, res, next) => {
  try {
    const { name, campaign_id, holdout_pct = 10, from_date, to_date } = req.body || {};
    if (!name || !from_date || !to_date) return res.status(400).json({ error: 'name, from_date, to_date required' });
    const pct = Math.max(1, Math.min(50, parseInt(holdout_pct, 10) || 10));
    const r = db.prepare(
      `INSERT INTO incrementality_tests (user_id, name, campaign_id, holdout_pct, from_date, to_date, test_salt)
       VALUES (?,?,?,?,?,?,?)`
    ).run(req.user.id, name, campaign_id || null, pct, from_date, to_date, genSalt());
    const row = db.prepare('SELECT * FROM incrementality_tests WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.delete('/incrementality/:id', (req, res) => {
  db.prepare('DELETE FROM incrementality_tests WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ── Result computation ─────────────────────────────────────────────────────
router.get('/incrementality/:id/result', (req, res, next) => {
  try {
    const test = db.prepare(
      `SELECT it.*, c.name AS campaign_name FROM incrementality_tests it
       LEFT JOIN campaigns c ON c.id = it.campaign_id WHERE it.id = ?`
    ).get(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    if (req.user.role !== 'admin' && test.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your test' });
    }

    // Pull all clicks in the window for the campaign (if scoped).
    const campaignClause = test.campaign_id ? 'AND cl.campaign_id = ?' : '';
    const args = [test.from_date, test.to_date];
    if (test.campaign_id) args.push(test.campaign_id);

    const clicks = db.prepare(
      `SELECT cl.click_id, cl.advertising_id,
              EXISTS (
                SELECT 1 FROM postbacks pb
                WHERE pb.click_id = cl.click_id
                  AND pb.status = 'attributed'
                  AND pb.event_type = 'install'
              ) AS converted,
              (SELECT COALESCE(SUM(pb.revenue),0) FROM postbacks pb
                WHERE pb.click_id = cl.click_id AND pb.status = 'attributed') AS revenue
       FROM clicks cl
       WHERE date(cl.created_at, 'unixepoch') >= ?
         AND date(cl.created_at, 'unixepoch') <= ?
         ${campaignClause}
         AND cl.advertising_id IS NOT NULL`
    ).all(...args);

    // Bucket each click deterministically.
    let exposedN = 0, exposedConv = 0, exposedRev = 0;
    let holdoutN = 0, holdoutConv = 0, holdoutRev = 0;
    for (const c of clicks) {
      const bucket = bucketOf(c.advertising_id, test.test_salt);
      const isHoldout = bucket < test.holdout_pct;
      if (isHoldout) {
        holdoutN += 1;
        holdoutConv += c.converted ? 1 : 0;
        holdoutRev += c.revenue || 0;
      } else {
        exposedN += 1;
        exposedConv += c.converted ? 1 : 0;
        exposedRev += c.revenue || 0;
      }
    }

    const cvr = proportionTest(exposedConv, exposedN, holdoutConv, holdoutN);

    // Incremental installs: how many of the exposed installs are "extra" vs
    // what we'd expect at the holdout rate. (Floor at 0; can be negative if
    // the test shows a *drop* but that's stored too.)
    const expectedAtHoldoutRate = exposedN * (holdoutN > 0 ? holdoutConv / holdoutN : 0);
    const incrementalInstalls = Math.round(exposedConv - expectedAtHoldoutRate);
    const incrementalPct = exposedConv > 0 ? +((incrementalInstalls / exposedConv) * 100).toFixed(1) : null;

    res.json({
      test,
      summary: {
        clicks_total: clicks.length,
        exposed: { clicks: exposedN, conversions: exposedConv, revenue: +exposedRev.toFixed(2) },
        holdout: { clicks: holdoutN, conversions: holdoutConv, revenue: +holdoutRev.toFixed(2) },
        cvr,
        incremental_installs: incrementalInstalls,
        incremental_pct: incrementalPct,
        non_incremental_pct: incrementalPct !== null ? +(100 - incrementalPct).toFixed(1) : null,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
