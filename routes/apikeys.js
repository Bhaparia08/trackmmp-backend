/**
 * /api/apikeys  — manage publisher API keys and advertiser external credentials
 * Admin: full CRUD on all keys + advertiser credentials
 * Publisher: view/manage own API keys only
 */
const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { customAlphabet } = require('nanoid');

const nanoid32 = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 32);

const router = express.Router();
router.use(requireAuth);

// ─── Publisher API Keys ───────────────────────────────────────────────────────

// GET /api/apikeys — list publisher API keys
router.get('/', (req, res) => {
  if (req.user.role === 'admin') {
    const rows = db.prepare(`
      SELECT k.*, p.name AS publisher_name, p.email AS publisher_email
      FROM publisher_api_keys k
      LEFT JOIN publishers p ON p.id = k.publisher_id
      WHERE k.user_id = ?
      ORDER BY k.created_at DESC
    `).all(req.user.id);
    return res.json(rows);
  }
  if (req.user.role === 'publisher') {
    const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
    if (!pub) return res.json([]);
    const rows = db.prepare(`
      SELECT k.*, p.name AS publisher_name
      FROM publisher_api_keys k
      LEFT JOIN publishers p ON p.id = k.publisher_id
      WHERE k.publisher_id = ?
      ORDER BY k.created_at DESC
    `).all(pub.id);
    return res.json(rows);
  }
  res.status(403).json({ error: 'Not allowed' });
});

// POST /api/apikeys — create a new API key
// Admin: can create for any publisher they own
// Publisher: creates for their own account (publisher_id resolved automatically)
router.post('/', (req, res, next) => {
  try {
    let publisher_id = req.body.publisher_id;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    if (req.user.role === 'publisher') {
      // Publisher generates their own key — resolve their publisher record
      const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
      if (!pub) return res.status(404).json({ error: 'Publisher profile not found. Ask your account manager to link your account.' });
      publisher_id = pub.id;
    } else if (req.user.role === 'admin') {
      if (!publisher_id) return res.status(400).json({ error: 'publisher_id is required' });
      const pub = db.prepare('SELECT * FROM publishers WHERE id = ? AND user_id = ?').get(publisher_id, req.user.id);
      if (!pub) return res.status(404).json({ error: 'Publisher not found' });
    } else {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const api_key = nanoid32();
    const result = db.prepare(`
      INSERT INTO publisher_api_keys (publisher_id, user_id, name, api_key, status, created_by)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(publisher_id, req.user.id, name, api_key, req.user.id);

    res.status(201).json(db.prepare('SELECT * FROM publisher_api_keys WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// PATCH /api/apikeys/:id — update label or status
router.patch('/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM publisher_api_keys WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });

    const { name, status } = req.body;
    db.prepare('UPDATE publisher_api_keys SET name=COALESCE(?,name), status=COALESCE(?,status) WHERE id=?')
      .run(name || null, status || null, row.id);

    res.json(db.prepare('SELECT * FROM publisher_api_keys WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

// DELETE /api/apikeys/:id — revoke/delete key
router.delete('/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM publisher_api_keys WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
    db.prepare("UPDATE publisher_api_keys SET status = 'revoked' WHERE id = ?").run(row.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── Advertiser External API Credentials ─────────────────────────────────────

// GET /api/apikeys/adv-credentials — list stored advertiser credentials
router.get('/adv-credentials', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT c.*, u.name AS advertiser_name, u.email AS advertiser_email
    FROM advertiser_api_credentials c
    LEFT JOIN users u ON u.id = c.advertiser_id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// POST /api/apikeys/adv-credentials — store new advertiser credential
router.post('/adv-credentials', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { advertiser_id, platform, label, api_key, api_secret, network_id, extra } = req.body;
    if (!platform || !api_key) return res.status(400).json({ error: 'platform and api_key are required' });

    const result = db.prepare(`
      INSERT INTO advertiser_api_credentials (user_id, advertiser_id, platform, label, api_key, api_secret, network_id, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, advertiser_id || null, platform, label || null, api_key, api_secret || null, network_id || null, extra ? JSON.stringify(extra) : null);

    res.status(201).json(db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// DELETE /api/apikeys/adv-credentials/:id
router.delete('/adv-credentials/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const row = db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM advertiser_api_credentials WHERE id = ?').run(row.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
