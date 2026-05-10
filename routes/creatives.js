/**
 * Campaign Creatives — rich offer presentation data (logo, headline, bonus,
 * rating, terms, CTA). 1:N from campaigns. Mounted under /api/campaigns/:campaign_id/creatives.
 *
 * GET    /api/campaigns/:campaign_id/creatives          — list
 * POST   /api/campaigns/:campaign_id/creatives          — create
 * GET    /api/campaigns/:campaign_id/creatives/:id      — single
 * PUT    /api/campaigns/:campaign_id/creatives/:id      — update
 * DELETE /api/campaigns/:campaign_id/creatives/:id      — soft delete
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const audit = require('../utils/auditLog');
const serveCache = require('../utils/serveCache');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// Invalidate cached /api/v1/serve responses for every placement where this
// campaign is currently approved — its rendered creative just changed.
function invalidatePlacementsForCampaign(campaignId) {
  const rows = db.prepare(`
    SELECT DISTINCT pl.id
    FROM placements pl
    JOIN campaign_inventory_approvals cia ON cia.inventory_id = pl.inventory_id
    WHERE cia.campaign_id = ? AND cia.status = 'approved' AND pl.status = 'active'
  `).all(campaignId);
  let total = 0;
  for (const r of rows) total += serveCache.invalidatePlacement(r.id);
  return total;
}

function getOwnerId(req) {
  if (req.user.role === 'account_manager') {
    const u = db.prepare('SELECT created_by FROM users WHERE id = ?').get(req.user.id);
    return u?.created_by || req.user.id;
  }
  return req.user.id;
}

function ownerCampaign(req) {
  const ownerId = getOwnerId(req);
  return db.prepare('SELECT id, user_id FROM campaigns WHERE id = ? AND user_id = ?')
    .get(req.params.campaign_id, ownerId);
}

const ALLOWED_FIELDS = [
  'name', 'logo_url', 'hero_image_url', 'brand_name', 'headline', 'subheadline',
  'bonus_amount', 'bonus_label', 'terms_short', 'cta_text',
  'rating', 'rating_count', 'badge_text', 'badge_color',
  'weight', 'status', 'notes',
];

router.get('/', (req, res, next) => {
  try {
    const c = ownerCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const rows = db.prepare(
      "SELECT * FROM campaign_creatives WHERE campaign_id = ? AND status != 'deleted' ORDER BY weight DESC, created_at DESC"
    ).all(c.id);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', (req, res, next) => {
  try {
    const c = ownerCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });

    const ownerId = getOwnerId(req);
    const fields = ['user_id', 'campaign_id'];
    const placeholders = ['?', '?'];
    const values = [ownerId, c.id];
    for (const k of ALLOWED_FIELDS) {
      if (k in req.body) {
        fields.push(k);
        placeholders.push('?');
        values.push(req.body[k] ?? null);
      }
    }
    const result = db.prepare(
      `INSERT INTO campaign_creatives (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`
    ).run(...values);
    const created = db.prepare('SELECT * FROM campaign_creatives WHERE id = ?').get(result.lastInsertRowid);
    audit.log(req, 'create', 'campaign_creative', created.id, created.brand_name || created.name, { campaign_id: c.id });
    invalidatePlacementsForCampaign(c.id);
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.get('/:id', (req, res, next) => {
  try {
    const c = ownerCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const row = db.prepare('SELECT * FROM campaign_creatives WHERE id = ? AND campaign_id = ?').get(req.params.id, c.id);
    if (!row) return res.status(404).json({ error: 'Creative not found' });
    res.json(row);
  } catch (err) { next(err); }
});

router.put('/:id', (req, res, next) => {
  try {
    const c = ownerCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const row = db.prepare('SELECT * FROM campaign_creatives WHERE id = ? AND campaign_id = ?').get(req.params.id, c.id);
    if (!row) return res.status(404).json({ error: 'Creative not found' });

    const sets = [];
    const values = [];
    for (const k of ALLOWED_FIELDS) {
      if (k in req.body) {
        sets.push(`${k} = ?`);
        values.push(req.body[k] ?? null);
      }
    }
    if (sets.length === 0) return res.json(row);
    sets.push('updated_at = unixepoch()');
    values.push(row.id);
    db.prepare(`UPDATE campaign_creatives SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    audit.log(req, 'update', 'campaign_creative', row.id, row.brand_name || row.name, { fields: Object.keys(req.body) });
    invalidatePlacementsForCampaign(c.id);
    res.json(db.prepare('SELECT * FROM campaign_creatives WHERE id = ?').get(row.id));
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const c = ownerCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const row = db.prepare('SELECT * FROM campaign_creatives WHERE id = ? AND campaign_id = ?').get(req.params.id, c.id);
    if (!row) return res.status(404).json({ error: 'Creative not found' });
    db.prepare("UPDATE campaign_creatives SET status='deleted', updated_at=unixepoch() WHERE id = ?").run(row.id);
    audit.log(req, 'delete', 'campaign_creative', row.id, row.brand_name || row.name);
    invalidatePlacementsForCampaign(c.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
