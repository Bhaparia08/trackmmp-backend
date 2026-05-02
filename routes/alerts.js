const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (!['admin', 'account_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

// ── Alert Rules CRUD ──────────────────────────────────────────────────────

// GET /api/alerts/rules
router.get('/rules', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = isAdmin
    ? db.prepare(`
        SELECT r.*, u.name AS user_name,
          c.name AS campaign_name, p.name AS publisher_name
        FROM alert_rules r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN campaigns c ON c.id = r.campaign_id
        LEFT JOIN publishers p ON p.id = r.publisher_id
        ORDER BY r.created_at DESC
      `).all()
    : db.prepare(`
        SELECT r.*, c.name AS campaign_name, p.name AS publisher_name
        FROM alert_rules r
        LEFT JOIN campaigns c ON c.id = r.campaign_id
        LEFT JOIN publishers p ON p.id = r.publisher_id
        WHERE r.user_id = ? ORDER BY r.created_at DESC
      `).all(req.user.id);
  res.json(rows);
});

// POST /api/alerts/rules
router.post('/rules', (req, res) => {
  const { name, alert_type, campaign_id, publisher_id, threshold, window_minutes, channel, webhook_url } = req.body;
  if (!name || !alert_type || threshold == null) return res.status(400).json({ error: 'name, alert_type, threshold required' });

  const VALID_TYPES = ['cap_hit', 'revenue_spike', 'fraud_spike', 'click_spike', 'install_drop'];
  if (!VALID_TYPES.includes(alert_type)) return res.status(400).json({ error: 'invalid alert_type' });

  const result = db.prepare(`
    INSERT INTO alert_rules (user_id, name, alert_type, campaign_id, publisher_id, threshold, window_minutes, channel, webhook_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, name, alert_type, campaign_id || null, publisher_id || null,
         +threshold, +(window_minutes || 60), channel || 'in_app', webhook_url || '');

  res.status(201).json({ id: result.lastInsertRowid, ok: true });
});

// PUT /api/alerts/rules/:id
router.put('/rules/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  if (rule.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const { name, threshold, window_minutes, channel, webhook_url, status } = req.body;
  db.prepare(`
    UPDATE alert_rules SET name=COALESCE(?,name), threshold=COALESCE(?,threshold),
    window_minutes=COALESCE(?,window_minutes), channel=COALESCE(?,channel),
    webhook_url=COALESCE(?,webhook_url), status=COALESCE(?,status), updated_at=unixepoch()
    WHERE id=?
  `).run(name||null, threshold!=null?+threshold:null, window_minutes?+window_minutes:null,
         channel||null, webhook_url||null, status||null, rule.id);
  res.json({ ok: true });
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  if (rule.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(rule.id);
  res.json({ ok: true });
});

// ── Notifications ─────────────────────────────────────────────────────────

// GET /api/alerts/notifications
router.get('/notifications', (req, res) => {
  const { unread_only, limit = 50, offset = 0 } = req.query;
  const unreadClause = unread_only === '1' ? ' AND read = 0' : '';
  const rows = db.prepare(`
    SELECT * FROM alert_notifications
    WHERE user_id = ?${unreadClause}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(req.user.id, +limit, +offset);

  const unreadCount = db.prepare(
    'SELECT COUNT(*) AS n FROM alert_notifications WHERE user_id = ? AND read = 0'
  ).get(req.user.id).n;

  res.json({ notifications: rows, unread_count: unreadCount });
});

// POST /api/alerts/notifications/mark-read
router.post('/notifications/mark-read', (req, res) => {
  const { ids } = req.body; // array of IDs or empty = mark all
  if (Array.isArray(ids) && ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE alert_notifications SET read = 1 WHERE user_id = ? AND id IN (${ph})`)
      .run(req.user.id, ...ids);
  } else {
    db.prepare('UPDATE alert_notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  }
  res.json({ ok: true });
});

// DELETE /api/alerts/notifications/clear
router.delete('/notifications/clear', (req, res) => {
  db.prepare("DELETE FROM alert_notifications WHERE user_id = ? AND read = 1").run(req.user.id);
  res.json({ ok: true });
});

// ── Webhook Queue Stats (admin only) ─────────────────────────────────────
router.get('/webhook-queue', requireRole('admin'), (req, res) => {
  const { getQueueStats } = require('../utils/webhookRetry');
  const stats = getQueueStats();
  const recent = db.prepare(`
    SELECT * FROM webhook_retry_queue ORDER BY created_at DESC LIMIT 50
  `).all();
  res.json({ stats, recent });
});

module.exports = router;
