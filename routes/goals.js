const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/campaigns/:campaign_id/goals
router.get('/', (req, res) => {
  const campaign = db.prepare('SELECT id, user_id FROM campaigns WHERE id = ?').get(req.params.campaign_id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const goals = db.prepare('SELECT * FROM campaign_goals WHERE campaign_id = ? ORDER BY is_default DESC, created_at ASC').all(req.params.campaign_id);
  res.json(goals);
});

// POST /api/campaigns/:campaign_id/goals
router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { name, event_name = 'install', payout = 0, revenue = 0, payout_type = 'fixed', postback_url = '', is_default = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = db.prepare(
      'INSERT INTO campaign_goals (campaign_id, user_id, name, event_name, payout, revenue, payout_type, postback_url, is_default) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(req.params.campaign_id, req.user.id, name, event_name, +payout, +revenue, payout_type, postback_url, is_default ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM campaign_goals WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// PUT /api/campaigns/:campaign_id/goals/:id
router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const g = db.prepare('SELECT id FROM campaign_goals WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaign_id);
    if (!g) return res.status(404).json({ error: 'Goal not found' });
    const { name, event_name, payout, revenue, payout_type, postback_url, is_default, status } = req.body;
    db.prepare(`UPDATE campaign_goals SET name=COALESCE(?,name), event_name=COALESCE(?,event_name),
      payout=COALESCE(?,payout), revenue=COALESCE(?,revenue), payout_type=COALESCE(?,payout_type),
      postback_url=COALESCE(?,postback_url), is_default=COALESCE(?,is_default), status=COALESCE(?,status)
      WHERE id=?`)
      .run(name||null, event_name||null, payout!=null?+payout:null, revenue!=null?+revenue:null,
           payout_type||null, postback_url!=null?postback_url:null, is_default!=null?+is_default:null,
           status||null, g.id);
    res.json(db.prepare('SELECT * FROM campaign_goals WHERE id = ?').get(g.id));
  } catch (err) { next(err); }
});

// DELETE /api/campaigns/:campaign_id/goals/:id
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM campaign_goals WHERE id = ? AND campaign_id = ?').run(req.params.id, req.params.campaign_id);
  res.json({ success: true });
});

module.exports = router;
