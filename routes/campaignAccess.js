/**
 * Campaign Access Requests
 *
 * POST   /api/campaign-access/request/:campaign_id  — publisher requests access
 * GET    /api/campaign-access/requests              — admin views all pending requests
 * PUT    /api/campaign-access/:id/approve           — admin approves
 * PUT    /api/campaign-access/:id/reject            — admin rejects
 * GET    /api/campaign-access/my                    — publisher views own requests
 * GET    /api/campaign-access/check/:campaign_id    — check if publisher has access
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Publisher: request access to a campaign
router.post('/request/:campaign_id', (req, res, next) => {
  try {
    const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
    if (!pub) return res.status(403).json({ error: 'Publisher profile not found' });

    const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'active'").get(req.params.campaign_id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.visibility === 'open') return res.status(400).json({ error: 'Campaign is open to all — no request needed' });
    if (campaign.visibility === 'private') return res.status(403).json({ error: 'Campaign is private' });

    const existing = db.prepare('SELECT * FROM campaign_access_requests WHERE campaign_id = ? AND publisher_id = ?')
      .get(campaign.id, pub.id);
    if (existing) return res.json({ ...existing, already: true });

    const result = db.prepare(
      `INSERT INTO campaign_access_requests (campaign_id, publisher_id, user_id, status, note)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(campaign.id, pub.id, campaign.user_id, req.body.note || null);

    res.status(201).json(db.prepare('SELECT * FROM campaign_access_requests WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// Publisher: view own access requests
router.get('/my', (req, res, next) => {
  try {
    const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
    if (!pub) return res.json([]);
    const rows = db.prepare(`
      SELECT r.*, c.name AS campaign_name, c.visibility
      FROM campaign_access_requests r
      JOIN campaigns c ON c.id = r.campaign_id
      WHERE r.publisher_id = ?
      ORDER BY r.created_at DESC
    `).all(pub.id);
    res.json(rows);
  } catch (err) { next(err); }
});

// Publisher: check access status for a specific campaign
router.get('/check/:campaign_id', (req, res, next) => {
  try {
    const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
    const campaign = db.prepare('SELECT id, visibility FROM campaigns WHERE id = ?').get(req.params.campaign_id);
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    if (campaign.visibility === 'open') return res.json({ access: true, status: 'open' });
    if (campaign.visibility === 'private') return res.json({ access: false, status: 'private' });
    if (!pub) return res.json({ access: false, status: 'no_profile' });
    const req_ = db.prepare('SELECT * FROM campaign_access_requests WHERE campaign_id = ? AND publisher_id = ?')
      .get(campaign.id, pub.id);
    if (!req_) return res.json({ access: false, status: 'not_requested' });
    return res.json({ access: req_.status === 'approved', status: req_.status, request: req_ });
  } catch (err) { next(err); }
});

// Admin: list all access requests
router.get('/requests', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT r.*, c.name AS campaign_name, p.name AS publisher_name, p.pub_token
      FROM campaign_access_requests r
      JOIN campaigns c ON c.id = r.campaign_id
      JOIN publishers p ON p.id = r.publisher_id
      WHERE c.user_id = ?
    `;
    const params = [req.user.id];
    if (status) { sql += ' AND r.status = ?'; params.push(status); }
    sql += ' ORDER BY r.created_at DESC LIMIT 200';
    res.json(db.prepare(sql).all(...params));
  } catch (err) { next(err); }
});

// Admin: approve a request
router.put('/:id/approve', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const row = db.prepare('SELECT r.*, c.user_id FROM campaign_access_requests r JOIN campaigns c ON c.id = r.campaign_id WHERE r.id = ?').get(req.params.id);
    if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    db.prepare("UPDATE campaign_access_requests SET status='approved', reviewed_by=?, reviewed_at=unixepoch() WHERE id=?")
      .run(req.user.id, row.id);
    res.json(db.prepare('SELECT * FROM campaign_access_requests WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

// Admin: reject a request
router.put('/:id/reject', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const row = db.prepare('SELECT r.*, c.user_id FROM campaign_access_requests r JOIN campaigns c ON c.id = r.campaign_id WHERE r.id = ?').get(req.params.id);
    if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    db.prepare("UPDATE campaign_access_requests SET status='rejected', reviewed_by=?, reviewed_at=unixepoch() WHERE id=?")
      .run(req.user.id, row.id);
    res.json(db.prepare('SELECT * FROM campaign_access_requests WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

module.exports = router;
