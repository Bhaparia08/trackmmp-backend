/**
 * Audit Log — records every important action on the platform
 * Used for: dispute resolution, compliance, debugging, activity tracking
 */
const db = require('../db/init');

// Ensure table exists
try {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_email TEXT,
    user_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    entity_name TEXT,
    details TEXT DEFAULT '{}',
    ip TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  // Index for fast lookups
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at)`);
} catch {}

const insertStmt = db.prepare(`
  INSERT INTO audit_log (user_id, user_email, user_role, action, entity_type, entity_id, entity_name, details, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Log an action
 * @param {object} req - Express request (for user info + IP)
 * @param {string} action - e.g. 'create', 'update', 'delete', 'login', 'approve', 'reject'
 * @param {string} entityType - e.g. 'campaign', 'publisher', 'user', 'invoice'
 * @param {number|null} entityId - ID of the affected entity
 * @param {string|null} entityName - Name for readability
 * @param {object} details - Any extra context (changed fields, old values, etc.)
 */
function log(req, action, entityType, entityId, entityName, details = {}) {
  try {
    const user = req?.user || {};
    const ip = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim();
    insertStmt.run(
      user.id || null,
      user.email || null,
      user.role || null,
      action,
      entityType || null,
      entityId || null,
      entityName || null,
      JSON.stringify(details),
      ip
    );
  } catch (e) {
    console.error('[AuditLog] write error:', e.message);
  }
}

module.exports = { log };
