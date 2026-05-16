/**
 * Discovery engine — orchestrates the periodic scan across all integrated
 * networks, validates landing pages, and scores candidates against inventory.
 *
 * Mounted in server.js via setInterval. Idempotent — `source_platform +
 * source_offer_id` is the unique key, so repeated runs just upsert.
 *
 * Kill switch: set DISCOVERY_HUB_ENABLED=false in env to disable.
 */
const db = require('./../db/init');
const registry = require('./connectors');
const validator = require('./landingPageValidator');
const matcher = require('./inventoryMatcher');

// Default: 5 minutes. Override with DISCOVERY_SCAN_INTERVAL_SEC env var (in seconds).
// Production guidance: keep ≥ 300 (5 min) to avoid hammering external network APIs.
const DEFAULT_SCAN_INTERVAL_MS = (Number(process.env.DISCOVERY_SCAN_INTERVAL_SEC) || 5 * 60) * 1000;

function isEnabled() {
  return process.env.DISCOVERY_HUB_ENABLED !== 'false';   // default: enabled
}

/** Insert or update one candidate row. Returns the row id. */
function upsertCandidate(normalized, credentialId) {
  const existing = db.prepare(`
    SELECT id FROM campaign_candidates
    WHERE source_platform = ? AND source_offer_id = ?
  `).get(normalized.source_platform, normalized.source_offer_id);

  const blob = JSON.stringify(normalized);
  const raw  = normalized.raw ? JSON.stringify(normalized.raw) : null;
  const countriesJSON = JSON.stringify(normalized.allowed_countries || []);
  const devicesJSON   = JSON.stringify(normalized.allowed_devices || []);
  const osJSON        = JSON.stringify(normalized.allowed_os || []);

  if (existing) {
    db.prepare(`
      UPDATE campaign_candidates SET
        name = ?, vertical = ?, payout = ?, payout_type = ?, payout_currency = ?,
        allowed_countries = ?, allowed_devices = ?, allowed_os = ?,
        destination_url = ?, tracking_url_template = ?, preview_url = ?,
        normalized_payload = ?, raw_payload = ?,
        source_advertiser_id = ?, source_advertiser_name = ?,
        source_credential_id = ?,
        last_seen_at = unixepoch()
      WHERE id = ?
    `).run(
      normalized.name, normalized.vertical || null, normalized.payout || 0,
      normalized.payout_type || null, normalized.payout_currency || 'USD',
      countriesJSON, devicesJSON, osJSON,
      normalized.destination_url || null, normalized.tracking_url_template || null, normalized.preview_url || null,
      blob, raw,
      normalized.source_advertiser_id || null, normalized.advertiser_name || null,
      credentialId || null,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO campaign_candidates (
      source_credential_id, source_platform, source_offer_id, source_advertiser_id, source_advertiser_name,
      name, vertical, payout, payout_type, payout_currency,
      allowed_countries, allowed_devices, allowed_os,
      destination_url, tracking_url_template, preview_url,
      normalized_payload, raw_payload
    ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?)
  `).run(
    credentialId || null,
    normalized.source_platform, normalized.source_offer_id,
    normalized.source_advertiser_id || null, normalized.advertiser_name || null,
    normalized.name, normalized.vertical || null, normalized.payout || 0,
    normalized.payout_type || null, normalized.payout_currency || 'USD',
    countriesJSON, devicesJSON, osJSON,
    normalized.destination_url || null, normalized.tracking_url_template || null, normalized.preview_url || null,
    blob, raw,
  );
  return result.lastInsertRowid;
}

/** Enqueue a candidate for landing-page validation (deduped). */
function enqueueValidation(candidateId) {
  try {
    db.prepare(`
      INSERT INTO discovery_validation_queue (candidate_id, status, next_attempt_at)
      VALUES (?, 'pending', unixepoch())
    `).run(candidateId);
  } catch (e) {
    if (!String(e.message).toLowerCase().includes('unique')) throw e;
  }
}

/**
 * Process up to N pending validations from the queue.
 * Lightweight tier only — Phase 2 adds headless escalation.
 */
async function processValidationQueue(batch = 10) {
  if (!isEnabled()) return { processed: 0 };
  const rows = db.prepare(`
    SELECT q.id AS qid, q.candidate_id, q.attempt_count,
           c.destination_url, c.tracking_url_template, c.allowed_countries
    FROM discovery_validation_queue q
    JOIN campaign_candidates c ON c.id = q.candidate_id
    WHERE q.status = 'pending' AND q.next_attempt_at <= unixepoch()
    ORDER BY q.next_attempt_at ASC
    LIMIT ?
  `).all(batch);

  let processed = 0;
  for (const row of rows) {
    db.prepare("UPDATE discovery_validation_queue SET status = 'running' WHERE id = ?").run(row.qid);
    const url = row.destination_url || row.tracking_url_template;
    if (!url) {
      db.prepare("UPDATE discovery_validation_queue SET status = 'done' WHERE id = ?").run(row.qid);
      db.prepare(`UPDATE campaign_candidates SET validation_status = 'broken', validation_notes = 'no url', validation_checked_at = unixepoch() WHERE id = ?`).run(row.candidate_id);
      continue;
    }

    let countries = [];
    try { countries = JSON.parse(row.allowed_countries || '[]'); } catch {}
    const result = await validator.validate(url, { mobile: true, country: countries[0] });

    db.prepare(`
      UPDATE campaign_candidates SET
        validation_status = ?,
        validation_checked_at = unixepoch(),
        validation_final_url = ?,
        validation_http_code = ?,
        validation_redirect_chain = ?,
        validation_notes = ?
      WHERE id = ?
    `).run(
      result.status,
      result.final_url,
      result.http_code,
      JSON.stringify(result.chain || []),
      result.notes || '',
      row.candidate_id,
    );

    // Re-score against inventory now that we know the LP is OK
    if (result.status === 'valid') {
      try {
        const cand = db.prepare('SELECT normalized_payload FROM campaign_candidates WHERE id = ?').get(row.candidate_id);
        if (cand) {
          const norm = JSON.parse(cand.normalized_payload);
          const m = matcher.score(norm);
          db.prepare(`
            UPDATE campaign_candidates SET
              best_match_score = ?, best_match_inventory_id = ?, match_breakdown = ?
            WHERE id = ?
          `).run(m.score, m.best_inventory_id, JSON.stringify(m.breakdown || {}), row.candidate_id);
        }
      } catch (e) { console.error('[discovery] match scoring failed:', e.message); }
    }

    db.prepare("UPDATE discovery_validation_queue SET status = 'done' WHERE id = ?").run(row.qid);
    processed++;
  }
  return { processed };
}

/** Scan one credential. Returns { fetched, new_count, errors }. */
async function scanCredential(cred) {
  const c = registry.get(cred.platform);
  if (!c) return { fetched: 0, new_count: 0, error: `unknown platform ${cred.platform}` };
  if (!c.capabilities?.list_offers) {
    return { fetched: 0, new_count: 0, error: `${cred.platform} has no list_offers capability` };
  }

  let raw = [];
  try { raw = await c.listOffers(cred); }
  catch (e) {
    db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'error', last_sync_error = ? WHERE id = ?`)
      .run(String(e.message).slice(0, 200), cred.id);
    return { fetched: 0, new_count: 0, error: e.message };
  }

  let newCount = 0;
  for (const r of raw) {
    try {
      const normalized = c.normalizeOffer(r, cred);
      if (!normalized?.source_offer_id) continue;
      const existing = db.prepare('SELECT id FROM campaign_candidates WHERE source_platform = ? AND source_offer_id = ?')
        .get(normalized.source_platform, normalized.source_offer_id);
      const id = upsertCandidate(normalized, cred.id);
      if (!existing) { newCount++; enqueueValidation(id); }

      // Match scoring at ingest — decoupled from LP validation.
      // Some connectors (e.g. Insparx CAKE OfferFeed) don't return destination URLs,
      // so LP validation marks them 'broken' and the post-validation scoring branch
      // never fires. Scoring here ensures every candidate gets a score regardless.
      try {
        const m = matcher.score(normalized);
        db.prepare(`UPDATE campaign_candidates SET best_match_score = ?, best_match_inventory_id = ?, match_breakdown = ? WHERE id = ?`)
          .run(m.score, m.best_inventory_id, JSON.stringify(m.breakdown || {}), id);
      } catch (e) { /* scoring is best-effort; never fail the scan */ }
    } catch (e) { console.error('[discovery] normalize/upsert failed:', e.message); }
  }

  db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'ok', last_sync_error = NULL, last_offer_count = ? WHERE id = ?`)
    .run(raw.length, cred.id);

  return { fetched: raw.length, new_count: newCount };
}

/** Scan every active credential whose connector supports list_offers. */
async function scanAll() {
  if (!isEnabled()) return { skipped: true };

  let creds = [];
  try {
    creds = db.prepare(`
      SELECT * FROM advertiser_api_credentials
      WHERE COALESCE(auto_sync, 1) = 1
    `).all();
  } catch (e) {
    return { error: e.message, scanned: 0 };
  }

  const results = {};
  for (const cred of creds) {
    const c = registry.get(cred.platform);
    if (!c?.capabilities?.list_offers) continue;
    try {
      results[`${cred.platform}-${cred.id}`] = await scanCredential(cred);
    } catch (e) {
      results[`${cred.platform}-${cred.id}`] = { error: e.message };
    }
  }
  return { scanned: Object.keys(results).length, results };
}

module.exports = {
  isEnabled,
  scanAll,
  scanCredential,
  upsertCandidate,
  enqueueValidation,
  processValidationQueue,
  DEFAULT_SCAN_INTERVAL_MS,
};
