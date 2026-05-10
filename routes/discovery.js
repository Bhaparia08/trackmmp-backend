/**
 * /api/discovery/* — Discovery Hub backend
 *
 * Auth: JWT (admin or account_manager). Inbound webhook (per-credential
 * HMAC) is the one exception — it's an unauthenticated route at the bottom.
 *
 * IMPORTANT: this route module is purely additive. It does NOT touch:
 *   - routes/integrations.js (existing manual offer-import flow)
 *   - advertiser_api_credentials, campaigns, owned_inventory schemas
 *   - any tracking/postback endpoint
 */
const express = require('express');
const crypto  = require('crypto');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const registry = require('../utils/connectors');
const engine   = require('../utils/discoveryEngine');
const validator = require('../utils/landingPageValidator');
const matcher = require('../utils/inventoryMatcher');

const router = express.Router();

// ── Admin/AM-authenticated section ────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(requireAuth);
adminRouter.use((req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'account_manager') {
    return res.status(403).json({ error: 'Admins or account managers only' });
  }
  next();
});

// GET /api/discovery/connectors — list all connectors with capabilities + creds count
adminRouter.get('/connectors', (_req, res) => {
  const conns = registry.list();
  const rows = db.prepare(`
    SELECT platform, COUNT(*) AS creds_count,
           MAX(last_synced_at) AS last_synced_at,
           MAX(last_sync_status) AS last_sync_status,
           SUM(COALESCE(last_offer_count, 0)) AS offer_count
    FROM advertiser_api_credentials
    GROUP BY platform
  `).all();
  const credsBy = Object.fromEntries(rows.map(r => [r.platform, r]));
  res.json(conns.map(c => ({
    ...c,
    creds: credsBy[c.platform]?.creds_count || 0,
    last_synced_at: credsBy[c.platform]?.last_synced_at || null,
    last_sync_status: credsBy[c.platform]?.last_sync_status || null,
    offer_count: credsBy[c.platform]?.offer_count || 0,
  })));
});

// GET /api/discovery/candidates — paginated/filtered candidate list
adminRouter.get('/candidates', (req, res) => {
  const {
    source_platform, advertiser_id, vertical, validation_status,
    import_status = 'new,reviewing',
    min_match_score,
    search,
    page = 1, limit = 50,
  } = req.query;

  const conds = [];
  const params = [];

  // import_status — comma-separated
  if (import_status) {
    const list = String(import_status).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) {
      conds.push(`import_status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (source_platform)    { conds.push('source_platform = ?');    params.push(source_platform); }
  if (advertiser_id)      { conds.push('source_advertiser_id = ?'); params.push(advertiser_id); }
  if (vertical)           { conds.push('LOWER(vertical) = ?');    params.push(String(vertical).toLowerCase()); }
  if (validation_status)  { conds.push('validation_status = ?');  params.push(validation_status); }
  if (min_match_score)    { conds.push('best_match_score >= ?'); params.push(Number(min_match_score)); }
  if (search) {
    conds.push('(name LIKE ? OR source_advertiser_name LIKE ? OR source_offer_id LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const lim = Math.min(200, +limit || 50);
  const offset = (Math.max(1, +page) - 1) * lim;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM campaign_candidates ${where}`).get(...params).n;

  const rows = db.prepare(`
    SELECT id, source_platform, source_offer_id, source_advertiser_id, source_advertiser_name,
           name, vertical, payout, payout_type, payout_currency,
           allowed_countries, allowed_devices,
           destination_url, preview_url,
           validation_status, validation_checked_at, validation_final_url, validation_http_code, validation_notes,
           best_match_score, best_match_inventory_id, match_breakdown,
           import_status, imported_campaign_id,
           first_seen_at, last_seen_at
    FROM campaign_candidates
    ${where}
    ORDER BY first_seen_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, offset);

  res.json({
    data: rows.map(r => ({
      ...r,
      allowed_countries: safeJSON(r.allowed_countries, []),
      allowed_devices:   safeJSON(r.allowed_devices, []),
      match_breakdown:   safeJSON(r.match_breakdown, {}),
    })),
    total, page: +page, limit: lim, pages: Math.ceil(total / lim),
  });
});

// GET /api/discovery/advertisers — rollup view
adminRouter.get('/advertisers', (_req, res) => {
  const rows = db.prepare(`
    SELECT
      COALESCE(source_advertiser_id, 'unknown')              AS advertiser_id,
      COALESCE(source_advertiser_name, '— unknown —')        AS advertiser_name,
      COUNT(*)                                                AS campaigns_total,
      SUM(CASE WHEN validation_status = 'valid'  THEN 1 ELSE 0 END) AS lp_valid,
      SUM(CASE WHEN validation_status = 'parked' THEN 1 ELSE 0 END) AS lp_parked,
      SUM(CASE WHEN validation_status = 'broken' THEN 1 ELSE 0 END) AS lp_broken,
      SUM(CASE WHEN validation_status = 'pending' THEN 1 ELSE 0 END) AS lp_pending,
      AVG(payout)            AS avg_payout,
      AVG(best_match_score)  AS avg_match,
      MAX(last_seen_at)      AS last_seen_at,
      GROUP_CONCAT(DISTINCT source_platform) AS sources
    FROM campaign_candidates
    GROUP BY advertiser_id
    ORDER BY campaigns_total DESC
  `).all();
  res.json({ data: rows });
});

// GET /api/discovery/candidates/:id — full payload
adminRouter.get('/candidates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...row,
    allowed_countries: safeJSON(row.allowed_countries, []),
    allowed_devices: safeJSON(row.allowed_devices, []),
    allowed_os: safeJSON(row.allowed_os, []),
    normalized_payload: safeJSON(row.normalized_payload, {}),
    raw_payload: safeJSON(row.raw_payload, null),
    match_breakdown: safeJSON(row.match_breakdown, {}),
    validation_redirect_chain: safeJSON(row.validation_redirect_chain, []),
  });
});

// POST /api/discovery/scan — trigger immediate scan (per-platform or all)
adminRouter.post('/scan', async (req, res) => {
  const { platform, credential_id } = req.body || {};
  try {
    if (credential_id) {
      const cred = db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(credential_id);
      if (!cred) return res.status(404).json({ error: 'Credential not found' });
      const r = await engine.scanCredential(cred);
      return res.json({ ok: true, credential_id, ...r });
    }
    if (platform) {
      const creds = db.prepare('SELECT * FROM advertiser_api_credentials WHERE platform = ? AND COALESCE(auto_sync, 1) = 1').all(platform);
      const results = [];
      for (const cred of creds) results.push({ id: cred.id, ...(await engine.scanCredential(cred)) });
      return res.json({ ok: true, platform, results });
    }
    const r = await engine.scanAll();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/discovery/candidates/:id/revalidate — force LP re-check
adminRouter.post('/candidates/:id/revalidate', async (req, res) => {
  const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const url = row.destination_url || row.tracking_url_template;
  if (!url) return res.status(400).json({ error: 'No URL to validate' });

  let countries = []; try { countries = JSON.parse(row.allowed_countries || '[]'); } catch {}
  const result = await validator.validate(url, { mobile: true, country: countries[0] });

  db.prepare(`
    UPDATE campaign_candidates SET
      validation_status = ?, validation_checked_at = unixepoch(),
      validation_final_url = ?, validation_http_code = ?,
      validation_redirect_chain = ?, validation_notes = ?
    WHERE id = ?
  `).run(result.status, result.final_url, result.http_code,
    JSON.stringify(result.chain || []), result.notes || '', row.id);

  res.json({ ok: true, ...result });
});

// POST /api/discovery/candidates/:id/import — import a candidate as a campaign
adminRouter.post('/candidates/:id/import', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.import_status === 'imported') return res.status(400).json({ error: 'Already imported', campaign_id: row.imported_campaign_id });

    const norm = safeJSON(row.normalized_payload, {});
    const inventoryId = req.body?.inventory_id || row.best_match_inventory_id || null;
    const overridePayout = Number(req.body?.payout) || row.payout || 0;

    // Generate a campaign_token similar to existing campaigns
    const tok = crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);

    const result = db.prepare(`
      INSERT INTO campaigns (
        user_id, name, advertiser_name,
        payout, payout_type, publisher_payout, publisher_payout_type,
        allowed_countries, destination_url, preview_url,
        campaign_token, status, visibility, vertical, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'open', ?, ?)
    `).run(
      req.user.id,
      norm.name || row.name,
      norm.advertiser_name || row.source_advertiser_name || '',
      overridePayout,
      norm.payout_type || row.payout_type || 'cpa',
      overridePayout,                      // publisher_payout (admin can edit later)
      norm.payout_type || row.payout_type || 'cpa',
      (norm.allowed_countries || []).join(','),
      norm.destination_url || row.destination_url || '',
      norm.preview_url || row.preview_url || '',
      tok,
      norm.vertical || row.vertical || null,
      `discovery,${norm.source_platform || row.source_platform}`,
    );

    const campaignId = result.lastInsertRowid;

    db.prepare(`
      UPDATE campaign_candidates SET
        import_status = 'imported',
        imported_campaign_id = ?,
        reviewed_by = ?, reviewed_at = unixepoch()
      WHERE id = ?
    `).run(campaignId, req.user.id, row.id);

    // Auto-create an inventory approval if matched
    if (inventoryId) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO campaign_inventory_approvals (campaign_id, inventory_id, status, priority, weight)
          VALUES (?, ?, 'approved', 0, 1)
        `).run(campaignId, inventoryId);
      } catch (e) { /* table may not exist on legacy installs */ }
    }

    res.json({ ok: true, campaign_id: campaignId, candidate_id: row.id });
  } catch (e) { next(e); }
});

// POST /api/discovery/candidates/:id/reject
adminRouter.post('/candidates/:id/reject', (req, res) => {
  const reason = (req.body?.reason || '').slice(0, 500);
  const r = db.prepare(`
    UPDATE campaign_candidates SET
      import_status = 'rejected', rejection_reason = ?,
      reviewed_by = ?, reviewed_at = unixepoch()
    WHERE id = ? AND import_status NOT IN ('imported')
  `).run(reason, req.user.id, req.params.id);
  res.json({ ok: r.changes > 0 });
});

// POST /api/discovery/candidates — manual entry (one-off offer)
adminRouter.post('/candidates', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.destination_url) {
      return res.status(400).json({ error: 'name and destination_url required' });
    }
    const externalId = b.external_id || `manual-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const norm = {
      source_platform: 'custom',
      source_offer_id: externalId,
      source_advertiser_id: b.advertiser_id || null,
      advertiser_name: b.advertiser_name || null,
      name: b.name,
      vertical: b.vertical || null,
      payout: Number(b.payout) || 0,
      payout_type: b.payout_type || 'cpa',
      payout_currency: b.currency || 'USD',
      allowed_countries: Array.isArray(b.allowed_countries) ? b.allowed_countries : (b.allowed_countries || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      allowed_devices: b.allowed_devices || ['mobile','desktop'],
      allowed_os: b.allowed_os || [],
      destination_url: b.destination_url,
      tracking_url_template: b.tracking_url_template || b.destination_url,
      preview_url: b.preview_url || null,
      status: 'active',
      raw: { manual: true, entered_by: req.user.id, ...b },
    };
    const id = engine.upsertCandidate(norm, null);
    engine.enqueueValidation(id);

    // Synchronous validation for immediate UX feedback
    const result = await validator.validate(norm.destination_url, { mobile: true, country: norm.allowed_countries[0] });
    db.prepare(`
      UPDATE campaign_candidates SET
        validation_status = ?, validation_checked_at = unixepoch(),
        validation_final_url = ?, validation_http_code = ?,
        validation_redirect_chain = ?, validation_notes = ?
      WHERE id = ?
    `).run(result.status, result.final_url, result.http_code,
      JSON.stringify(result.chain || []), result.notes || '', id);

    // Score against inventory
    try {
      const m = matcher.score(norm);
      db.prepare(`
        UPDATE campaign_candidates SET
          best_match_score = ?, best_match_inventory_id = ?, match_breakdown = ?
        WHERE id = ?
      `).run(m.score, m.best_inventory_id, JSON.stringify(m.breakdown || {}), id);
    } catch (e) { /* non-fatal */ }

    res.status(201).json({ ok: true, candidate_id: id, validation: result });
  } catch (e) { next(e); }
});

// GET /api/discovery/stats — KPI strip data
adminRouter.get('/stats', (_req, res) => {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS candidates,
      SUM(CASE WHEN validation_status = 'valid' THEN 1 ELSE 0 END) AS valid_lp,
      SUM(CASE WHEN validation_status IN ('broken','parked','redirect_loop','timeout') THEN 1 ELSE 0 END) AS broken_or_parked,
      SUM(CASE WHEN import_status = 'imported' AND reviewed_at >= unixepoch('now','-7 days') THEN 1 ELSE 0 END) AS imported_7d,
      AVG(best_match_score) AS avg_match,
      MAX(last_seen_at) AS last_scan
    FROM campaign_candidates
  `).get();
  res.json(totals || {});
});

router.use(adminRouter);

// ── Inbound webhook (no auth — HMAC verified) ─────────────────────────────
// POST /api/discovery/inbound/:credential_id  — advertiser pushes offers in
router.post('/inbound/:credential_id', express.json({ limit: '2mb' }), async (req, res, next) => {
  try {
    const cred = db.prepare(`SELECT * FROM advertiser_api_credentials WHERE id = ? AND platform = 'custom'`).get(req.params.credential_id);
    if (!cred) return res.status(404).json({ error: 'webhook not configured' });

    const secret = cred.api_secret || cred.api_key || '';
    const sigHeader = req.headers['x-discovery-signature'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    if (!secret || sigHeader !== expected) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const offers = Array.isArray(req.body?.offers) ? req.body.offers : [];
    const c = registry.get('custom');
    let added = 0;
    for (const raw of offers) {
      try {
        const norm = c.normalizeOffer(raw, cred);
        if (!norm.source_offer_id) continue;
        const id = engine.upsertCandidate(norm, cred.id);
        engine.enqueueValidation(id);
        added++;
      } catch {}
    }
    res.json({ ok: true, accepted: added });
  } catch (e) { next(e); }
});

// ── Helpers ───────────────────────────────────────────────────────────────
function safeJSON(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = router;
