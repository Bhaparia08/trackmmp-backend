const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

// GET /api/audit-log — paginated audit log with filters
router.get('/', (req, res) => {
  const { user_id, action, entity_type, from, to, page = 1, limit = 50, search } = req.query;
  const conditions = [];
  const params = [];

  if (user_id) { conditions.push('a.user_id = ?'); params.push(user_id); }
  if (action) { conditions.push('a.action = ?'); params.push(action); }
  if (entity_type) { conditions.push('a.entity_type = ?'); params.push(entity_type); }
  if (from) { conditions.push("a.created_at >= strftime('%s', ?)"); params.push(from); }
  if (to) { conditions.push("a.created_at <= strftime('%s', ?, '+1 day')"); params.push(to); }
  if (search) {
    conditions.push("(a.entity_name LIKE ? OR a.user_email LIKE ? OR a.action LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log a ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT a.* FROM audit_log a
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, +limit, offset);

  res.json({ rows, total, page: +page, limit: +limit, pages: Math.ceil(total / limit) });
});

// GET /api/audit-log/actions — list distinct actions for filter dropdown
router.get('/actions', (req, res) => {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all();
  res.json(actions.map(a => a.action));
});

// GET /api/audit-log/entity-types — list distinct entity types
router.get('/entity-types', (req, res) => {
  const types = db.prepare('SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type').all();
  res.json(types.map(t => t.entity_type));
});

module.exports = router;
