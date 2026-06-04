/**
 * Placements — ad slots within an owned inventory unit. Phase 0 of
 * owned-inventory monetization.
 *
 * GET    /api/placements                  — list (filters: inventory_id, status, placement_type)
 * POST   /api/placements                  — create
 * GET    /api/placements/:id              — single
 * PUT    /api/placements/:id              — update
 * DELETE /api/placements/:id              — soft delete
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

// Single-tenant network: admins see/edit every placement regardless of which
// admin user_id created it. Non-admins stay scoped to their owner.
const isAdmin = (req) => req.user.role === 'admin';

const VALID_TYPES   = ['comparison_table', 'offer_card', 'cta', 'banner', 'interstitial'];
const VALID_FORMATS = ['html', 'json', 'image_link'];
const SLUG_RE       = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Sensible default per placement type. comparison_table wants several offers;
// the others render a single creative.
const DEFAULT_MAX_OFFERS = {
  comparison_table: 10,
  offer_card:       1,
  cta:              1,
  banner:           1,
  interstitial:     1,
};

// Slugify "Top 10 Sportsbooks" → "top-10-sportsbooks". Server-side fallback so
// the API works even if the caller doesn't pre-slugify.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'placement';
}

// Check that no OTHER placement under the same publisher already uses this
// slug. The DB only enforces uniqueness within a single inventory, but the
// /api/v1/serve endpoint resolves slugs per-publisher — collisions across
// inventory units cause silent wrong-routing. We enforce at the API layer.
//   excludeId — pass current placement.id when called from PUT to allow
//               the row to keep its own slug.
function checkSlugUniqueForPublisher(slug, publisherId, excludeId = null) {
  const sql = `
    SELECT p.id, i.name AS inv_name
    FROM placements p
    JOIN owned_inventory i ON i.id = p.inventory_id
    WHERE i.publisher_id = ? AND p.slug = ? AND p.status != 'deleted'
      ${excludeId ? 'AND p.id != ?' : ''}
    LIMIT 1
  `;
  const params = excludeId ? [publisherId, slug, excludeId] : [publisherId, slug];
  return db.prepare(sql).get(...params);
}

router.get('/', (req, res) => {
  const ownerId = getOwnerId(req);
  const conditions = ["p.status != 'deleted'"];
  const params = [];
  if (!isAdmin(req)) { conditions.push('p.user_id = ?'); params.push(ownerId); }

  if (req.query.inventory_id)   { conditions.push('p.inventory_id = ?');   params.push(Number(req.query.inventory_id)); }
  if (req.query.status)         { conditions.push('p.status = ?');         params.push(req.query.status); }
  if (req.query.placement_type) { conditions.push('p.placement_type = ?'); params.push(req.query.placement_type); }

  const rows = db.prepare(`
    SELECT p.*,
           i.name AS inventory_name, i.vertical AS inventory_vertical,
           i.geo AS inventory_geo, i.type AS inventory_type
    FROM placements p
    LEFT JOIN owned_inventory i ON i.id = p.inventory_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.created_at DESC
  `).all(...params);
  res.json(rows);
});

router.post('/', (req, res, next) => {
  try {
    const {
      inventory_id, name,
      placement_type = 'comparison_table',
      format = 'html',
      notes,
    } = req.body;
    let { slug, max_offers } = req.body;

    if (!inventory_id) return res.status(400).json({ error: 'inventory_id is required' });
    if (!name)         return res.status(400).json({ error: 'name is required' });

    // Smart defaults: derive slug from name if missing; pick max_offers per type.
    if (!slug) slug = slugify(name);
    if (max_offers == null || max_offers === '') max_offers = DEFAULT_MAX_OFFERS[placement_type] ?? 1;

    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'slug must start with a letter or number and contain only lowercase letters, numbers, hyphens, or underscores (max 64 chars)' });
    }
    if (!VALID_TYPES.includes(placement_type)) {
      return res.status(400).json({ error: `placement_type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!VALID_FORMATS.includes(format)) {
      return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(', ')}` });
    }
    const maxOffersNum = Number(max_offers);
    if (!Number.isInteger(maxOffersNum) || maxOffersNum < 1 || maxOffersNum > 50) {
      return res.status(400).json({ error: 'max_offers must be an integer between 1 and 50' });
    }

    const ownerId = getOwnerId(req);
    const inv = isAdmin(req)
      ? db.prepare("SELECT id, publisher_id FROM owned_inventory WHERE id = ? AND status != 'deleted'").get(inventory_id)
      : db.prepare("SELECT id, publisher_id FROM owned_inventory WHERE id = ? AND user_id = ? AND status != 'deleted'").get(inventory_id, ownerId);
    if (!inv) return res.status(404).json({ error: 'Inventory not found' });

    // Publisher-scoped slug uniqueness check. The /api/v1/serve endpoint
    // resolves placements by slug + publisher_id, so the same slug on two
    // different inventory units under the same publisher would cause silent
    // wrong-routing. Reject early with a clear error.
    const collide = checkSlugUniqueForPublisher(slug, inv.publisher_id);
    if (collide) {
      return res.status(409).json({
        error: `A placement with slug "${slug}" already exists on inventory "${collide.inv_name}". Slugs must be unique across all of your inventory.`,
      });
    }

    try {
      const result = db.prepare(
        `INSERT INTO placements (user_id, inventory_id, name, slug, placement_type, format, max_offers, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ownerId, inventory_id, name, slug, placement_type, format, maxOffersNum, notes || null);

      const created = db.prepare('SELECT * FROM placements WHERE id = ?').get(result.lastInsertRowid);
      audit.log(req, 'create', 'placement', created.id, created.name, { inventory_id, slug, placement_type });
      res.status(201).json(created);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return res.status(409).json({ error: 'A placement with this slug already exists on this inventory' });
      }
      throw e;
    }
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const ownerId = getOwnerId(req);
  const row = isAdmin(req)
    ? db.prepare(`
        SELECT p.*,
               i.name AS inventory_name, i.vertical AS inventory_vertical,
               i.geo AS inventory_geo, i.type AS inventory_type
        FROM placements p
        LEFT JOIN owned_inventory i ON i.id = p.inventory_id
        WHERE p.id = ?
      `).get(req.params.id)
    : db.prepare(`
        SELECT p.*,
               i.name AS inventory_name, i.vertical AS inventory_vertical,
               i.geo AS inventory_geo, i.type AS inventory_type
        FROM placements p
        LEFT JOIN owned_inventory i ON i.id = p.inventory_id
        WHERE p.id = ? AND p.user_id = ?
      `).get(req.params.id, ownerId);
  if (!row) return res.status(404).json({ error: 'Placement not found' });
  res.json(row);
});

router.put('/:id', (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = isAdmin(req)
      ? db.prepare('SELECT * FROM placements WHERE id = ?').get(req.params.id)
      : db.prepare('SELECT * FROM placements WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Placement not found' });

    const b = req.body;
    if (b.placement_type !== undefined && !VALID_TYPES.includes(b.placement_type)) {
      return res.status(400).json({ error: `placement_type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (b.format !== undefined && !VALID_FORMATS.includes(b.format)) {
      return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(', ')}` });
    }
    if (b.slug !== undefined && !SLUG_RE.test(b.slug)) {
      return res.status(400).json({ error: 'invalid slug format' });
    }
    // Publisher-scoped slug check on slug change.
    if (b.slug !== undefined && b.slug !== row.slug) {
      const inv = db.prepare("SELECT publisher_id FROM owned_inventory WHERE id = ?").get(row.inventory_id);
      if (inv) {
        const collide = checkSlugUniqueForPublisher(b.slug, inv.publisher_id, row.id);
        if (collide) {
          return res.status(409).json({
            error: `A placement with slug "${b.slug}" already exists on inventory "${collide.inv_name}". Slugs must be unique across all of your inventory.`,
          });
        }
      }
    }
    if (b.max_offers !== undefined) {
      const n = Number(b.max_offers);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return res.status(400).json({ error: 'max_offers must be an integer between 1 and 50' });
      }
    }

    const nameVal     = (b.name !== undefined && b.name) ? b.name : row.name;
    const slugVal     = b.slug           !== undefined ? b.slug          : row.slug;
    const typeVal     = b.placement_type !== undefined ? b.placement_type: row.placement_type;
    const formatVal   = b.format         !== undefined ? b.format        : row.format;
    const maxOffVal   = b.max_offers     !== undefined ? Number(b.max_offers) : row.max_offers;
    const statusVal   = b.status         !== undefined ? (b.status || row.status) : row.status;
    const notesVal    = 'notes'          in b ? (b.notes || null)        : row.notes;
    // Prebid hooks — floor eCPM and (optionally) JSON config for SDK to consume
    const floorVal    = b.floor_ecpm     !== undefined ? Math.max(0, Number(b.floor_ecpm) || 0) : row.floor_ecpm;
    let   prebidVal   = row.prebid_config;
    if (b.prebid_config !== undefined) {
      const v = b.prebid_config;
      if (v === '' || v === null) prebidVal = '';
      else if (typeof v === 'string') {
        try { JSON.parse(v); prebidVal = v; }
        catch { return res.status(400).json({ error: 'prebid_config must be valid JSON or empty string' }); }
      } else if (typeof v === 'object') {
        prebidVal = JSON.stringify(v);
      }
    }

    try {
      db.prepare(
        `UPDATE placements
         SET name=?, slug=?, placement_type=?, format=?, max_offers=?, status=?, notes=?,
             floor_ecpm=?, prebid_config=?, updated_at=unixepoch()
         WHERE id=?`
      ).run(nameVal, slugVal, typeVal, formatVal, maxOffVal, statusVal, notesVal,
            floorVal, prebidVal, row.id);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return res.status(409).json({ error: 'A placement with this slug already exists on this inventory' });
      }
      throw e;
    }

    audit.log(req, 'update', 'placement', row.id, nameVal, { fields: Object.keys(req.body) });
    res.json(db.prepare('SELECT * FROM placements WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = isAdmin(req)
      ? db.prepare('SELECT * FROM placements WHERE id = ?').get(req.params.id)
      : db.prepare('SELECT * FROM placements WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Placement not found' });
    db.prepare("UPDATE placements SET status='deleted', updated_at=unixepoch() WHERE id = ?").run(row.id);
    audit.log(req, 'delete', 'placement', row.id, row.name);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
