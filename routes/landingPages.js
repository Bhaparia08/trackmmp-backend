/**
 * Landing Pages (A/B testing)  —  /api/campaigns/:campaign_id/landing-pages
 *
 * Multiple landing pages per campaign with weight-based rotation.
 * track.js picks a landing page on each click using weighted random selection.
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/campaigns/:campaign_id/landing-pages
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT *,
      CASE WHEN clicks > 0 THEN ROUND(CAST(conversions AS REAL) / clicks * 100, 2) ELSE 0 END AS cvr
    FROM landing_pages
    WHERE campaign_id = ?
    ORDER BY weight DESC, id ASC
  `).all(req.params.campaign_id);
  res.json(rows);
});

// POST /api/campaigns/:campaign_id/landing-pages
router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, url, weight = 100 } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!url)  return res.status(400).json({ error: 'url is required' });

    const result = db.prepare(`
      INSERT INTO landing_pages (campaign_id, user_id, name, url, weight)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.campaign_id, req.user.id, name, url, +weight || 100);

    res.status(201).json(db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// PUT /api/campaigns/:campaign_id/landing-pages/:id
router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const lp = db.prepare('SELECT id FROM landing_pages WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaign_id);
    if (!lp) return res.status(404).json({ error: 'Landing page not found' });

    const { name, url, weight, status } = req.body;
    db.prepare(`
      UPDATE landing_pages SET
        name   = COALESCE(?, name),
        url    = COALESCE(?, url),
        weight = COALESCE(?, weight),
        status = COALESCE(?, status),
        updated_at = unixepoch()
      WHERE id = ?
    `).run(name || null, url || null, weight != null ? +weight : null, status || null, lp.id);

    res.json(db.prepare(`
      SELECT *, CASE WHEN clicks > 0 THEN ROUND(CAST(conversions AS REAL)/clicks*100,2) ELSE 0 END AS cvr
      FROM landing_pages WHERE id = ?
    `).get(lp.id));
  } catch (err) { next(err); }
});

// DELETE /api/campaigns/:campaign_id/landing-pages/:id
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM landing_pages WHERE id = ? AND campaign_id = ?').run(req.params.id, req.params.campaign_id);
  res.json({ success: true });
});

// POST /api/campaigns/:campaign_id/landing-pages/reset-stats
router.post('/reset-stats', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('UPDATE landing_pages SET clicks = 0, conversions = 0 WHERE campaign_id = ?').run(req.params.campaign_id);
  res.json({ success: true });
});

module.exports = router;
