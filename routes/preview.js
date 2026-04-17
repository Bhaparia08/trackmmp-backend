/**
 * /api/preview — Preview/test routes for new High Priority features
 * Not linked from main nav. Access via /preview/* routes only.
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ─────────────────────────────────────────────
// 1. COHORT RETENTION REPORT
// Returns a cohort grid: each row = install week,
// each column = Day 1 / Day 3 / Day 7 / Day 14 / Day 30
// ─────────────────────────────────────────────
router.get('/cohort', (req, res) => {
  const { campaign_id, publisher_id, from, to } = req.query;

  let where = 'pb.status = \'attributed\' AND pb.event_type = \'install\'';
  const params = [];

  if (req.user.role === 'advertiser') {
    where += ' AND c.advertiser_id = ?'; params.push(req.user.id);
  }
  if (campaign_id) { where += ' AND pb.campaign_id = ?'; params.push(campaign_id); }
  if (publisher_id) { where += ' AND cl.publisher_id = ?'; params.push(publisher_id); }
  if (from) { where += ' AND date(pb.created_at, \'unixepoch\') >= ?'; params.push(from); }
  if (to)   { where += ' AND date(pb.created_at, \'unixepoch\') <= ?'; params.push(to); }

  // Get all installs with their device ID
  const installs = db.prepare(`
    SELECT pb.advertising_id, pb.created_at AS install_ts,
           strftime('%Y-W%W', pb.created_at, 'unixepoch') AS cohort_week,
           date(pb.created_at, 'unixepoch') AS install_date,
           pb.campaign_id
    FROM postbacks pb
    JOIN campaigns c ON c.id = pb.campaign_id
    LEFT JOIN clicks cl ON cl.click_id = pb.click_id
    WHERE ${where}
    ORDER BY pb.created_at ASC
  `).all(...params);

  if (installs.length === 0) return res.json({ cohorts: [], days: [1, 3, 7, 14, 30] });

  const DAYS = [1, 3, 7, 14, 30];

  // Group by cohort_week
  const weekMap = {};
  for (const row of installs) {
    if (!weekMap[row.cohort_week]) weekMap[row.cohort_week] = { installs: [], week: row.cohort_week };
    weekMap[row.cohort_week].installs.push(row);
  }

  // For each cohort, count how many returned on day N
  const cohorts = [];
  for (const [week, data] of Object.entries(weekMap)) {
    const total = data.installs.length;
    const retention = {};

    for (const day of DAYS) {
      let retained = 0;
      for (const inst of data.installs) {
        if (!inst.advertising_id) continue;
        // Check if this device had any event on install_date + day (±1 day window)
        const windowStart = inst.install_ts + (day - 1) * 86400;
        const windowEnd   = inst.install_ts + (day + 1) * 86400;
        const returned = db.prepare(`
          SELECT 1 FROM postbacks
          WHERE advertising_id = ? AND campaign_id = ?
            AND created_at BETWEEN ? AND ?
            AND status = 'attributed'
          LIMIT 1
        `).get(inst.advertising_id, inst.campaign_id, windowStart, windowEnd);
        if (returned) retained++;
      }
      retention[`day${day}`] = total > 0 ? Math.round((retained / total) * 100) : 0;
    }

    cohorts.push({ week, total, ...retention });
  }

  cohorts.sort((a, b) => a.week.localeCompare(b.week));
  res.json({ cohorts, days: DAYS });
});

// ─────────────────────────────────────────────
// 2. CONVERSION FUNNEL
// Per campaign: clicks → installs → events (by event type)
// ─────────────────────────────────────────────
router.get('/funnel', (req, res) => {
  const { from, to, publisher_id } = req.query;

  let dateClause = '';
  const params = [];
  if (from) { dateClause += ' AND date(cl.created_at, \'unixepoch\') >= ?'; params.push(from); }
  if (to)   { dateClause += ' AND date(cl.created_at, \'unixepoch\') <= ?'; params.push(to); }

  let userClause = '';
  if (req.user.role === 'advertiser') {
    userClause = ' AND c.advertiser_id = ' + req.user.id;
  }

  let pubClause = '';
  if (publisher_id) pubClause = ' AND cl.publisher_id = ' + parseInt(publisher_id);

  const campaigns = db.prepare(`
    SELECT c.id, c.name,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
      COUNT(DISTINCT CASE WHEN cl.status = 'converted' THEN cl.id END) AS events,
      COALESCE(SUM(CASE WHEN pb.status='attributed' THEN pb.revenue END), 0) AS revenue
    FROM campaigns c
    LEFT JOIN clicks cl ON cl.campaign_id = c.id ${dateClause} ${pubClause}
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE c.status != 'archived' ${userClause}
    GROUP BY c.id
    HAVING clicks > 0
    ORDER BY clicks DESC
    LIMIT 20
  `).all(...params);

  // Per-campaign top events breakdown
  const result = campaigns.map(camp => {
    const events = db.prepare(`
      SELECT pb.event_name, COUNT(*) AS count, SUM(pb.revenue) AS revenue
      FROM postbacks pb
      WHERE pb.campaign_id = ? AND pb.status = 'attributed' AND pb.event_name IS NOT NULL
      GROUP BY pb.event_name
      ORDER BY count DESC
      LIMIT 5
    `).all(camp.id);

    const cvr = camp.clicks > 0 ? ((camp.installs / camp.clicks) * 100).toFixed(1) : '0.0';
    const ecvr = camp.installs > 0 ? ((camp.events / camp.installs) * 100).toFixed(1) : '0.0';

    return { ...camp, cvr: parseFloat(cvr), ecvr: parseFloat(ecvr), top_events: events };
  });

  res.json(result);
});

// ─────────────────────────────────────────────
// 3. PUBLISHER PAYOUT REPORT
// Per publisher per period: clicks, installs, earned payout, pending
// ─────────────────────────────────────────────
router.get('/payouts', (req, res) => {
  const { from, to, publisher_id } = req.query;
  if (req.user.role !== 'admin' && req.user.role !== 'account_manager') {
    return res.status(403).json({ error: 'Admin only' });
  }

  let dateFilter = '';
  const params = [];
  if (from) { dateFilter += ' AND date(pb.created_at,\'unixepoch\') >= ?'; params.push(from); }
  if (to)   { dateFilter += ' AND date(pb.created_at,\'unixepoch\') <= ?'; params.push(to); }
  if (publisher_id) { dateFilter += ' AND cl.publisher_id = ?'; params.push(publisher_id); }

  const rows = db.prepare(`
    SELECT
      p.id AS publisher_id,
      p.name AS publisher_name,
      p.email,
      p.pub_token,
      p.status AS pub_status,
      COUNT(DISTINCT cl.id) AS total_clicks,
      COUNT(DISTINCT CASE WHEN pb.status='attributed' AND pb.event_type='install' THEN pb.id END) AS total_installs,
      COUNT(DISTINCT CASE WHEN pb.status='attributed' THEN pb.id END) AS total_conversions,
      COALESCE(SUM(CASE WHEN pb.status='attributed' THEN pb.payout END), 0) AS total_earned,
      COALESCE(SUM(CASE WHEN pb.status='attributed' AND pb.event_type='install' THEN pb.payout END), 0) AS install_payout,
      COALESCE(SUM(CASE WHEN pb.status='attributed' AND pb.event_type != 'install' THEN pb.payout END), 0) AS event_payout
    FROM publishers p
    LEFT JOIN clicks cl ON cl.publisher_id = p.id
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id ${dateFilter}
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY total_earned DESC
  `).all(...params, req.user.id);

  // Top campaign per publisher
  const result = rows.map(pub => {
    const topCampaigns = db.prepare(`
      SELECT c.name, COUNT(DISTINCT cl2.id) AS clicks,
        COALESCE(SUM(CASE WHEN pb2.status='attributed' THEN pb2.payout END),0) AS payout
      FROM clicks cl2
      JOIN campaigns c ON c.id = cl2.campaign_id
      LEFT JOIN postbacks pb2 ON pb2.click_id = cl2.click_id
      WHERE cl2.publisher_id = ?
      GROUP BY c.id ORDER BY payout DESC LIMIT 3
    `).all(pub.publisher_id);
    return { ...pub, top_campaigns: topCampaigns };
  });

  res.json(result);
});

// ─────────────────────────────────────────────
// 4. CAMPAIGN GOALS OVERVIEW
// All goals across all campaigns with performance stats
// ─────────────────────────────────────────────
router.get('/goals', (req, res) => {
  let userClause = 'cg.user_id = ?';
  const params = [req.user.id];

  const goals = db.prepare(`
    SELECT cg.*,
      c.name AS campaign_name,
      c.campaign_token,
      COUNT(DISTINCT pb.id) AS total_hits,
      COALESCE(SUM(pb.payout), 0) AS total_payout,
      COALESCE(SUM(pb.revenue), 0) AS total_revenue
    FROM campaign_goals cg
    JOIN campaigns c ON c.id = cg.campaign_id
    LEFT JOIN postbacks pb ON pb.goal_id = cg.id AND pb.status = 'attributed'
    WHERE ${userClause}
    GROUP BY cg.id
    ORDER BY c.name, cg.is_default DESC, cg.name
  `).all(...params);

  res.json(goals);
});

// POST goal
router.post('/goals', (req, res, next) => {
  try {
    const { campaign_id, name, event_name, payout = 0, revenue = 0, payout_type = 'cpi', postback_url = '', is_default = 0 } = req.body;
    if (!campaign_id || !name) return res.status(400).json({ error: 'campaign_id and name required' });
    const result = db.prepare(`
      INSERT INTO campaign_goals (campaign_id, user_id, name, event_name, payout, revenue, payout_type, postback_url, is_default, status)
      VALUES (?,?,?,?,?,?,?,?,?,\'active\')
    `).run(campaign_id, req.user.id, name, event_name||null, payout, revenue, payout_type, postback_url, is_default ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM campaign_goals WHERE id=?').get(result.lastInsertRowid));
  } catch(err) { next(err); }
});

// PUT goal
router.put('/goals/:id', (req, res, next) => {
  try {
    const { name, event_name, payout, revenue, payout_type, postback_url, is_default, status } = req.body;
    db.prepare(`UPDATE campaign_goals SET
      name=COALESCE(?,name), event_name=COALESCE(?,event_name),
      payout=COALESCE(?,payout), revenue=COALESCE(?,revenue),
      payout_type=COALESCE(?,payout_type), postback_url=COALESCE(?,postback_url),
      is_default=COALESCE(?,is_default), status=COALESCE(?,status)
      WHERE id=? AND user_id=?`)
      .run(name||null, event_name||null, payout??null, revenue??null,
           payout_type||null, postback_url||null, is_default??null, status||null,
           req.params.id, req.user.id);
    res.json(db.prepare('SELECT * FROM campaign_goals WHERE id=?').get(req.params.id));
  } catch(err) { next(err); }
});

// DELETE goal
router.delete('/goals/:id', (req, res, next) => {
  try {
    db.prepare('DELETE FROM campaign_goals WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch(err) { next(err); }
});

// ─────────────────────────────────────────────
// 5. BULK ACTIONS
// Bulk update status for campaigns or publishers
// ─────────────────────────────────────────────
router.post('/bulk', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { type, ids, status } = req.body;
    if (!type || !Array.isArray(ids) || ids.length === 0 || !status) {
      return res.status(400).json({ error: 'type, ids[], status required' });
    }
    const allowed = {
      campaigns: ['active', 'paused', 'archived'],
      publishers: ['active', 'suspended'],
    };
    if (!allowed[type]) return res.status(400).json({ error: 'type must be campaigns or publishers' });
    if (!allowed[type].includes(status)) return res.status(400).json({ error: `Invalid status for ${type}` });

    const placeholders = ids.map(() => '?').join(',');
    const table = type === 'campaigns' ? 'campaigns' : 'publishers';
    const extraSet = type === 'campaigns' ? ', updated_at=unixepoch()' : '';
    const result = db.prepare(
      `UPDATE ${table} SET status=? ${extraSet} WHERE id IN (${placeholders})`
    ).run(status, ...ids.map(Number));

    res.json({ updated: result.changes, ids, status });
  } catch(err) { next(err); }
});

// GET campaigns list for bulk (with checkboxes support)
router.get('/bulk/campaigns', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT c.id, c.name, c.status, c.visibility, c.payout, c.payout_type,
      COALESCE(u.name, c.advertiser_name) AS advertiser,
      COUNT(DISTINCT cl.id) AS total_clicks,
      COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS total_installs
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.advertiser_id
    LEFT JOIN clicks cl ON cl.campaign_id = c.id
    WHERE c.status != 'archived'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();
  res.json(rows);
});

router.get('/bulk/publishers', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT p.id, p.name, p.email, p.pub_token, p.status,
      COUNT(DISTINCT cl.id) AS total_clicks,
      COALESCE(SUM(CASE WHEN pb.status='attributed' THEN pb.payout END),0) AS total_earned
    FROM publishers p
    LEFT JOIN clicks cl ON cl.publisher_id = p.id
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id
    WHERE p.user_id = ?
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

module.exports = router;
