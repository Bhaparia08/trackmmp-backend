const db = require('../db/init');
const { hashApiKey } = require('../utils/apiKeySecurity');

/**
 * Middleware: authenticate requests via x-api-key header or ?api_key= query param.
 * Attaches req.apiKey (the key record) and req.publisherId to the request.
 */
function requireApiKey(req, res, next) {
  const key = String(req.headers['x-api-key'] || req.query.api_key || '').trim();
  if (!key) return res.status(401).json({ error: 'API key required. Pass via x-api-key header or ?api_key= query param.' });

  const keyHash = hashApiKey(key);
  let row = db.prepare(`
    SELECT k.*, p.status AS publisher_status, p.publisher_user_id, u.status AS publisher_user_status
    FROM publisher_api_keys k
    JOIN publishers p ON p.id = k.publisher_id
    LEFT JOIN users u ON u.id = p.publisher_user_id
    WHERE k.api_key_hash = ? AND k.status = 'active'
  `).get(keyHash);

  if (!row) return res.status(401).json({ error: 'Invalid or revoked API key.' });
  if (row.publisher_status !== 'active') return res.status(403).json({ error: 'Publisher account is not active.' });
  if (row.publisher_user_id && row.publisher_user_status !== 'active') return res.status(403).json({ error: 'Publisher user is not active.' });

  // Update last-used timestamp (non-blocking)
  try { db.prepare("UPDATE publisher_api_keys SET last_used_at = unixepoch() WHERE id = ?").run(row.id); } catch {}

  req.apiKey    = row;
  req.publisherId = row.publisher_id;
  next();
}

module.exports = { requireApiKey };
