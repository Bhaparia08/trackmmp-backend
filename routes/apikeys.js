/**
 * /api/apikeys  — manage publisher API keys and advertiser external credentials
 * Admin: full CRUD on all keys + advertiser credentials
 * Account Manager: CRUD on adv-credentials scoped to their assigned advertisers
 * Publisher: view/manage own API keys only
 */
const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  getKeyLast4,
  getKeyPreview,
  redactedApiKeyValue,
  temporaryRedactedApiKeyValue,
} = require('../utils/apiKeySecurity');

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

function serializePublisherApiKey(row, secret) {
  if (!row) return row;
  const out = { ...row };
  delete out.api_key_hash;
  delete out.api_key;
  out.api_key_preview = getKeyPreview(row);
  // Backward compatibility for existing UI screens that render k.api_key.
  // This is a masked preview unless this response is the one-time create response.
  out.api_key = out.api_key_preview;
  out.api_key_masked = true;
  out.can_reveal = false;
  if (secret) {
    out.api_key = secret;
    out.api_key_preview = getKeyPreview(secret);
    out.api_key_masked = false;
    out.can_reveal = true;
    out.reveal_once = true;
  }
  return out;
}

function canManagePublisherKey(user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'publisher') {
    return row.publisher_user_id === user.id || row.user_id === user.id;
  }
  if (user.role === 'account_manager') {
    const am = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(user.id);
    if (!am) return false;
    const assigned = db.prepare(`
      SELECT 1
      FROM publishers p
      WHERE p.id = ? AND (
        p.publisher_user_id IN (
          SELECT uam.user_id FROM user_account_managers uam WHERE uam.account_manager_id = ?
        )
        OR p.user_id IN (
          SELECT u.created_by FROM users u
          JOIN user_account_managers uam ON uam.user_id = u.id
          WHERE uam.account_manager_id = ? AND u.role = 'admin'
        )
      )
    `).get(row.publisher_id, am.id, am.id);
    return !!assigned;
  }
  return false;
}

function getPublisherApiKeyById(id) {
  return db.prepare(`
    SELECT k.*, p.publisher_user_id, p.name AS publisher_name, p.email AS publisher_email,
           u.name AS created_by_name, u.email AS created_by_email
    FROM publisher_api_keys k
    LEFT JOIN publishers p ON p.id = k.publisher_id
    LEFT JOIN users u ON u.id = k.created_by
    WHERE k.id = ?
  `).get(id);
}

// ─── Publisher API Keys ───────────────────────────────────────────────────────

// GET /api/apikeys — list publisher API keys
router.get('/', (req, res) => {
  if (req.user.role === 'admin' || req.user.role === 'account_manager') {
    // Admins see ALL keys; AMs see keys for their assigned publishers
    let rows;
    if (req.user.role === 'admin') {
      rows = db.prepare(`
        SELECT k.*, p.name AS publisher_name, p.email AS publisher_email,
               u.name AS created_by_name, u.email AS created_by_email
        FROM publisher_api_keys k
        LEFT JOIN publishers p ON p.id = k.publisher_id
        LEFT JOIN users u ON u.id = k.created_by
        ORDER BY k.created_at DESC
      `).all();
    } else {
      // AM — only keys for their assigned publishers
      const am = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(req.user.id);
      if (!am) return res.json([]);
      rows = db.prepare(`
        SELECT k.*, p.name AS publisher_name, p.email AS publisher_email,
               u.name AS created_by_name, u.email AS created_by_email
        FROM publisher_api_keys k
        LEFT JOIN publishers p ON p.id = k.publisher_id
        LEFT JOIN users u ON u.id = k.created_by
        WHERE p.publisher_user_id IN (
          SELECT uam.user_id FROM user_account_managers uam WHERE uam.account_manager_id = ?
        )
        ORDER BY k.created_at DESC
      `).all(am.id);
    }
    return res.json(rows.map(r => serializePublisherApiKey(r)));
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
    return res.json(rows.map(r => serializePublisherApiKey(r)));
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
    } else if (req.user.role === 'account_manager') {
      if (!publisher_id) return res.status(400).json({ error: 'publisher_id is required' });
      // AM can only create keys for their assigned publishers
      // Match the same scoping as /api/am/publishers uses
      const am = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(req.user.id);
      if (!am) return res.status(403).json({ error: 'Account manager profile not found' });
      const pub = db.prepare(`SELECT p.* FROM publishers p
        WHERE p.id = ? AND (
          p.publisher_user_id IN (
            SELECT uam.user_id FROM user_account_managers uam WHERE uam.account_manager_id = ?
          )
          OR p.user_id IN (
            SELECT u.created_by FROM users u
            JOIN user_account_managers uam ON uam.user_id = u.id
            WHERE uam.account_manager_id = ? AND u.role = 'admin'
          )
        )`).get(publisher_id, am.id, am.id);
      if (!pub) return res.status(404).json({ error: 'Publisher not found or not assigned to you' });
    } else {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const api_key = generateApiKey();
    const last4 = getKeyLast4(api_key);
    const result = db.prepare(`
      INSERT INTO publisher_api_keys (
        publisher_id, user_id, name, api_key, api_key_hash, api_key_prefix, api_key_last4,
        status, created_by, last_rotated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, unixepoch())
    `).run(
      publisher_id,
      req.user.id,
      name,
      temporaryRedactedApiKeyValue(last4),
      hashApiKey(api_key),
      getKeyPrefix(api_key),
      last4,
      req.user.id
    );

    db.prepare('UPDATE publisher_api_keys SET api_key = ? WHERE id = ?')
      .run(redactedApiKeyValue(result.lastInsertRowid, last4), result.lastInsertRowid);

    res.status(201).json(serializePublisherApiKey(getPublisherApiKeyById(result.lastInsertRowid), api_key));
  } catch (err) { next(err); }
});

// PATCH /api/apikeys/:id — update label or status
router.patch('/:id', (req, res, next) => {
  try {
    const row = getPublisherApiKeyById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canManagePublisherKey(req.user, row)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const { name, status } = req.body;
    if (status && !['active', 'revoked'].includes(status)) {
      return res.status(400).json({ error: 'status must be active or revoked' });
    }
    if (status === 'active' && row.status === 'revoked') {
      return res.status(400).json({ error: 'Revoked API keys cannot be reactivated. Generate a new key instead.' });
    }
    db.prepare(`
      UPDATE publisher_api_keys
      SET name = COALESCE(?, name),
          status = COALESCE(?, status),
          api_key_hash = CASE WHEN ? = 'revoked' THEN NULL ELSE api_key_hash END,
          revoked_at = CASE WHEN ? = 'revoked' THEN COALESCE(revoked_at, unixepoch()) ELSE revoked_at END
      WHERE id = ?
    `).run(name || null, status || null, status || null, status || null, row.id);

    res.json(serializePublisherApiKey(getPublisherApiKeyById(row.id)));
  } catch (err) { next(err); }
});

// DELETE /api/apikeys/:id — revoke/delete key
router.delete('/:id', (req, res, next) => {
  try {
    const row = getPublisherApiKeyById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canManagePublisherKey(req.user, row)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    db.prepare("UPDATE publisher_api_keys SET status = 'revoked', api_key_hash = NULL, revoked_at = COALESCE(revoked_at, unixepoch()) WHERE id = ?").run(row.id);
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
    // Partial updates — only touch fields present in the body.  Allows
    // e.g. {"auto_sync": 0} to disable a broken credential without having
    // to re-paste the api_key, and prevents accidental wipes when only
    // one field is being changed.
    const b = req.body || {};
    const sets = [];
    const vals = [];
    if (b.label       !== undefined) { sets.push('label = ?');       vals.push(b.label); }
    if (b.api_key     !== undefined) {
      if (!b.api_key) return res.status(400).json({ error: 'api_key cannot be empty' });
      sets.push('api_key = ?'); vals.push(b.api_key);
    }
    if (b.api_secret  !== undefined) { sets.push('api_secret = ?');  vals.push(b.api_secret || null); }
    if (b.network_id  !== undefined) { sets.push('network_id = ?');  vals.push(b.network_id || null); }
    if (b.extra       !== undefined) { sets.push('extra = ?');       vals.push(b.extra ? JSON.stringify(b.extra) : null); }
    if (b.auto_sync   !== undefined) { sets.push('auto_sync = ?');   vals.push(b.auto_sync ? 1 : 0); }
    if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' });

    db.prepare(`UPDATE advertiser_api_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
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
