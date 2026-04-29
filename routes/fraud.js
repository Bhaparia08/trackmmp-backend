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

module.exports = router;
