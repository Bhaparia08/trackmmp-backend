/**
 * Inventory Approvals — per-inventory campaign approval workflow.
 * Phase 0 of owned-inventory monetization.
 *
 * GET    /api/inventory-approvals                 — list (filters: inventory_id, campaign_id, status, vertical, geo)
 * POST   /api/inventory-approvals/auto-suggest    — auto-create pending rows for campaigns matching inventory by vertical+geo
 * POST   /api/inventory-approvals                 — manually create one (admin direct grant)
 * PUT    /api/inventory-approvals/:id/approve     — approve single (audit-logged)
 * PUT    /api/inventory-approvals/:id/reject      — reject single (audit-logged)
 * POST   /api/inventory-approvals/bulk            — bulk by {ids[], action} or {campaign_ids[], inventory_ids[], action}
 * GET    /api/inventory-approvals/audit           — list audit entries (filters: inventory_id, campaign_id, action)
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const serveCache = require('../utils/serveCache');

const router = express.Router();
router.use(requireAuth);

// Invalidate cached /api/v1/serve responses for every placement under the
// given inventory, since the approved-campaign set just changed.
function invalidatePlacementsForInventory(inventoryId) {
  const placements = db.prepare(
    "SELECT id FROM placements WHERE inventory_id = ? AND status = 'active'"
  ).all(inventoryId);
  let total = 0;
  for (const p of placements) total += serveCache.invalidatePlacement(p.id);
  return total;
}

function getOwnerId(req) {
  if (req.user.role === 'account_manager') {
    const u = db.prepare('SELECT created_by FROM users WHERE id = ?').get(req.user.id);
    return u?.created_by || req.user.id;
  }
  return req.user.id;
}

const VALID_STATUSES = ['pending', 'approved', 'rejected'];
const ADMIN_ROLES    = ['admin', 'account_manager'];

function writeAudit({ approvalId, campaignId, inventoryId, actorId, action, beforeState, afterState, reason }) {
  db.prepare(
    `INSERT INTO inventory_approval_audit
       (approval_id, campaign_id, inventory_id, actor_id, action, before_state, after_state, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    approvalId || null,
    campaignId,
    inventoryId,
    actorId,
    action,
    beforeState ? JSON.stringify(beforeState) : null,
    afterState  ? JSON.stringify(afterState)  : null,
    reason || null,
  );
}

// ─── GET /api/inventory-approvals ────────────────────────────────────────────
router.get('/', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const conditions = ['cia.user_id = ?'];
    const params = [ownerId];

    if (req.query.inventory_id) { conditions.push('cia.inventory_id = ?'); params.push(Number(req.query.inventory_id)); }
    if (req.query.campaign_id)  { conditions.push('cia.campaign_id = ?');  params.push(Number(req.query.campaign_id)); }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      conditions.push('cia.status = ?');
      params.push(req.query.status);
    }
    if (req.query.vertical) { conditions.push('i.vertical = ?'); params.push(req.query.vertical); }
    if (req.query.geo)      { conditions.push('i.geo = ?');      params.push(req.query.geo); }

    const rows = db.prepare(`
      SELECT cia.*,
             c.name AS campaign_name, c.campaign_token, c.payout, c.payout_type, c.vertical AS campaign_vertical,
             c.allowed_countries, c.allowed_devices, c.tags AS campaign_tags, c.status AS campaign_status,
             c.visibility AS campaign_visibility,
             i.name AS inventory_name, i.type AS inventory_type, i.domain AS inventory_domain,
             i.vertical AS inventory_vertical, i.geo AS inventory_geo, i.status AS inventory_status,
             i.publisher_id AS inventory_publisher_id,
             rb.email AS reviewed_by_email
      FROM campaign_inventory_approvals cia
      JOIN campaigns       c  ON c.id = cia.campaign_id
      JOIN owned_inventory i  ON i.id = cia.inventory_id
      LEFT JOIN users      rb ON rb.id = cia.reviewed_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY cia.status ASC, cia.created_at DESC
      LIMIT 500
    `).all(...params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── POST /api/inventory-approvals/auto-suggest ──────────────────────────────
// Inserts pending approval rows for every (campaign × inventory) pair where
// vertical matches AND GEO overlaps. Skips pairs that already have a row
// (UNIQUE(campaign_id, inventory_id) enforced by schema).
//
// Body (optional):
//   { inventory_ids?: number[], campaign_ids?: number[], dry_run?: boolean }
router.post('/auto-suggest', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const dryRun  = !!req.body?.dry_run;

    // Owner-scoped active inventory
    let invConds = ["i.user_id = ?", "i.status = 'active'"];
    let invParams = [ownerId];
    if (Array.isArray(req.body?.inventory_ids) && req.body.inventory_ids.length > 0) {
      const ph = req.body.inventory_ids.map(() => '?').join(',');
      invConds.push(`i.id IN (${ph})`);
      invParams.push(...req.body.inventory_ids.map(Number));
    }
    const inventory = db.prepare(
      `SELECT id, vertical, geo FROM owned_inventory i WHERE ${invConds.join(' AND ')}`
    ).all(...invParams);

    // Owner-scoped active campaigns. We INCLUDE private campaigns here because
    // the auto-suggester is run by the campaign owner against their own
    // inventory — visibility='private' just means "not visible to external
    // publishers", which is irrelevant for the owner's own auto-match.
    let camConds = ["c.user_id = ?", "c.status = 'active'"];
    let camParams = [ownerId];
    if (Array.isArray(req.body?.campaign_ids) && req.body.campaign_ids.length > 0) {
      const ph = req.body.campaign_ids.map(() => '?').join(',');
      camConds.push(`c.id IN (${ph})`);
      camParams.push(...req.body.campaign_ids.map(Number));
    }
    const campaigns = db.prepare(
      `SELECT id, name, vertical, tags, allowed_countries FROM campaigns c WHERE ${camConds.join(' AND ')}`
    ).all(...camParams);

    const suggestions = [];
    for (const inv of inventory) {
      const invVertical = (inv.vertical || '').toLowerCase().trim();
      const invGeo      = (inv.geo || '').toUpperCase().trim();
      for (const c of campaigns) {
        // Vertical match: inv.vertical empty → match any; otherwise match
        // c.vertical OR c.tags contains inv.vertical.
        let verticalOk = !invVertical;
        if (!verticalOk) {
          const cVert = (c.vertical || '').toLowerCase().trim();
          const cTags = (',' + (c.tags || '').toLowerCase() + ',');
          verticalOk = cVert === invVertical || cTags.includes(',' + invVertical + ',');
        }
        if (!verticalOk) continue;

        // GEO match: inv.geo empty → any; campaign.allowed_countries empty → any;
        // otherwise the country must appear in allowed_countries.
        let geoOk = !invGeo || !c.allowed_countries;
        if (!geoOk) {
          const allowed = c.allowed_countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
          geoOk = allowed.length === 0 || allowed.includes(invGeo);
        }
        if (!geoOk) continue;

        suggestions.push({ campaign_id: c.id, inventory_id: inv.id, campaign_name: c.name });
      }
    }

    if (dryRun) {
      return res.json({ dry_run: true, would_insert: suggestions.length, suggestions });
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO campaign_inventory_approvals
         (user_id, campaign_id, inventory_id, status)
       VALUES (?, ?, ?, 'pending')`
    );
    let inserted = 0;
    const tx = db.transaction((rows) => {
      for (const s of rows) {
        const r = insert.run(ownerId, s.campaign_id, s.inventory_id);
        if (r.changes > 0) {
          inserted++;
          writeAudit({
            approvalId:  r.lastInsertRowid,
            campaignId:  s.campaign_id,
            inventoryId: s.inventory_id,
            actorId:     req.user.id,
            action:      'auto_suggest',
            afterState:  { status: 'pending' },
            reason:      'auto-match by vertical+GEO',
          });
        }
      }
    });
    tx(suggestions);
    res.json({ ok: true, evaluated: suggestions.length, inserted, skipped: suggestions.length - inserted });
  } catch (err) { next(err); }
});

// ─── POST /api/inventory-approvals  (manual create / direct approve) ─────────
router.post('/', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const { campaign_id, inventory_id, status = 'pending', priority = 0, weight = 100, notes } = req.body;
    if (!campaign_id || !inventory_id) return res.status(400).json({ error: 'campaign_id and inventory_id are required' });
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const ownerId = getOwnerId(req);
    const c = db.prepare("SELECT id FROM campaigns WHERE id = ? AND user_id = ?").get(campaign_id, ownerId);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const inv = db.prepare("SELECT id FROM owned_inventory WHERE id = ? AND user_id = ? AND status != 'deleted'").get(inventory_id, ownerId);
    if (!inv) return res.status(404).json({ error: 'Inventory not found' });

    const isReviewed = status === 'approved' || status === 'rejected';
    try {
      const result = db.prepare(
        `INSERT INTO campaign_inventory_approvals
           (user_id, campaign_id, inventory_id, status, priority, weight, notes, reviewed_by, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ownerId, campaign_id, inventory_id, status, priority, weight, notes || null,
        isReviewed ? req.user.id : null,
        isReviewed ? Math.floor(Date.now() / 1000) : null,
      );
      const created = db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ?').get(result.lastInsertRowid);
      writeAudit({
        approvalId:  created.id,
        campaignId:  campaign_id,
        inventoryId: inventory_id,
        actorId:     req.user.id,
        action:      `create_${status}`,
        afterState:  { status, priority, weight },
      });
      res.status(201).json(created);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return res.status(409).json({ error: 'Approval already exists for this campaign+inventory pair' });
      }
      throw e;
    }
  } catch (err) { next(err); }
});

// ─── PUT /api/inventory-approvals/:id/approve ────────────────────────────────
router.put('/:id/approve', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Approval not found' });

    db.prepare(
      `UPDATE campaign_inventory_approvals
       SET status='approved', reviewed_by=?, reviewed_at=unixepoch(), updated_at=unixepoch()
       WHERE id=?`
    ).run(req.user.id, row.id);

    writeAudit({
      approvalId:  row.id,
      campaignId:  row.campaign_id,
      inventoryId: row.inventory_id,
      actorId:     req.user.id,
      action:      'approve',
      beforeState: { status: row.status },
      afterState:  { status: 'approved' },
      reason:      req.body?.reason,
    });
    invalidatePlacementsForInventory(row.inventory_id);
    res.json(db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

// ─── PUT /api/inventory-approvals/:id/reject ─────────────────────────────────
router.put('/:id/reject', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Approval not found' });

    db.prepare(
      `UPDATE campaign_inventory_approvals
       SET status='rejected', reviewed_by=?, reviewed_at=unixepoch(), updated_at=unixepoch()
       WHERE id=?`
    ).run(req.user.id, row.id);

    writeAudit({
      approvalId:  row.id,
      campaignId:  row.campaign_id,
      inventoryId: row.inventory_id,
      actorId:     req.user.id,
      action:      'reject',
      beforeState: { status: row.status },
      afterState:  { status: 'rejected' },
      reason:      req.body?.reason,
    });
    invalidatePlacementsForInventory(row.inventory_id);
    res.json(db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

// ─── PUT /api/inventory-approvals/:id  (priority/weight/notes adjustments) ───
router.put('/:id', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Approval not found' });

    const b = req.body;
    const priorityVal = b.priority !== undefined ? Number(b.priority) : row.priority;
    const weightVal   = b.weight   !== undefined ? Number(b.weight)   : row.weight;
    const notesVal    = 'notes' in b ? (b.notes || null) : row.notes;
    if (b.priority !== undefined && !Number.isFinite(priorityVal)) return res.status(400).json({ error: 'priority must be a number' });
    if (b.weight   !== undefined && (!Number.isInteger(weightVal) || weightVal < 0 || weightVal > 10000)) {
      return res.status(400).json({ error: 'weight must be an integer between 0 and 10000' });
    }

    db.prepare(
      `UPDATE campaign_inventory_approvals
       SET priority=?, weight=?, notes=?, updated_at=unixepoch()
       WHERE id=?`
    ).run(priorityVal, weightVal, notesVal, row.id);

    writeAudit({
      approvalId:  row.id,
      campaignId:  row.campaign_id,
      inventoryId: row.inventory_id,
      actorId:     req.user.id,
      action:      'update',
      beforeState: { priority: row.priority, weight: row.weight, notes: row.notes },
      afterState:  { priority: priorityVal, weight: weightVal, notes: notesVal },
    });
    // Priority/weight changes affect /serve ordering — invalidate.
    if (priorityVal !== row.priority || weightVal !== row.weight) {
      invalidatePlacementsForInventory(row.inventory_id);
    }
    res.json(db.prepare('SELECT * FROM campaign_inventory_approvals WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

// ─── POST /api/inventory-approvals/bulk ──────────────────────────────────────
// Body shapes:
//   { ids: [1,2,3], action: 'approve'|'reject' }                                — operate on specific approval rows
//   { campaign_ids: [...], inventory_ids: [...], action: 'approve'|'reject' }   — upsert/operate on the cross-product
//   { vertical: 'us-betting', geo: 'US', action: 'approve' }                    — operate on all pending matching that vertical+geo
router.post('/bulk', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const { action, ids, campaign_ids, inventory_ids, vertical, geo } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    // Resolve target approval ids based on body shape
    let targets = [];

    if (Array.isArray(ids) && ids.length > 0) {
      targets = db.prepare(
        `SELECT * FROM campaign_inventory_approvals
         WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`
      ).all(ownerId, ...ids.map(Number));
    } else if (Array.isArray(campaign_ids) && Array.isArray(inventory_ids) && campaign_ids.length > 0 && inventory_ids.length > 0) {
      // Cross-product: upsert any missing rows as pending first, then operate on all
      const upsert = db.prepare(
        `INSERT OR IGNORE INTO campaign_inventory_approvals (user_id, campaign_id, inventory_id, status)
         VALUES (?, ?, ?, 'pending')`
      );
      const tx = db.transaction(() => {
        for (const cid of campaign_ids) for (const iid of inventory_ids) upsert.run(ownerId, Number(cid), Number(iid));
      });
      tx();
      const cph = campaign_ids.map(() => '?').join(',');
      const iph = inventory_ids.map(() => '?').join(',');
      targets = db.prepare(
        `SELECT * FROM campaign_inventory_approvals
         WHERE user_id = ? AND campaign_id IN (${cph}) AND inventory_id IN (${iph})`
      ).all(ownerId, ...campaign_ids.map(Number), ...inventory_ids.map(Number));
    } else if (vertical || geo) {
      const conditions = ['cia.user_id = ?', "cia.status = 'pending'"];
      const params = [ownerId];
      if (vertical) { conditions.push('LOWER(i.vertical) = LOWER(?)'); params.push(vertical); }
      if (geo)      { conditions.push('UPPER(i.geo) = UPPER(?)');      params.push(geo); }
      targets = db.prepare(`
        SELECT cia.*
        FROM campaign_inventory_approvals cia
        JOIN owned_inventory i ON i.id = cia.inventory_id
        WHERE ${conditions.join(' AND ')}
      `).all(...params);
    } else {
      return res.status(400).json({ error: 'provide ids[], or (campaign_ids[] + inventory_ids[]), or vertical/geo filters' });
    }

    if (targets.length === 0) return res.json({ ok: true, affected: 0, action, new_status: newStatus });

    const update = db.prepare(
      `UPDATE campaign_inventory_approvals
       SET status=?, reviewed_by=?, reviewed_at=unixepoch(), updated_at=unixepoch()
       WHERE id=?`
    );
    const tx = db.transaction(() => {
      for (const row of targets) {
        update.run(newStatus, req.user.id, row.id);
        writeAudit({
          approvalId:  row.id,
          campaignId:  row.campaign_id,
          inventoryId: row.inventory_id,
          actorId:     req.user.id,
          action:      `bulk_${action}`,
          beforeState: { status: row.status },
          afterState:  { status: newStatus },
          reason:      req.body?.reason,
        });
      }
    });
    tx();

    // Invalidate cache for every distinct inventory affected.
    const invIds = [...new Set(targets.map((t) => t.inventory_id))];
    for (const id of invIds) invalidatePlacementsForInventory(id);

    res.json({ ok: true, affected: targets.length, action, new_status: newStatus });
  } catch (err) { next(err); }
});

// ─── GET /api/inventory-approvals/audit ──────────────────────────────────────
router.get('/audit', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    // Audit rows have no direct user_id; scope via inventory ownership.
    const conditions = ['i.user_id = ?'];
    const params = [ownerId];
    if (req.query.inventory_id) { conditions.push('a.inventory_id = ?'); params.push(Number(req.query.inventory_id)); }
    if (req.query.campaign_id)  { conditions.push('a.campaign_id = ?');  params.push(Number(req.query.campaign_id)); }
    if (req.query.action)       { conditions.push('a.action = ?');       params.push(req.query.action); }

    const rows = db.prepare(`
      SELECT a.*,
             c.name AS campaign_name,
             i.name AS inventory_name,
             u.email AS actor_email
      FROM inventory_approval_audit a
      JOIN owned_inventory i ON i.id = a.inventory_id
      JOIN campaigns       c ON c.id = a.campaign_id
      LEFT JOIN users      u ON u.id = a.actor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT 500
    `).all(...params);

    // Parse JSON state columns for convenience
    res.json(rows.map((r) => ({
      ...r,
      before_state: r.before_state ? safeJson(r.before_state) : null,
      after_state:  r.after_state  ? safeJson(r.after_state)  : null,
    })));
  } catch (err) { next(err); }
});

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

module.exports = router;
