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

// ─── Pairing quality helpers ─────────────────────────────────────────────────
// computePairWarnings:   non-blocking diagnostics returned to the UI on
//                        create/auto-suggest so the admin sees mismatch issues
//                        BEFORE clicking approve.
// computePairScore:      0-100 quality score per pairing — surfaces how
//                        confident we are this is a good match.
//
// Both are pure functions given the joined campaign + inventory rows.

function computePairWarnings(c, i) {
  const warnings = [];
  const invGeo  = (i.geo || '').toUpperCase().trim();
  const cGeos   = (c.allowed_countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (invGeo && cGeos.length > 0 && !cGeos.includes(invGeo)) {
    warnings.push({
      level: 'high',
      code: 'geo_mismatch',
      message: `Campaign targets [${cGeos.join(', ')}] but this site serves ${invGeo} visitors. Visitors won't see this offer.`,
    });
  }
  const invVert = (i.vertical || '').toLowerCase().trim();
  const cVert   = (c.vertical || '').toLowerCase().trim();
  const cTags   = (',' + (c.tags || '').toLowerCase() + ',');
  if (invVert && cVert && cVert !== invVert && !cTags.includes(',' + invVert + ',')) {
    warnings.push({
      level: 'medium',
      code: 'vertical_mismatch',
      message: `Campaign vertical "${cVert}" doesn't match site vertical "${invVert}". Conversion rate may be lower.`,
    });
  }
  if (c.visibility === 'private') {
    warnings.push({
      level: 'high',
      code: 'silent_fail_private',
      message: `Campaign visibility is "private" — this offer won't serve via /api/v1/serve. Switch visibility to "open" to make it live.`,
    });
  }
  // Creative presence check — handled by caller (needs a separate query).
  // If c.active_creatives_count is provided, use it.
  if (c.active_creatives_count != null && c.active_creatives_count === 0) {
    warnings.push({
      level: 'low',
      code: 'no_creative',
      message: `Campaign has no active creative. SDK will fall back to bare campaign name + payout instead of a rich offer card.`,
    });
  }
  if (c.payout != null && Number(c.payout) === 0) {
    warnings.push({
      level: 'medium',
      code: 'zero_payout',
      message: `Campaign payout is $0. Conversions won't earn you anything.`,
    });
  }
  return warnings;
}

function computePairScore(c, i) {
  let score = 0;
  const breakdown = {};

  // Vertical match: exact 40, tag-match 25, neither 0
  const invVert = (i.vertical || '').toLowerCase().trim();
  const cVert   = (c.vertical || '').toLowerCase().trim();
  const cTags   = (',' + (c.tags || '').toLowerCase() + ',');
  if (invVert && cVert && cVert === invVert) { score += 40; breakdown.vertical = 'exact'; }
  else if (invVert && cTags.includes(',' + invVert + ','))     { score += 25; breakdown.vertical = 'tag'; }
  else                                                          { breakdown.vertical = 'none'; }

  // GEO overlap: 30
  const invGeo  = (i.geo || '').toUpperCase().trim();
  const cGeos   = (c.allowed_countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (invGeo && cGeos.includes(invGeo))    { score += 30; breakdown.geo = 'match'; }
  else if (!invGeo || cGeos.length === 0)  { score += 10; breakdown.geo = 'unknown'; }
  else                                      { breakdown.geo = 'no-overlap'; }

  // Active creative present: 15
  if (c.active_creatives_count > 0)        { score += 15; breakdown.creative = 'present'; }
  else                                      { breakdown.creative = 'missing'; }

  // Payout tier: high $50+ 15, mid $5-50 10, low $0.01-5 5, zero 0
  const p = Number(c.payout) || 0;
  if (p >= 50)      { score += 15; breakdown.payout_tier = 'high'; }
  else if (p >= 5)  { score += 10; breakdown.payout_tier = 'mid'; }
  else if (p > 0)   { score += 5;  breakdown.payout_tier = 'low'; }
  else              { breakdown.payout_tier = 'zero'; }

  return { score, breakdown };
}

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
    if (req.query.advertiser_id) {
      conditions.push('c.advertiser_id = ?');
      params.push(Number(req.query.advertiser_id));
    }

    const rows = db.prepare(`
      SELECT cia.*,
             c.name AS campaign_name, c.campaign_token, c.payout, c.payout_type, c.vertical AS campaign_vertical,
             c.allowed_countries, c.allowed_devices, c.tags AS campaign_tags, c.status AS campaign_status,
             c.visibility AS campaign_visibility,
             c.advertiser_id,
             COALESCE(NULLIF(u.name, ''), NULLIF(c.advertiser_name, '')) AS advertiser_name,
             i.name AS inventory_name, i.type AS inventory_type, i.domain AS inventory_domain,
             i.vertical AS inventory_vertical, i.geo AS inventory_geo, i.status AS inventory_status,
             i.publisher_id AS inventory_publisher_id,
             rb.email AS reviewed_by_email
      FROM campaign_inventory_approvals cia
      JOIN campaigns       c  ON c.id = cia.campaign_id
      JOIN owned_inventory i  ON i.id = cia.inventory_id
      LEFT JOIN users      u  ON u.id = c.advertiser_id
      LEFT JOIN users      rb ON rb.id = cia.reviewed_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY cia.status ASC, cia.created_at DESC
      LIMIT 500
    `).all(...params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── GET /api/inventory-approvals/advertisers ────────────────────────────────
// Distinct list of advertisers appearing in this owner's approval rows,
// for the filter dropdown at the top of the queue UI.
router.get('/advertisers', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const rows = db.prepare(`
      SELECT DISTINCT
             c.advertiser_id,
             COALESCE(NULLIF(u.name, ''), NULLIF(c.advertiser_name, ''), '(unassigned)') AS name,
             COUNT(*) OVER (PARTITION BY c.advertiser_id) AS approval_count
      FROM campaign_inventory_approvals cia
      JOIN campaigns c  ON c.id = cia.campaign_id
      LEFT JOIN users u ON u.id = c.advertiser_id
      WHERE cia.user_id = ?
      ORDER BY name ASC
    `).all(ownerId);
    res.json({ advertisers: rows });
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
      `SELECT c.id, c.name, c.vertical, c.tags, c.allowed_countries, c.payout,
              COALESCE(c.visibility, 'open') AS visibility,
              (SELECT COUNT(*) FROM campaign_creatives cre
               WHERE cre.campaign_id = c.id AND cre.status = 'active') AS active_creatives_count
       FROM campaigns c WHERE ${camConds.join(' AND ')}`
    ).all(...camParams);

    const minScore = Number(req.body?.min_score || 0);

    // Strict mode (default true): a campaign MUST have vertical AND
    // allowed_countries set or it's excluded.  Otherwise auto-suggest
    // pairs the campaign with every inventory (silent bug — was the
    // 2026-05-17 root cause where DGMAX MX/BR campaigns landed on US
    // insurance and MX finance sites incorrectly).
    //
    // Set { strict: false } in body to keep the old permissive behavior.
    const strict = req.body?.strict !== false;

    const suggestions = [];
    const skippedCampaigns = [];
    for (const c of campaigns) {
      const cVert = (c.vertical || '').trim();
      const cGeos = (c.allowed_countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (strict) {
        if (!cVert)          { skippedCampaigns.push({ id: c.id, name: c.name, reason: 'missing vertical' }); continue; }
        if (cGeos.length === 0) { skippedCampaigns.push({ id: c.id, name: c.name, reason: 'missing allowed_countries' }); continue; }
      }
    }
    const eligibleCampaigns = campaigns.filter(c =>
      !skippedCampaigns.some(s => s.id === c.id)
    );

    for (const inv of inventory) {
      const invVertical = (inv.vertical || '').toLowerCase().trim();
      const invGeo      = (inv.geo || '').toUpperCase().trim();
      for (const c of eligibleCampaigns) {
        const cVert    = (c.vertical || '').toLowerCase().trim();
        const cTags    = (',' + (c.tags || '').toLowerCase() + ',');
        const cGeos    = (c.allowed_countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

        // In strict mode every campaign has both vertical + countries.
        // Inventory side: vertical/geo may still be empty (legacy data).
        let verticalOk = true;
        if (invVertical && cVert) {
          verticalOk = cVert === invVertical || cTags.includes(',' + invVertical + ',');
        }
        if (!verticalOk) continue;

        let geoOk = true;
        if (invGeo && cGeos.length > 0) {
          geoOk = cGeos.includes(invGeo);
        }
        if (!geoOk) continue;

        const { score, breakdown } = computePairScore(c, inv);
        if (score < minScore) continue;
        suggestions.push({
          campaign_id: c.id, inventory_id: inv.id, campaign_name: c.name,
          match_score: score, match_breakdown: breakdown,
        });
      }
    }
    suggestions.sort((a, b) => (b.match_score || 0) - (a.match_score || 0));

    if (dryRun) {
      return res.json({
        dry_run: true,
        would_insert: suggestions.length,
        suggestions,
        skipped_campaigns: skippedCampaigns,
        strict_mode: strict,
      });
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
    res.json({
      ok: true,
      evaluated: suggestions.length,
      inserted,
      already_existed: suggestions.length - inserted,
      skipped_campaigns: skippedCampaigns,
      strict_mode: strict,
    });
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
    // Pull full campaign + inventory rows for warning + score computation
    const c = db.prepare(`
      SELECT c.id, c.name, c.vertical, c.allowed_countries, c.tags, c.payout,
             COALESCE(c.visibility, 'open') AS visibility,
             (SELECT COUNT(*) FROM campaign_creatives cre
              WHERE cre.campaign_id = c.id AND cre.status = 'active') AS active_creatives_count
      FROM campaigns c
      WHERE c.id = ? AND c.user_id = ?
    `).get(campaign_id, ownerId);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const inv = db.prepare("SELECT id, vertical, geo FROM owned_inventory WHERE id = ? AND user_id = ? AND status != 'deleted'").get(inventory_id, ownerId);
    if (!inv) return res.status(404).json({ error: 'Inventory not found' });

    const warnings = computePairWarnings(c, inv);
    const { score, breakdown } = computePairScore(c, inv);

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
        afterState:  { status, priority, weight, score, warnings: warnings.map(w => w.code) },
      });
      res.status(201).json({ ...created, warnings, match_score: score, match_breakdown: breakdown });
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

// ─── GET /api/inventory-approvals/audit-mismatches ───────────────────────────
// Walks every existing approval row and flags pairings that look wrong:
//   - GEO mismatch    (campaign.allowed_countries does NOT contain inventory.geo)
//   - vertical mismatch (campaign.vertical != inventory.vertical AND not in tags)
//   - visibility silent-fail (status=approved but campaign visibility=private →
//       won't serve via /api/v1/serve)
//   - no creative     (status=approved but campaign has 0 active creatives →
//       offer renders as bare name + payout, not the rich card)
// Returns a categorized list — admin can use these IDs with bulk reject/unblock.
router.get('/audit-mismatches', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const rows = db.prepare(`
      SELECT cia.id, cia.campaign_id, cia.inventory_id, cia.status,
             c.name AS campaign_name,
             c.vertical AS campaign_vertical, c.allowed_countries, c.tags,
             COALESCE(c.visibility, 'open') AS visibility,
             i.name AS inventory_name, i.vertical AS inventory_vertical, i.geo AS inventory_geo,
             (SELECT COUNT(*) FROM campaign_creatives cre
              WHERE cre.campaign_id = c.id AND cre.status = 'active') AS active_creatives
      FROM campaign_inventory_approvals cia
      JOIN campaigns       c ON c.id = cia.campaign_id
      JOIN owned_inventory i ON i.id = cia.inventory_id
      WHERE cia.user_id = ? AND cia.status = 'approved'
    `).all(ownerId);

    const issues = {
      geo_mismatch: [],
      vertical_mismatch: [],
      silent_fail_private: [],
      no_creative: [],
    };

    for (const r of rows) {
      const invGeo = (r.inventory_geo || '').toUpperCase().trim();
      const cGeos  = (r.allowed_countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (invGeo && cGeos.length > 0 && !cGeos.includes(invGeo)) {
        issues.geo_mismatch.push({
          approval_id: r.id, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
          inventory_name: r.inventory_name,
          campaign_geos: cGeos, inventory_geo: invGeo,
        });
      }

      const invVert = (r.inventory_vertical || '').toLowerCase().trim();
      const cVert   = (r.campaign_vertical   || '').toLowerCase().trim();
      const cTags   = (',' + (r.tags || '').toLowerCase() + ',');
      if (invVert && cVert && cVert !== invVert && !cTags.includes(',' + invVert + ',')) {
        issues.vertical_mismatch.push({
          approval_id: r.id, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
          inventory_name: r.inventory_name,
          campaign_vertical: cVert, inventory_vertical: invVert,
        });
      }

      if (r.visibility === 'private') {
        issues.silent_fail_private.push({
          approval_id: r.id, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
          inventory_name: r.inventory_name,
          note: 'Approved but visibility=private — /api/v1/serve will NOT return this offer.',
        });
      }

      if (r.active_creatives === 0) {
        issues.no_creative.push({
          approval_id: r.id, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
          inventory_name: r.inventory_name,
          note: 'Approved but campaign has no active creatives — SDK falls back to bare name + payout.',
        });
      }
    }

    res.json({
      audited: rows.length,
      issues_found: Object.values(issues).reduce((s, a) => s + a.length, 0),
      issues,
    });
  } catch (err) { next(err); }
});

// ─── GET /api/inventory-approvals/campaign-hygiene ───────────────────────────
// Lists campaigns missing fields that cause auto-suggest to misfire or that
// silently break the serve flow.  These are the upstream causes of most
// bad approvals — fix the campaign and re-run auto-suggest.
router.get('/campaign-hygiene', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const rows = db.prepare(`
      SELECT c.id, c.name, c.vertical, c.allowed_countries, c.payout, c.payout_type,
             COALESCE(c.visibility, 'open') AS visibility,
             c.status,
             (SELECT COUNT(*) FROM campaign_creatives cre
              WHERE cre.campaign_id = c.id AND cre.status = 'active') AS active_creatives
      FROM campaigns c
      WHERE c.user_id = ? AND c.status = 'active'
    `).all(ownerId);

    const issues = {
      missing_vertical:    [],
      missing_countries:   [],
      zero_payout:         [],
      no_active_creative:  [],
      private_visibility:  [],   // surfaced separately — sometimes intentional
    };

    for (const c of rows) {
      const base = { id: c.id, name: c.name };
      if (!c.vertical || c.vertical.trim() === '')                    issues.missing_vertical.push(base);
      if (!c.allowed_countries || c.allowed_countries.trim() === '')  issues.missing_countries.push(base);
      if (!c.payout || Number(c.payout) === 0)                        issues.zero_payout.push({ ...base, payout: c.payout });
      if (c.active_creatives === 0)                                   issues.no_active_creative.push(base);
      if (c.visibility === 'private')                                 issues.private_visibility.push({ ...base, note: "won't serve via /api/v1/serve unless changed to 'open'" });
    }

    res.json({
      total_active_campaigns: rows.length,
      issues_found: Object.values(issues).reduce((s, a) => s + a.length, 0),
      issues,
    });
  } catch (err) { next(err); }
});

// ─── eCPM auction — recompute endpoints ──────────────────────────────────────
const { computeEcpm, recomputeForOwner } = require('../utils/ecpmCalculator');

// POST /api/inventory-approvals/recompute-ecpm — recompute every approval the owner has
router.post('/recompute-ecpm', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const result = recomputeForOwner(ownerId);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// POST /api/inventory-approvals/:id/recompute-ecpm — recompute one
router.post('/:id/recompute-ecpm', requireRole(...ADMIN_ROLES), (req, res, next) => {
  try {
    const ownerId = getOwnerId(req);
    const row = db.prepare('SELECT id, campaign_id, inventory_id FROM campaign_inventory_approvals WHERE id = ? AND user_id = ?').get(req.params.id, ownerId);
    if (!row) return res.status(404).json({ error: 'Approval not found' });
    const e = computeEcpm({ campaign_id: row.campaign_id, inventory_id: row.inventory_id });
    db.prepare(`
      UPDATE campaign_inventory_approvals
      SET ecpm_estimate = ?, ecpm_sample_size = ?, ecpm_computed_at = unixepoch()
      WHERE id = ?
    `).run(e.ecpm, e.sample_size, row.id);
    res.json({ ok: true, approval_id: row.id, ...e });
  } catch (err) { next(err); }
});

module.exports = router;
