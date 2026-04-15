const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/automation
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM automation_rule_logs WHERE rule_id = r.id) AS trigger_count,
      (SELECT triggered_at FROM automation_rule_logs WHERE rule_id = r.id ORDER BY triggered_at DESC LIMIT 1) AS last_log_at
    FROM automation_rules r
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(req.user.id);
  res.json(rows.map(r => ({
    ...r,
    trigger_config: tryParse(r.trigger_config),
    action_config:  tryParse(r.action_config),
  })));
});

// POST /api/automation
router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, trigger_type, trigger_config = {}, action_type, action_config = {} } = req.body;
    if (!name || !trigger_type || !action_type) return res.status(400).json({ error: 'name, trigger_type, and action_type are required' });

    const result = db.prepare(`
      INSERT INTO automation_rules (user_id, name, trigger_type, trigger_config, action_type, action_config)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, name, trigger_type, JSON.stringify(trigger_config), action_type, JSON.stringify(action_config));

    res.status(201).json(getRule(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// GET /api/automation/:id
router.get('/:id', (req, res) => {
  const rule = getRule(req.params.id);
  if (!rule || rule.user_id !== req.user.id) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
});

// PUT /api/automation/:id
router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = db.prepare('SELECT * FROM automation_rules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!r) return res.status(404).json({ error: 'Rule not found' });

    const { name, status, trigger_type, trigger_config, action_type, action_config } = req.body;
    db.prepare(`UPDATE automation_rules SET
      name = COALESCE(?, name), status = COALESCE(?, status),
      trigger_type = COALESCE(?, trigger_type), trigger_config = COALESCE(?, trigger_config),
      action_type = COALESCE(?, action_type), action_config = COALESCE(?, action_config),
      updated_at = unixepoch()
      WHERE id = ?
    `).run(
      name || null, status || null,
      trigger_type || null,
      trigger_config ? JSON.stringify(trigger_config) : null,
      action_type || null,
      action_config ? JSON.stringify(action_config) : null,
      r.id,
    );

    res.json(getRule(r.id));
  } catch (err) { next(err); }
});

// DELETE /api/automation/:id
router.delete('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = db.prepare('SELECT * FROM automation_rules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!r) return res.status(404).json({ error: 'Rule not found' });
    db.prepare('DELETE FROM automation_rules WHERE id = ?').run(r.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/automation/:id/logs
router.get('/:id/logs', (req, res) => {
  const r = db.prepare('SELECT id FROM automation_rules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'Rule not found' });
  const logs = db.prepare(
    'SELECT * FROM automation_rule_logs WHERE rule_id = ? ORDER BY triggered_at DESC LIMIT 100'
  ).all(r.id).map(l => ({ ...l, trigger_data: tryParse(l.trigger_data) }));
  res.json(logs);
});

function getRule(id) {
  const r = db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, trigger_config: tryParse(r.trigger_config), action_config: tryParse(r.action_config) };
}

function tryParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

module.exports = router;
