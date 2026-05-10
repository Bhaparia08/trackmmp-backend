/**
 * Owned Inventory — websites and apps owned by the operator, registered as
 * inventory under a publisher. Phase 0 of owned-inventory monetization.
 *
 * GET    /api/inventory                  — list (filters: vertical, geo, type, status, publisher_id)
 * POST   /api/inventory                  — create
 * GET    /api/inventory/:id              — single (with placements)
 * PUT    /api/inventory/:id              — update
 * DELETE /api/inventory/:id              — soft delete
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const audit = require('../utils/auditLog');

const router = express.Router();
router.use(requireAuth);

function getOwnerId(req) {
  if (req.user.role === 'account_manager') {
    const u = db.prepare('SELECT created_by FROM users WHERE id = ?').get(req.user.id);
    return u?.created_by || req.user.id;
  }
  return req.user.id;
}

const VALID_TYPES = ['website', 'app_android', 'app_ios'];

router.get('/', (req, res) => {
  const ownerId = getOwnerId(req);
  const conditions = ['i.user_id = ?', "i.status != 'deleted'"];
  const params = [ownerId];

  if (req.query.vertical)     { conditions.push('i.vertical = ?');     params.push(req.query.vertical); }
  if (req.query.geo)          { conditions.push('i.geo = ?');          params.push(req.query.geo); }
  if (req.query.type)         { conditions.push('i.type = ?');         params.push(req.query.type); }
  if (req.query.status)       { conditions.push('i.status = ?');       params.push(req.query.status); }
  if (req.query.publisher_id) { conditions.push('i.publisher_id = ?'); params.push(Number(req.query.publisher_id)); }

  const rows = db.prepare(`
    SELECT i.*, p.name AS publisher_name, p.pub_token,
           (SELECT COUNT(*) FROM placements pl WHERE pl.inventory_id = i.id AND pl.status != 'deleted') AS placement_count
    FROM owned_inventory i
    LEFT JOIN publishers p ON p.id = i.publisher_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY i.created_at DESC
  `).all(...params);
  res.json(rows);
});

router.post('/', (req, res, next) => {
  try {
    const { publisher_id, type = 'website', name, domain, bundle_id, vertical = '', geo = '', notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!publisher_id) return res.status(400).json({ error: 'publisher_id is required' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    if (type === 'website' && !domain) return res.status(400).json({ error: 'domain is required for website inventory' });
    if ((type === 'app_android' || type === 'app_ios') && !bundle_id) {
      return res.status(400).json({ error: 'bundle_id is required for app inventory' });
    }

    const ownerId = getOwnerId(req);
    const pub = db.prepare("SELECT id FROM publishers WHERE id = ? AND user_id = ? AND status != 'deleted'").get(publisher_id, ownerId);
    if (!pub) return res.status(404).json({ error: 'Publisher not found' });

    const result = db.prepare(
      `INSERT INTO owned_inventory (user_id, publisher_id, type, name, domain, bundle_id, vertical, geo, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ownerId, publisher_id, type, name, domain || null, bundle_id || null, vertical, geo, notes || null);

    const created = db.prepare('SELECT * FROM owned_inventory WHERE id = ?').get(result.lastInsertRowid);
    audit.log(req, 'create', 'owned_inventory', created.id, created.name, { type, vertical, geo, publisher_id });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const ownerId = getOwnerId(req);
  const row = db.prepare(`
    SELECT i.*, p.name AS publisher_name, p.pub_token
    FROM owned_inventory i
    LEFT JOIN publishers p ON p.id = i.publisher_id
    WHERE i.id = ? AND i.user_id = ?
  `).get(req.params.id, ownerId);
  if (!row) return res.status(404).json({ error: 'Inventory not found' });
  const placements = db.prepare(
    "SELECT * FROM placements WHERE inventory_id = ? AND status != 'deleted' ORDER BY created_at DESC"
  ).all(row.id);
  res.json({ ...row, placements });
});

router.put('/:id', (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = db.prepare('SELECT * FROM owned_inventory WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Inventory not found' });

    const b = req.body;
    if (b.type !== undefined && !VALID_TYPES.includes(b.type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (b.publisher_id !== undefined && b.publisher_id !== row.publisher_id) {
      const pub = db.prepare("SELECT id FROM publishers WHERE id = ? AND user_id = ? AND status != 'deleted'").get(b.publisher_id, ownerId);
      if (!pub) return res.status(404).json({ error: 'Publisher not found' });
    }

    const nameVal      = (b.name !== undefined && b.name) ? b.name : row.name;
    const typeVal      = b.type        !== undefined ? b.type        : row.type;
    const domainVal    = 'domain'      in b ? (b.domain || null)     : row.domain;
    const bundleVal    = 'bundle_id'   in b ? (b.bundle_id || null)  : row.bundle_id;
    const verticalVal  = 'vertical'    in b ? (b.vertical ?? '')     : row.vertical;
    const geoVal       = 'geo'         in b ? (b.geo ?? '')          : row.geo;
    const statusVal    = b.status      !== undefined ? (b.status || row.status) : row.status;
    const notesVal     = 'notes'       in b ? (b.notes || null)      : row.notes;
    const publisherVal = b.publisher_id !== undefined ? b.publisher_id : row.publisher_id;

    db.prepare(
      `UPDATE owned_inventory
       SET publisher_id=?, type=?, name=?, domain=?, bundle_id=?, vertical=?, geo=?, status=?, notes=?, updated_at=unixepoch()
       WHERE id=?`
    ).run(publisherVal, typeVal, nameVal, domainVal, bundleVal, verticalVal, geoVal, statusVal, notesVal, row.id);

    audit.log(req, 'update', 'owned_inventory', row.id, nameVal, { fields: Object.keys(req.body) });
    res.json(db.prepare('SELECT * FROM owned_inventory WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = db.prepare('SELECT * FROM owned_inventory WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Inventory not found' });
    db.prepare("UPDATE owned_inventory SET status='deleted', updated_at=unixepoch() WHERE id = ?").run(row.id);
    audit.log(req, 'delete', 'owned_inventory', row.id, row.name);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
