const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/fraud?from=&to=&campaign_id=&fraud_type=
router.get('/', requireAdmin, (req, res) => {
  const { from, to, campaign_id, fraud_type, page = 1, limit = 50 } = req.query;
  const conditions = ['fl.user_id = ?'];
  const values = [req.user.id];
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

// GET /api/fraud/summary
router.get('/summary', requireAdmin, (req, res) => {
  const summary = db.prepare(`
    SELECT fraud_type, COUNT(*) as count, action
    FROM fraud_log WHERE user_id = ?
    GROUP BY fraud_type, action
    ORDER BY count DESC
  `).all(req.user.id);
  res.json(summary);
});

module.exports = router;
