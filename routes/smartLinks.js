const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid12 } = require('../utils/clickId');

const router = express.Router();
router.use(requireAuth);

// GET /api/smart-links
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT sl.*,
      (SELECT COUNT(*) FROM smart_link_rules WHERE smart_link_id = sl.id) AS rule_count,
      (SELECT COUNT(*) FROM clicks WHERE smart_link_id = sl.id) AS total_clicks
    FROM smart_links sl
    WHERE sl.user_id = ?
    ORDER BY sl.created_at DESC
  `).all(req.user.id);

  // Attach rules to each smart link so the frontend expand works without extra calls
  const rulesStmt = db.prepare(`
    SELECT slr.*, c.name AS campaign_name, c.campaign_token, c.status AS campaign_status, c.payout
    FROM smart_link_rules slr
    JOIN campaigns c ON c.id = slr.campaign_id
    WHERE slr.smart_link_id = ?
    ORDER BY slr.priority ASC, slr.id ASC
  `);
  res.json(rows.map(sl => ({ ...sl, rules: rulesStmt.all(sl.id) })));
});

// POST /api/smart-links
router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, fallback_url = '', rules = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const token = nanoid12();
    const result = db.prepare(
      `INSERT INTO smart_links (user_id, name, token, fallback_url) VALUES (?, ?, ?, ?)`
    ).run(req.user.id, name, token, fallback_url);

    const slId = result.lastInsertRowid;
    insertRules(slId, rules);

    res.status(201).json(getSmartLink(slId));
  } catch (err) { next(err); }
});

// GET /api/smart-links/:id
router.get('/:id', (req, res) => {
  const sl = db.prepare('SELECT * FROM smart_links WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!sl) return res.status(404).json({ error: 'Smart link not found' });
  res.json(getSmartLink(sl.id));
});

// PUT /api/smart-links/:id
router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const sl = db.prepare('SELECT * FROM smart_links WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!sl) return res.status(404).json({ error: 'Smart link not found' });

    const { name, fallback_url, status, rules } = req.body;
    db.prepare(`
      UPDATE smart_links SET
        name = COALESCE(?, name), fallback_url = COALESCE(?, fallback_url),
        status = COALESCE(?, status), updated_at = unixepoch()
      WHERE id = ?
    `).run(name || null, fallback_url ?? null, status || null, sl.id);

    if (Array.isArray(rules)) {
      db.prepare('DELETE FROM smart_link_rules WHERE smart_link_id = ?').run(sl.id);
      insertRules(sl.id, rules);
    }

    res.json(getSmartLink(sl.id));
  } catch (err) { next(err); }
});

// DELETE /api/smart-links/:id
router.delete('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const sl = db.prepare('SELECT * FROM smart_links WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!sl) return res.status(404).json({ error: 'Smart link not found' });
    db.prepare("UPDATE smart_links SET status = 'archived', updated_at = unixepoch() WHERE id = ?").run(sl.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function insertRules(smartLinkId, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO smart_link_rules (smart_link_id, campaign_id, priority, weight, country_codes, device_types, os_names)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rules) {
    stmt.run(
      smartLinkId,
      r.campaign_id,
      r.priority ?? 0,
      r.weight ?? 100,
      r.country_codes || '',
      r.device_types || '',
      r.os_names || '',
    );
  }
}

function getSmartLink(id) {
  const sl = db.prepare('SELECT * FROM smart_links WHERE id = ?').get(id);
  if (!sl) return null;
  const rules = db.prepare(`
    SELECT slr.*, c.name AS campaign_name, c.campaign_token, c.status AS campaign_status, c.payout
    FROM smart_link_rules slr
    JOIN campaigns c ON c.id = slr.campaign_id
    WHERE slr.smart_link_id = ?
    ORDER BY slr.priority ASC, slr.id ASC
  `).all(id);
  return { ...sl, rules };
}

module.exports = router;
