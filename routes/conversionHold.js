const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('admin', 'account_manager'));

// GET /held — list held conversions, filterable by campaign_id, from, to
router.get('/held', (req, res) => {
  const { campaign_id, from, to, limit = 100, offset = 0 } = req.query;

  let where = "WHERE p.hold_status = 'held'";
  const params = [];

  if (campaign_id) {
    where += ' AND p.campaign_id = ?';
    params.push(+campaign_id);
  }
  if (from) {
    where += ' AND p.created_at >= ?';
    params.push(+from);
  }
  if (to) {
    where += ' AND p.created_at <= ?';
    params.push(+to);
  }

  const rows = db.prepare(`
    SELECT p.*, c.name AS campaign_name
    FROM postbacks p
    LEFT JOIN campaigns c ON c.id = p.campaign_id
    ${where}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, +limit, +offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM postbacks p ${where}
  `).get(...params).n;

  res.json({ held: rows, total });
});

// PUT /:id/confirm — manually confirm a held conversion
router.put('/:id/confirm', (req, res) => {
  const pb = db.prepare('SELECT * FROM postbacks WHERE id = ?').get(+req.params.id);
  if (!pb) return res.status(404).json({ error: 'Postback not found' });
  if (pb.hold_status !== 'held') return res.status(400).json({ error: 'Postback is not on hold' });

  db.prepare("UPDATE postbacks SET status = 'attributed', hold_status = 'confirmed' WHERE id = ?")
    .run(pb.id);

  res.json({ success: true, id: pb.id, status: 'attributed', hold_status: 'confirmed' });
});

// PUT /:id/reject — reject a held conversion
router.put('/:id/reject', (req, res) => {
  const pb = db.prepare('SELECT * FROM postbacks WHERE id = ?').get(+req.params.id);
  if (!pb) return res.status(404).json({ error: 'Postback not found' });
  if (pb.hold_status !== 'held') return res.status(400).json({ error: 'Postback is not on hold' });

  db.prepare("UPDATE postbacks SET status = 'rejected', hold_status = 'rejected_by_advertiser' WHERE id = ?")
    .run(pb.id);

  res.json({ success: true, id: pb.id, status: 'rejected', hold_status: 'rejected_by_advertiser' });
});

// POST /bulk — bulk confirm or reject
router.post('/bulk', (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  if (!['confirm', 'reject'].includes(action)) return res.status(400).json({ error: "action must be 'confirm' or 'reject'" });

  const newStatus = action === 'confirm' ? 'attributed' : 'rejected';
  const newHoldStatus = action === 'confirm' ? 'confirmed' : 'rejected_by_advertiser';

  const update = db.prepare(`UPDATE postbacks SET status = ?, hold_status = ? WHERE id = ? AND hold_status = 'held'`);
  const tx = db.transaction((idList) => {
    let updated = 0;
    for (const id of idList) {
      const result = update.run(newStatus, newHoldStatus, +id);
      updated += result.changes;
    }
    return updated;
  });

  const updated = tx(ids);
  res.json({ success: true, updated, total: ids.length });
});

// GET /stats — summary counts by hold_status, grouped by campaign
router.get('/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN hold_status = 'held' THEN 1 ELSE 0 END) AS total_held,
      SUM(CASE WHEN hold_status = 'confirmed' THEN 1 ELSE 0 END) AS total_confirmed,
      SUM(CASE WHEN hold_status = 'rejected_by_advertiser' THEN 1 ELSE 0 END) AS total_rejected
    FROM postbacks
    WHERE hold_status != '' AND hold_status IS NOT NULL
  `).get();

  const byCampaign = db.prepare(`
    SELECT p.campaign_id, c.name AS campaign_name,
      SUM(CASE WHEN p.hold_status = 'held' THEN 1 ELSE 0 END) AS held,
      SUM(CASE WHEN p.hold_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN p.hold_status = 'rejected_by_advertiser' THEN 1 ELSE 0 END) AS rejected
    FROM postbacks p
    LEFT JOIN campaigns c ON c.id = p.campaign_id
    WHERE p.hold_status != '' AND p.hold_status IS NOT NULL
    GROUP BY p.campaign_id
    ORDER BY held DESC
  `).all();

  res.json({ totals, by_campaign: byCampaign });
});

module.exports = router;
