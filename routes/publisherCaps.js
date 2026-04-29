/**
 * Per-Publisher Caps  —  /api/campaigns/:campaign_id/publisher-caps
 *
 * Lets admins set per-publisher daily/monthly/total click caps on a campaign.
 * These override the global campaign caps for that specific publisher.
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/campaigns/:campaign_id/publisher-caps
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT pc.*, p.name AS publisher_name, p.pub_token
    FROM publisher_caps pc
    JOIN publishers p ON p.id = pc.publisher_id
    WHERE pc.campaign_id = ?
    ORDER BY p.name ASC
  `).all(req.params.campaign_id);
  res.json(rows);
});

// POST /api/campaigns/:campaign_id/publisher-caps
router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { publisher_id, cap_daily = 0, cap_monthly = 0, cap_total = 0 } = req.body;
    if (!publisher_id) return res.status(400).json({ error: 'publisher_id is required' });

    const result = db.prepare(`
      INSERT INTO publisher_caps (campaign_id, publisher_id, user_id, cap_daily, cap_monthly, cap_total)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, publisher_id) DO UPDATE SET
        cap_daily = excluded.cap_daily,
        cap_monthly = excluded.cap_monthly,
        cap_total = excluded.cap_total,
        updated_at = unixepoch()
    `).run(req.params.campaign_id, publisher_id, req.user.id, +cap_daily, +cap_monthly, +cap_total);

    const row = db.prepare(`
      SELECT pc.*, p.name AS publisher_name, p.pub_token
      FROM publisher_caps pc
      JOIN publishers p ON p.id = pc.publisher_id
      WHERE pc.campaign_id = ? AND pc.publisher_id = ?
    `).get(req.params.campaign_id, publisher_id);

    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PUT /api/campaigns/:campaign_id/publisher-caps/:id
router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { cap_daily, cap_monthly, cap_total } = req.body;
    db.prepare(`
      UPDATE publisher_caps SET
        cap_daily   = COALESCE(?, cap_daily),
        cap_monthly = COALESCE(?, cap_monthly),
        cap_total   = COALESCE(?, cap_total),
        updated_at  = unixepoch()
      WHERE id = ? AND campaign_id = ?
    `).run(
      cap_daily   != null ? +cap_daily   : null,
      cap_monthly != null ? +cap_monthly : null,
      cap_total   != null ? +cap_total   : null,
      req.params.id, req.params.campaign_id
    );
    const row = db.prepare(`
      SELECT pc.*, p.name AS publisher_name, p.pub_token
      FROM publisher_caps pc JOIN publishers p ON p.id = pc.publisher_id
      WHERE pc.id = ?
    `).get(req.params.id);
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/campaigns/:campaign_id/publisher-caps/:id
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM publisher_caps WHERE id = ? AND campaign_id = ?')
    .run(req.params.id, req.params.campaign_id);
  res.json({ success: true });
});

module.exports = router;
