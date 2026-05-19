const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── Fraud Rules CRUD ─────────────────────────────────────────────────────────

// GET /api/fraud/rules
router.get('/rules', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM fraud_rules WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows);
});

// POST /api/fraud/rules
router.post('/rules', requireAdmin, (req, res, next) => {
  try {
    const { name, rule_type, config = {}, action = 'block' } = req.body;
    if (!name)      return res.status(400).json({ error: 'name is required' });
    if (!rule_type) return res.status(400).json({ error: 'rule_type is required' });

    const result = db.prepare(`
      INSERT INTO fraud_rules (user_id, name, rule_type, config, action)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, name, rule_type, JSON.stringify(config), action);

    res.status(201).json(db.prepare('SELECT * FROM fraud_rules WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// PUT /api/fraud/rules/:id
router.put('/rules/:id', requireAdmin, (req, res, next) => {
  try {
    const rule = db.prepare('SELECT id FROM fraud_rules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    const { name, rule_type, config, action, status } = req.body;
    db.prepare(`
      UPDATE fraud_rules SET
        name      = COALESCE(?, name),
        rule_type = COALESCE(?, rule_type),
        config    = COALESCE(?, config),
        action    = COALESCE(?, action),
        status    = COALESCE(?, status),
        updated_at = unixepoch()
      WHERE id = ?
    `).run(name || null, rule_type || null,
           config != null ? JSON.stringify(config) : null,
           action || null, status || null, rule.id);
    res.json(db.prepare('SELECT * FROM fraud_rules WHERE id = ?').get(rule.id));
  } catch (err) { next(err); }
});

// DELETE /api/fraud/rules/:id
router.delete('/rules/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM fraud_rules WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ── Fraud Logs ───────────────────────────────────────────────────────────────

// admin sees all fraud logs (no user_id filter)
router.get('/', requireAdmin, (req, res) => {
  const { from, to, campaign_id, fraud_type, page = 1, limit = 50 } = req.query;
  const conditions = ['1=1'];
  const values = [];
  if (from) { conditions.push("date(fl.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(fl.created_at,'unixepoch') <= ?"); values.push(to); }
  if (campaign_id) { conditions.push('fl.campaign_id = ?'); values.push(campaign_id); }
  if (fraud_type)  { conditions.push('fl.fraud_type = ?'); values.push(fraud_type); }

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const rows = db.prepare(`
    SELECT fl.*, c.name AS campaign_name
    FROM fraud_log fl
    LEFT JOIN campaigns c ON c.id = fl.campaign_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY fl.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, parseInt(limit), offset);

  const total = db.prepare(`SELECT COUNT(*) as n FROM fraud_log fl WHERE ${conditions.join(' AND ')}`).get(...values).n;
  res.json({ rows, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/summary', requireAdmin, (req, res) => {
  const summary = db.prepare(`
    SELECT fraud_type, COUNT(*) as count, action
    FROM fraud_log
    GROUP BY fraud_type, action
    ORDER BY count DESC
  `).all();
  res.json(summary);
});

// ── CTIT (Click-to-Install Time) Analysis ───────────────────────────────────

router.get('/ctit-analysis', requireAdmin, (req, res) => {
  try {
    const { from, to, campaign_id } = req.query;
    const conditions = ["pb.status = 'attributed'", 'pb.ctit_seconds IS NOT NULL'];
    const values = [];

    if (from) { conditions.push("date(pb.created_at,'unixepoch') >= ?"); values.push(from); }
    if (to)   { conditions.push("date(pb.created_at,'unixepoch') <= ?"); values.push(to); }
    if (campaign_id) { conditions.push('pb.campaign_id = ?'); values.push(+campaign_id); }

    const where = conditions.join(' AND ');

    // Average CTIT per campaign
    const byCampaign = db.prepare(`
      SELECT pb.campaign_id, c.name AS campaign_name,
             ROUND(AVG(pb.ctit_seconds), 1) AS avg_ctit,
             MIN(pb.ctit_seconds) AS min_ctit,
             MAX(pb.ctit_seconds) AS max_ctit,
             COUNT(*) AS total,
             SUM(CASE WHEN pb.ctit_seconds < 10 THEN 1 ELSE 0 END) AS click_injection_count,
             SUM(CASE WHEN pb.ctit_seconds > 604800 THEN 1 ELSE 0 END) AS organic_leak_count
      FROM postbacks pb
      LEFT JOIN campaigns c ON c.id = pb.campaign_id
      WHERE ${where}
      GROUP BY pb.campaign_id
      ORDER BY avg_ctit ASC
    `).all(...values);

    // Average CTIT per publisher
    const byPublisher = db.prepare(`
      SELECT cl.publisher_id, p.name AS publisher_name,
             ROUND(AVG(pb.ctit_seconds), 1) AS avg_ctit,
             MIN(pb.ctit_seconds) AS min_ctit,
             MAX(pb.ctit_seconds) AS max_ctit,
             COUNT(*) AS total,
             SUM(CASE WHEN pb.ctit_seconds < 10 THEN 1 ELSE 0 END) AS click_injection_count,
             SUM(CASE WHEN pb.ctit_seconds > 604800 THEN 1 ELSE 0 END) AS organic_leak_count
      FROM postbacks pb
      JOIN clicks cl ON cl.click_id = pb.click_id
      LEFT JOIN publishers p ON p.id = cl.publisher_id
      WHERE ${where} AND cl.publisher_id IS NOT NULL
      GROUP BY cl.publisher_id
      ORDER BY avg_ctit ASC
    `).all(...values);

    // Overall suspicious counts
    const suspicious = db.prepare(`
      SELECT
        SUM(CASE WHEN pb.ctit_seconds < 10 THEN 1 ELSE 0 END) AS click_injection_count,
        SUM(CASE WHEN pb.ctit_seconds > 604800 THEN 1 ELSE 0 END) AS organic_leak_count,
        COUNT(*) AS total_attributed
      FROM postbacks pb
      WHERE ${where}
    `).get(...values);

    // CTIT distribution buckets (for histogram)
    const distribution = db.prepare(`
      SELECT
        CASE
          WHEN pb.ctit_seconds < 10       THEN '0-10s (suspicious)'
          WHEN pb.ctit_seconds < 60       THEN '10-60s'
          WHEN pb.ctit_seconds < 3600     THEN '1-60min'
          WHEN pb.ctit_seconds < 86400    THEN '1-24hr'
          WHEN pb.ctit_seconds < 604800   THEN '1-7d'
          ELSE '7d+ (suspicious)'
        END AS bucket,
        COUNT(*) AS count
      FROM postbacks pb
      WHERE ${where}
      GROUP BY bucket
      ORDER BY MIN(pb.ctit_seconds) ASC
    `).all(...values);

    res.json({ by_campaign: byCampaign, by_publisher: byPublisher, suspicious, distribution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
