const db = require('../db/init');

/**
 * Middleware: authenticate requests via x-api-key header or ?api_key= query param.
 * Attaches req.apiKey (the key record) and req.publisherId to the request.
 */
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API key required. Pass via x-api-key header or ?api_key= query param.' });

  const row = db.prepare("SELECT * FROM publisher_api_keys WHERE api_key = ? AND status = 'active'").get(key);
  if (!row) return res.status(401).json({ error: 'Invalid or revoked API key.' });

  // Update last-used timestamp (non-blocking)
  try { db.prepare("UPDATE publisher_api_keys SET last_used_at = unixepoch() WHERE id = ?").run(row.id); } catch {}

  req.apiKey    = row;
  req.publisherId = row.publisher_id;
  next();
}

module.exports = { requireApiKey };
