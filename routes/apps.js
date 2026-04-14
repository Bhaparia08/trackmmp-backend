const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid32 } = require('../utils/clickId');

const router = express.Router();
router.use(requireAuth);

const TOKEN_FIELDS = ['dev_key', 's2s_token', 'push_api_token', 'pull_api_token'];

// GET /api/apps
router.get('/', (req, res) => {
  const apps = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM campaigns WHERE app_id = a.id AND status != 'archived') AS campaign_count
    FROM apps a WHERE a.user_id = ? ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json(apps);
});

// POST /api/apps
router.post('/', (req, res, next) => {
  try {
    const { name, bundle_id, platform = 'android' } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = db.prepare(`
      INSERT INTO apps (user_id, name, bundle_id, platform, dev_key, s2s_token, push_api_token, pull_api_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, name, bundle_id || null, platform, nanoid32(), nanoid32(), nanoid32(), nanoid32());

    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(app);
  } catch (err) { next(err); }
});

// GET /api/apps/:id
router.get('/:id', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!app) return res.status(404).json({ error: 'App not found' });
  res.json(app);
});

// PUT /api/apps/:id
router.put('/:id', (req, res, next) => {
  try {
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const { name, bundle_id, platform, status,
            adjust_app_token, adjust_s2s_token, adjust_api_token,
            branch_key, branch_secret } = req.body;

    db.prepare(`UPDATE apps SET
      name=COALESCE(?,name), bundle_id=COALESCE(?,bundle_id),
      platform=COALESCE(?,platform), status=COALESCE(?,status),
      adjust_app_token=COALESCE(?,adjust_app_token),
      adjust_s2s_token=COALESCE(?,adjust_s2s_token),
      adjust_api_token=COALESCE(?,adjust_api_token),
      branch_key=COALESCE(?,branch_key),
      branch_secret=COALESCE(?,branch_secret)
      WHERE id=?`)
      .run(name||null, bundle_id||null, platform||null, status||null,
           adjust_app_token||null, adjust_s2s_token||null, adjust_api_token||null,
           branch_key||null, branch_secret||null, app.id);

    res.json(db.prepare('SELECT * FROM apps WHERE id = ?').get(app.id));
  } catch (err) { next(err); }
});

// POST /api/apps/:id/rotate-token  body: { tokenType }
router.post('/:id/rotate-token', (req, res, next) => {
  try {
    const { tokenType } = req.body;
    if (!TOKEN_FIELDS.includes(tokenType)) return res.status(400).json({ error: 'Invalid tokenType' });

    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const newToken = nanoid32();
    db.prepare(`UPDATE apps SET ${tokenType} = ? WHERE id = ?`).run(newToken, app.id);
    res.json({ tokenType, token: newToken });
  } catch (err) { next(err); }
});

// DELETE /api/apps/:id
router.delete('/:id', (req, res, next) => {
  try {
    const app = db.prepare('SELECT * FROM apps WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });
    db.prepare("UPDATE apps SET status = 'paused' WHERE id = ?").run(app.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
