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
      row.mapped_vertical || norm.vertical || row.vertical || null,
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

// ── Phase 3a: Review Queue endpoints ──────────────────────────────────────

// PATCH /api/discovery/candidates/:id/vertical — remap vertical (single)
adminRouter.patch('/candidates/:id/vertical', (req, res) => {
  const v = (req.body?.mapped_vertical || '').trim().slice(0, 80) || null;
  const r = db.prepare('UPDATE campaign_candidates SET mapped_vertical = ? WHERE id = ?')
    .run(v, req.params.id);
  res.json({ ok: r.changes > 0, mapped_vertical: v });
});

// POST /api/discovery/candidates/bulk-import — approve N at once, optional vertical remap
adminRouter.post('/candidates/bulk-import', (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.candidate_ids) ? req.body.candidate_ids.map(Number).filter(Number.isInteger) : [];
    const mappedVertical = (req.body?.mapped_vertical || '').trim().slice(0, 80) || null;
    if (ids.length === 0) return res.status(400).json({ error: 'candidate_ids array required' });
    if (ids.length > 200) return res.status(400).json({ error: 'max 200 per call' });

    const results = { imported: [], skipped: [], failed: [] };
    const importOne = db.transaction((id) => {
      const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(id);
      if (!row) { results.skipped.push({ id, reason: 'not found' }); return; }
      if (row.import_status === 'imported') { results.skipped.push({ id, reason: 'already imported', campaign_id: row.imported_campaign_id }); return; }
      if (mappedVertical) {
        db.prepare('UPDATE campaign_candidates SET mapped_vertical = ? WHERE id = ?').run(mappedVertical, id);
        row.mapped_vertical = mappedVertical;
      }
      const norm = safeJSON(row.normalized_payload, {});
      const tok = crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
      const rs = db.prepare(`
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
        row.payout || 0,
        norm.payout_type || row.payout_type || 'cpa',
        row.payout || 0,
        norm.payout_type || row.payout_type || 'cpa',
        (norm.allowed_countries || []).join(','),
        norm.destination_url || row.destination_url || '',
        norm.preview_url || row.preview_url || '',
        tok,
        row.mapped_vertical || norm.vertical || row.vertical || null,
        `discovery,${norm.source_platform || row.source_platform}`,
      );
      const campaignId = rs.lastInsertRowid;
      db.prepare(`
        UPDATE campaign_candidates SET
          import_status = 'imported', imported_campaign_id = ?,
          reviewed_by = ?, reviewed_at = unixepoch()
        WHERE id = ?
      `).run(campaignId, req.user.id, id);
      if (row.best_match_inventory_id) {
        try {
          db.prepare(`INSERT OR IGNORE INTO campaign_inventory_approvals (campaign_id, inventory_id, status, priority, weight) VALUES (?, ?, 'approved', 0, 1)`)
            .run(campaignId, row.best_match_inventory_id);
        } catch {}
      }
      results.imported.push({ id, campaign_id: campaignId });
    });
    for (const id of ids) {
      try { importOne(id); }
      catch (e) { results.failed.push({ id, error: e.message }); }
    }
    res.json({ ok: true, total: ids.length, ...results, counts: { imported: results.imported.length, skipped: results.skipped.length, failed: results.failed.length } });
  } catch (e) { next(e); }
});

// POST /api/discovery/candidates/bulk-reject — reject N at once
adminRouter.post('/candidates/bulk-reject', (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.candidate_ids) ? req.body.candidate_ids.map(Number).filter(Number.isInteger) : [];
    const reason = (req.body?.reason || '').slice(0, 500);
    if (ids.length === 0) return res.status(400).json({ error: 'candidate_ids array required' });
    if (ids.length > 500) return res.status(400).json({ error: 'max 500 per call' });
    const ph = ids.map(() => '?').join(',');
    const r = db.prepare(`
      UPDATE campaign_candidates SET
        import_status = 'rejected', rejection_reason = ?,
        reviewed_by = ?, reviewed_at = unixepoch()
      WHERE id IN (${ph}) AND import_status NOT IN ('imported')
    `).run(reason, req.user.id, ...ids);
    res.json({ ok: true, rejected: r.changes, requested: ids.length });
  } catch (e) { next(e); }
});

// GET /api/discovery/queue/next — fetch next candidate(s) for the review queue
// Smart sort: valid LP first, then by best_match_score DESC, then by first_seen_at ASC.
// Optional filters: ?source_platform=…&vertical=…&min_match_score=…&limit=20
adminRouter.get('/queue/next', (req, res) => {
  const { source_platform, vertical, min_match_score } = req.query;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const conds = [`import_status IN ('new','reviewing')`];
  const params = [];
  if (source_platform) { conds.push('source_platform = ?'); params.push(source_platform); }
  if (vertical) { conds.push('LOWER(COALESCE(mapped_vertical, vertical, "")) = ?'); params.push(String(vertical).toLowerCase()); }
  if (min_match_score) { conds.push('COALESCE(best_match_score, 0) >= ?'); params.push(Number(min_match_score)); }

  const where = 'WHERE ' + conds.join(' AND ');
  const remainingTotal = db.prepare(`SELECT COUNT(*) AS n FROM campaign_candidates ${where}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, source_platform, source_offer_id, source_advertiser_name,
           name, vertical, mapped_vertical, payout, payout_type, payout_currency,
           allowed_countries, allowed_devices,
           destination_url, preview_url,
           validation_status, validation_final_url, validation_http_code, validation_notes,
           best_match_score, best_match_inventory_id, match_breakdown,
           first_seen_at
    FROM campaign_candidates
    ${where}
    ORDER BY
      CASE validation_status
        WHEN 'valid' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'parked' THEN 2
        ELSE 3
      END,
      COALESCE(best_match_score, 0) DESC,
      first_seen_at ASC
    LIMIT ?
  `).all(...params, limit);
  res.json({
    data: rows.map(r => ({
      ...r,
      allowed_countries: safeJSON(r.allowed_countries, []),
      allowed_devices:   safeJSON(r.allowed_devices, []),
      match_breakdown:   safeJSON(r.match_breakdown, {}),
    })),
    remaining_total: remainingTotal,
    returned: rows.length,
  });
});

// GET /api/discovery/queue/verticals — distinct verticals seen across candidates
// Used by the Review Queue to populate the "remap to" dropdown
adminRouter.get('/queue/verticals', (_req, res) => {
  const fromCandidates = db.prepare(`
    SELECT DISTINCT vertical AS v FROM campaign_candidates WHERE vertical IS NOT NULL AND vertical != ''
    UNION
    SELECT DISTINCT mapped_vertical AS v FROM campaign_candidates WHERE mapped_vertical IS NOT NULL AND mapped_vertical != ''
  `).all().map(r => r.v).filter(Boolean);
  let fromInventory = [];
  try {
    fromInventory = db.prepare(`SELECT DISTINCT vertical AS v FROM owned_inventory WHERE vertical IS NOT NULL AND vertical != ''`).all().map(r => r.v);
  } catch {}
  const all = Array.from(new Set([...fromCandidates, ...fromInventory])).sort();
  res.json({ verticals: all, from_inventory: fromInventory });
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

// ───────────────────────────────────────────────────────────────────────────
// Bulk operations — review-queue UX needs to act on 50-500 candidates at once.
// Per-row endpoints already exist; this is the bulk surface.
//
// POST /api/discovery/candidates/bulk
//   { action: 'reject'|'import'|'revalidate'|'remap_vertical'|'rescore',
//     ids: [int], ...action-specific params }
// ───────────────────────────────────────────────────────────────────────────
adminRouter.post('/candidates/bulk', async (req, res, next) => {
  try {
    const { action, ids, ...params } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action required' });
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids[] required' });
    if (ids.length > 1000) return res.status(400).json({ error: 'bulk size capped at 1000' });

    const cleanIds = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (cleanIds.length === 0) return res.status(400).json({ error: 'no valid ids' });

    const handler = BULK_HANDLERS[action];
    if (!handler) return res.status(400).json({ error: `unknown action: ${action}. Valid: ${Object.keys(BULK_HANDLERS).join(', ')}` });

    const failed = [];
    let succeeded = 0;
    const auditStmt = db.prepare(`
      INSERT INTO discovery_bulk_audit (actor_id, action, candidate_id, before_state, after_state, result)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const id of cleanIds) {
      try {
        const result = await handler(id, params, req);
        if (result && result.skipped) {
          failed.push({ id, error: result.skipped });
          continue;
        }
        auditStmt.run(req.user.id, action, id,
                      JSON.stringify(result?.before || null),
                      JSON.stringify(result?.after  || null), 'ok');
        succeeded++;
      } catch (e) {
        failed.push({ id, error: e.message });
        try { auditStmt.run(req.user.id, action, id, null, null, e.message.slice(0, 200)); } catch {}
      }
    }
    res.json({ ok: true, action, processed: cleanIds.length, succeeded, failed });
  } catch (err) { next(err); }
});

// Each handler returns { before, after } on success, or { skipped: reason } to soft-skip.
const BULK_HANDLERS = {
  reject(id, params, req) {
    const row = db.prepare('SELECT import_status FROM campaign_candidates WHERE id = ?').get(id);
    if (!row) return { skipped: 'not found' };
    if (row.import_status === 'imported') return { skipped: 'already imported — cannot reject' };
    const reason = String(params.reason || '').slice(0, 500);
    db.prepare(`
      UPDATE campaign_candidates SET
        import_status = 'rejected', rejection_reason = ?,
        reviewed_by = ?, reviewed_at = unixepoch()
      WHERE id = ?
    `).run(reason, req.user.id, id);
    return { before: { import_status: row.import_status }, after: { import_status: 'rejected', reason } };
  },

  import(id, params, req) {
    const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(id);
    if (!row) return { skipped: 'not found' };
    if (row.import_status === 'imported') return { skipped: 'already imported' };

    const norm = safeJSON(row.normalized_payload, {});
    const inventoryId = params.inventory_id || row.best_match_inventory_id || null;
    const payout = Number(params.payout) || row.payout || 0;
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
      payout,
      norm.payout_type || row.payout_type || 'cpa',
      payout,
      norm.payout_type || row.payout_type || 'cpa',
      (norm.allowed_countries || []).join(','),
      norm.destination_url || row.destination_url || '',
      norm.preview_url || row.preview_url || '',
      tok,
      row.mapped_vertical || norm.vertical || row.vertical || null,
      `discovery,${norm.source_platform || row.source_platform}`,
    );
    const campaignId = result.lastInsertRowid;

    db.prepare(`
      UPDATE campaign_candidates SET
        import_status = 'imported', imported_campaign_id = ?,
        reviewed_by = ?, reviewed_at = unixepoch()
      WHERE id = ?
    `).run(campaignId, req.user.id, id);

    if (inventoryId && params.auto_deploy !== false) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO campaign_inventory_approvals
            (user_id, campaign_id, inventory_id, status, priority, weight)
          VALUES (?, ?, ?, 'approved', 0, 1)
        `).run(req.user.id, campaignId, inventoryId);
      } catch {}
    }

    return { before: { import_status: row.import_status },
             after:  { import_status: 'imported', campaign_id: campaignId, inventory_id: inventoryId } };
  },

  async revalidate(id, _params, _req) {
    const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(id);
    if (!row) return { skipped: 'not found' };
    const url = row.destination_url || row.tracking_url_template;
    if (!url) return { skipped: 'no URL to validate' };

    let countries = []; try { countries = JSON.parse(row.allowed_countries || '[]'); } catch {}
    const result = await validator.validate(url, { mobile: true, country: countries[0] });
    db.prepare(`
      UPDATE campaign_candidates SET
        validation_status = ?, validation_checked_at = unixepoch(),
        validation_final_url = ?, validation_http_code = ?,
        validation_redirect_chain = ?, validation_notes = ?
      WHERE id = ?
    `).run(result.status, result.final_url, result.http_code,
      JSON.stringify(result.chain || []), result.notes || '', id);
    return { before: { validation_status: row.validation_status },
             after:  { validation_status: result.status, http_code: result.http_code } };
  },

  remap_vertical(id, params, _req) {
    const mapped = String(params.mapped_vertical || '').trim();
    if (!mapped) return { skipped: 'mapped_vertical required' };
    const row = db.prepare('SELECT vertical, mapped_vertical FROM campaign_candidates WHERE id = ?').get(id);
    if (!row) return { skipped: 'not found' };
    db.prepare(`UPDATE campaign_candidates SET mapped_vertical = ? WHERE id = ?`).run(mapped, id);
    return { before: { mapped_vertical: row.mapped_vertical }, after: { mapped_vertical: mapped } };
  },

  rescore(id, _params, _req) {
    const row = db.prepare('SELECT * FROM campaign_candidates WHERE id = ?').get(id);
    if (!row) return { skipped: 'not found' };
    const norm = safeJSON(row.normalized_payload, {});
    const norm2 = { ...norm, vertical: row.mapped_vertical || norm.vertical || row.vertical };
    const m = matcher.score(norm2);
    db.prepare(`
      UPDATE campaign_candidates SET
        best_match_score = ?, best_match_inventory_id = ?, match_breakdown = ?
      WHERE id = ?
    `).run(m.score, m.best_inventory_id, JSON.stringify(m.breakdown || {}), id);
    return { before: { score: row.best_match_score },
             after:  { score: m.score, inventory_id: m.best_inventory_id } };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Helper endpoints for the review-queue UI
// ───────────────────────────────────────────────────────────────────────────

// GET /api/discovery/verticals — distinct source verticals + their alias mapping
adminRouter.get('/verticals', (_req, res) => {
  const aliases = db.prepare(`SELECT * FROM vertical_aliases ORDER BY source_vertical`).all();
  const aliasMap = Object.fromEntries(aliases.map(a => [a.source_vertical.toLowerCase(), a.mapped_vertical]));

  const sourceVerticals = db.prepare(`
    SELECT vertical AS source_vertical, COUNT(*) AS candidate_count,
           SUM(CASE WHEN import_status = 'new' THEN 1 ELSE 0 END) AS unreviewed
    FROM campaign_candidates
    WHERE vertical IS NOT NULL AND vertical != ''
    GROUP BY vertical
    ORDER BY candidate_count DESC
  `).all();

  res.json({
    source_verticals: sourceVerticals.map(v => ({
      ...v,
      mapped_to: aliasMap[v.source_vertical.toLowerCase()] || null,
    })),
    aliases,
  });
});

// POST /api/discovery/vertical-aliases — upsert a mapping
adminRouter.post('/vertical-aliases', (req, res) => {
  const { source_vertical, mapped_vertical, notes } = req.body || {};
  if (!source_vertical || !mapped_vertical) {
    return res.status(400).json({ error: 'source_vertical and mapped_vertical required' });
  }
  db.prepare(`
    INSERT INTO vertical_aliases (source_vertical, mapped_vertical, notes, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_vertical) DO UPDATE SET
      mapped_vertical = excluded.mapped_vertical,
      notes = excluded.notes,
      updated_at = unixepoch()
  `).run(String(source_vertical).trim(), String(mapped_vertical).trim(), notes || null, req.user.id);
  const row = db.prepare(`SELECT * FROM vertical_aliases WHERE source_vertical = ?`).get(String(source_vertical).trim());
  res.json({ ok: true, alias: row });
});

// DELETE /api/discovery/vertical-aliases/:id
adminRouter.delete('/vertical-aliases/:id', (req, res) => {
  const r = db.prepare(`DELETE FROM vertical_aliases WHERE id = ?`).run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

// GET /api/discovery/candidates-grouped?by=advertiser|platform|vertical|validation
// Path uses a dash (not /grouped) to avoid being swallowed by the /:id route.
adminRouter.get('/candidates-grouped', (req, res) => {
  const by = req.query.by || 'advertiser';
  const colMap = {
    advertiser:  "COALESCE(source_advertiser_name, source_advertiser_id, '(unknown)')",
    platform:    'source_platform',
    vertical:    "COALESCE(mapped_vertical, vertical, '(none)')",
    validation:  'validation_status',
  };
  const col = colMap[by];
  if (!col) return res.status(400).json({ error: `by must be one of: ${Object.keys(colMap).join(', ')}` });

  const rows = db.prepare(`
    SELECT ${col} AS bucket, COUNT(*) AS total,
           SUM(CASE WHEN import_status = 'new'      THEN 1 ELSE 0 END) AS new_count,
           SUM(CASE WHEN import_status = 'imported' THEN 1 ELSE 0 END) AS imported_count,
           SUM(CASE WHEN import_status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
           SUM(CASE WHEN validation_status = 'valid'  THEN 1 ELSE 0 END) AS lp_valid,
           SUM(CASE WHEN validation_status = 'broken' THEN 1 ELSE 0 END) AS lp_broken,
           AVG(payout) AS avg_payout,
           AVG(best_match_score) AS avg_match,
           MAX(last_seen_at) AS last_seen
    FROM campaign_candidates
    GROUP BY bucket
    ORDER BY total DESC
  `).all();
  res.json({ grouped_by: by, buckets: rows });
});

// ───────────────────────────────────────────────────────────────────────────
// Auto-import rules — when a candidate matches ALL conditions in an enabled
// rule, the rule's action runs automatically on every scan (or via /apply).
// ───────────────────────────────────────────────────────────────────────────

// GET /api/discovery/auto-import-rules
adminRouter.get('/auto-import-rules', (_req, res) => {
  const rows = db.prepare(`SELECT * FROM auto_import_rules ORDER BY priority ASC, id ASC`).all();
  res.json({ rules: rows.map(r => ({
    ...r,
    conditions: safeJSON(r.conditions, {}),
    actions:    safeJSON(r.actions, {}),
  })) });
});

// POST /api/discovery/auto-import-rules
adminRouter.post('/auto-import-rules', (req, res) => {
  const { name, enabled = 1, priority = 100, conditions, actions } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!conditions || typeof conditions !== 'object') return res.status(400).json({ error: 'conditions must be an object' });
  if (!actions    || typeof actions    !== 'object') return res.status(400).json({ error: 'actions must be an object' });

  const r = db.prepare(`
    INSERT INTO auto_import_rules (name, enabled, priority, conditions, actions, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, enabled ? 1 : 0, Number(priority) || 100,
          JSON.stringify(conditions), JSON.stringify(actions), req.user.id);
  const row = db.prepare(`SELECT * FROM auto_import_rules WHERE id = ?`).get(r.lastInsertRowid);
  res.status(201).json({ ok: true, rule: { ...row, conditions, actions } });
});

// PUT /api/discovery/auto-import-rules/:id
adminRouter.put('/auto-import-rules/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM auto_import_rules WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.name      !== undefined) { sets.push('name = ?');     vals.push(String(b.name)); }
  if (b.enabled   !== undefined) { sets.push('enabled = ?');  vals.push(b.enabled ? 1 : 0); }
  if (b.priority  !== undefined) { sets.push('priority = ?'); vals.push(Number(b.priority) || 100); }
  if (b.conditions !== undefined) {
    if (typeof b.conditions !== 'object') return res.status(400).json({ error: 'conditions must be an object' });
    sets.push('conditions = ?'); vals.push(JSON.stringify(b.conditions));
  }
  if (b.actions !== undefined) {
    if (typeof b.actions !== 'object') return res.status(400).json({ error: 'actions must be an object' });
    sets.push('actions = ?'); vals.push(JSON.stringify(b.actions));
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' });
  sets.push('updated_at = unixepoch()');
  db.prepare(`UPDATE auto_import_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
  const updated = db.prepare(`SELECT * FROM auto_import_rules WHERE id = ?`).get(row.id);
  res.json({ ok: true, rule: { ...updated, conditions: safeJSON(updated.conditions, {}), actions: safeJSON(updated.actions, {}) } });
});

// DELETE /api/discovery/auto-import-rules/:id
adminRouter.delete('/auto-import-rules/:id', (req, res) => {
  const r = db.prepare(`DELETE FROM auto_import_rules WHERE id = ?`).run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

// POST /api/discovery/auto-import-rules/:id/apply
// Run a rule across all current candidates (one-shot apply).  Returns
// { matched, imported, errors }.  Same logic as the background runner,
// just triggered on demand.
adminRouter.post('/auto-import-rules/:id/apply', async (req, res, next) => {
  try {
    const rule = db.prepare(`SELECT * FROM auto_import_rules WHERE id = ?`).get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not found' });
    const result = await applyAutoImportRule(rule, req.user.id);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// POST /api/discovery/auto-import-rules/apply-all  — fire every enabled rule
adminRouter.post('/auto-import-rules/apply-all', async (req, res, next) => {
  try {
    const rules = db.prepare(`SELECT * FROM auto_import_rules WHERE enabled = 1 ORDER BY priority ASC`).all();
    const per = [];
    for (const r of rules) {
      const out = await applyAutoImportRule(r, req.user.id);
      per.push({ rule_id: r.id, name: r.name, ...out });
    }
    res.json({ ok: true, rules_applied: per.length, details: per });
  } catch (e) { next(e); }
});

// Internal — apply one rule to current candidate set
async function applyAutoImportRule(rule, actorId) {
  const cond = safeJSON(rule.conditions, {});
  const act  = safeJSON(rule.actions, {});

  const whereParts = ["import_status = 'new'"];
  const params = [];
  if (cond.min_match_score    !== undefined) { whereParts.push('COALESCE(best_match_score, 0) >= ?');  params.push(Number(cond.min_match_score)); }
  if (cond.min_payout         !== undefined) { whereParts.push('COALESCE(payout, 0) >= ?');             params.push(Number(cond.min_payout)); }
  if (cond.max_payout         !== undefined) { whereParts.push('COALESCE(payout, 0) <= ?');             params.push(Number(cond.max_payout)); }
  if (cond.validation_status)               { whereParts.push('validation_status = ?');                params.push(cond.validation_status); }
  if (cond.source_platform)                 { whereParts.push('source_platform = ?');                  params.push(cond.source_platform); }
  if (cond.vertical)                        { whereParts.push('(LOWER(COALESCE(mapped_vertical, vertical)) = ?)'); params.push(String(cond.vertical).toLowerCase()); }
  if (cond.allowed_country)                 { whereParts.push("INSTR(UPPER(allowed_countries), ?) > 0"); params.push(String(cond.allowed_country).toUpperCase()); }

  const matched = db.prepare(`SELECT * FROM campaign_candidates WHERE ${whereParts.join(' AND ')}`).all(...params);
  let imported = 0; const errors = [];

  const auditStmt = db.prepare(`
    INSERT INTO discovery_bulk_audit (actor_id, rule_id, action, candidate_id, after_state, result)
    VALUES (?, ?, 'auto_import', ?, ?, ?)
  `);

  for (const row of matched) {
    try {
      const norm = safeJSON(row.normalized_payload, {});
      const tok = crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
      const pubPayout = act.set_publisher_payout != null ? Number(act.set_publisher_payout) : (row.payout || 0);
      const payoutType = act.override_payout_type || norm.payout_type || row.payout_type || 'cpa';

      const r = db.prepare(`
        INSERT INTO campaigns (
          user_id, name, advertiser_name,
          payout, payout_type, publisher_payout, publisher_payout_type,
          allowed_countries, destination_url, preview_url,
          campaign_token, status, visibility, vertical, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'open', ?, ?)
      `).run(
        actorId,
        norm.name || row.name,
        norm.advertiser_name || row.source_advertiser_name || '',
        row.payout || 0, payoutType, pubPayout, payoutType,
        (norm.allowed_countries || []).join(','),
        norm.destination_url || row.destination_url || '',
        norm.preview_url || row.preview_url || '',
        tok,
        row.mapped_vertical || norm.vertical || row.vertical || null,
        `discovery,auto-rule:${rule.id},${norm.source_platform || row.source_platform}`,
      );
      const campaignId = r.lastInsertRowid;

      db.prepare(`
        UPDATE campaign_candidates SET
          import_status = 'imported', imported_campaign_id = ?,
          reviewed_by = ?, reviewed_at = unixepoch()
        WHERE id = ?
      `).run(campaignId, actorId, row.id);

      if (act.auto_deploy_to_inventory && row.best_match_inventory_id) {
        try {
          db.prepare(`
            INSERT OR IGNORE INTO campaign_inventory_approvals
              (user_id, campaign_id, inventory_id, status, priority, weight)
            VALUES (?, ?, ?, 'approved', 0, 1)
          `).run(actorId, campaignId, row.best_match_inventory_id);
        } catch {}
      }

      auditStmt.run(actorId, rule.id, row.id,
                    JSON.stringify({ campaign_id: campaignId, inventory_id: row.best_match_inventory_id }), 'ok');
      imported++;
    } catch (e) {
      errors.push({ candidate_id: row.id, error: e.message });
      try { auditStmt.run(actorId, rule.id, row.id, null, e.message.slice(0, 200)); } catch {}
    }
  }

  db.prepare(`
    UPDATE auto_import_rules SET matched_count = matched_count + ?, last_matched_at = unixepoch(), updated_at = unixepoch()
    WHERE id = ?
  `).run(matched.length, rule.id);

  return { matched_count: matched.length, imported, errors };
}

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
