/**
 * /api/apikeys  — manage publisher API keys and advertiser external credentials
 * Admin: full CRUD on all keys + advertiser credentials
 * Account Manager: CRUD on adv-credentials scoped to their assigned advertisers
 * Publisher: view/manage own API keys only
 */
const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { customAlphabet } = require('nanoid');

const nanoid32 = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 32);

const router = express.Router();
router.use(requireAuth);

// Helper: get advertiser IDs assigned to an account manager
function getAMAdvertiserIds(userId) {
  const am = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(userId);
  if (!am) return [];
  return db.prepare(`
    SELECT DISTINCT u.id FROM users u
    WHERE u.role = 'advertiser' AND (
      u.account_manager_id = ?
      OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = u.id AND uam.account_manager_id = ?)
    )
  `).all(am.id, am.id).map(u => u.id);
}

// ─── Publisher API Keys ───────────────────────────────────────────────────────

// GET /api/apikeys — list publisher API keys
router.get('/', (req, res) => {
  if (req.user.role === 'admin') {
    // Admins see ALL keys across all admin accounts
    const rows = db.prepare(`
      SELECT k.*, p.name AS publisher_name, p.email AS publisher_email,
             u.name AS created_by_name, u.email AS created_by_email
      FROM publisher_api_keys k
      LEFT JOIN publishers p ON p.id = k.publisher_id
      LEFT JOIN users u ON u.id = k.created_by
      ORDER BY k.created_at DESC
    `).all();
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
  if (req.user.role === 'admin') {
    const rows = db.prepare(`
      SELECT c.*, u.name AS advertiser_name, u.email AS advertiser_email,
             cu.name AS created_by_name, cu.email AS created_by_email
      FROM advertiser_api_credentials c
      LEFT JOIN users u ON u.id = c.advertiser_id
      LEFT JOIN users cu ON cu.id = c.user_id
      ORDER BY c.created_at DESC
    `).all();
    return res.json(rows);
  }
  if (req.user.role === 'account_manager') {
    const advIds = getAMAdvertiserIds(req.user.id);
    if (advIds.length === 0) return res.json([]);
    const ph = advIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT c.*, u.name AS advertiser_name, u.email AS advertiser_email,
             cu.name AS created_by_name, cu.email AS created_by_email
      FROM advertiser_api_credentials c
      LEFT JOIN users u ON u.id = c.advertiser_id
      LEFT JOIN users cu ON cu.id = c.user_id
      WHERE c.advertiser_id IN (${ph})
      ORDER BY c.created_at DESC
    `).all(...advIds);
    return res.json(rows);
  }
  res.status(403).json({ error: 'Not allowed' });
});

// POST /api/apikeys/adv-credentials — store new advertiser credential
router.post('/adv-credentials', (req, res, next) => {
  try {
    if (!['admin','account_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    // Account managers can only save credentials for their assigned advertisers
    if (req.user.role === 'account_manager' && req.body.advertiser_id) {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (!advIds.includes(Number(req.body.advertiser_id))) return res.status(403).json({ error: 'Advertiser not assigned to you' });
    }
    const { advertiser_id, platform, label, api_key, api_secret, network_id, extra } = req.body;
    if (!platform || !api_key) return res.status(400).json({ error: 'platform and api_key are required' });

    const result = db.prepare(`
      INSERT INTO advertiser_api_credentials (user_id, advertiser_id, platform, label, api_key, api_secret, network_id, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, advertiser_id || null, platform, label || null, api_key, api_secret || null, network_id || null, extra ? JSON.stringify(extra) : null);

    res.status(201).json(db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// PUT /api/apikeys/adv-credentials/:id — update a saved credential
router.put('/adv-credentials/:id', (req, res, next) => {
  try {
    if (!['admin','account_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    const row = db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'account_manager') {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (row.advertiser_id && !advIds.includes(row.advertiser_id)) return res.status(403).json({ error: 'Advertiser not assigned to you' });
    }
    const { label, api_key, api_secret, network_id, extra } = req.body;
    if (!api_key) return res.status(400).json({ error: 'api_key is required' });
    db.prepare(`
      UPDATE advertiser_api_credentials
      SET label = ?, api_key = ?, api_secret = ?, network_id = ?, extra = ?
      WHERE id = ?
    `).run(label || row.label, api_key, api_secret || null, network_id || null, extra ? JSON.stringify(extra) : null, row.id);
    res.json(db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

// DELETE /api/apikeys/adv-credentials/:id
router.delete('/adv-credentials/:id', (req, res, next) => {
  try {
    if (!['admin','account_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    const row = db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.user.role === 'account_manager') {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (row.advertiser_id && !advIds.includes(row.advertiser_id)) return res.status(403).json({ error: 'Advertiser not assigned to you' });
    }
    // NULL out FK references first, then delete — both in one transaction
    // defer_foreign_keys must be set BEFORE the transaction starts in better-sqlite3
    db.pragma('defer_foreign_keys = ON');
    const deleteWithCascade = db.transaction((credId) => {
      db.prepare('UPDATE campaigns SET source_credential_id = NULL WHERE source_credential_id = ?').run(credId);
      db.prepare('DELETE FROM advertiser_api_credentials WHERE id = ?').run(credId);
    });
    deleteWithCascade(row.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
