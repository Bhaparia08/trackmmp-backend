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
const currencyConverter = require('./currencyConverter');
const { toOurMacros } = require('./macroInjection');

// Currency Phase 1: compute USD equivalent for any payout in any supported
// currency. Returns { payout_usd, fx_rate_used } or nulls if conversion fails
// (e.g. RUB — not in the supported list yet). Never throws.
function toUsd(payout, currency) {
  const amount = Number(payout) || 0;
  const fromCcy = String(currency || 'USD').toUpperCase();
  if (amount === 0) return { payout_usd: 0, fx_rate_used: 1 };
  if (fromCcy === 'USD') return { payout_usd: amount, fx_rate_used: 1 };
  try {
    const rate = currencyConverter.getRate(fromCcy, 'USD');
    return { payout_usd: Math.round(amount * rate * 100) / 100, fx_rate_used: rate };
  } catch {
    return { payout_usd: null, fx_rate_used: null };
  }
}

// Default: 5 minutes. Override with DISCOVERY_SCAN_INTERVAL_SEC env var (in seconds).
// Production guidance: keep ≥ 300 (5 min) to avoid hammering external network APIs.
const DEFAULT_SCAN_INTERVAL_MS = (Number(process.env.DISCOVERY_SCAN_INTERVAL_SEC) || 5 * 60) * 1000;

function isEnabled() {
  return process.env.DISCOVERY_HUB_ENABLED !== 'false';   // default: enabled
}

// Legacy bridge: when the Discovery Hub connector is missing OR errors OR
// returns zero offers, fall back to the proven /offer-import ADAPTERS map
// in routes/integrations.js. Kill switch: DISCOVERY_HUB_BRIDGE=false.
function bridgeEnabled() {
  return process.env.DISCOVERY_HUB_BRIDGE !== 'false';   // default: enabled
}

let _legacyAdaptersCache = null;
function getLegacyAdapter(platform) {
  if (_legacyAdaptersCache === null) {
    try { _legacyAdaptersCache = require('../routes/integrations').ADAPTERS || {}; }
    catch { _legacyAdaptersCache = {}; }
  }
  return _legacyAdaptersCache[String(platform || '').toLowerCase()] || null;
}

// Convert a legacy /offer-import offer shape → Discovery Hub NormalizedOffer.
// Legacy shape:  { external_id, name, description, payout, payout_type, currency,
//                  status, tracking_url, preview_url, allowed_countries (CSV string),
//                  advertiser_name, categories, approval_status?, raw }
function legacyOfferToNormalized(o, cred) {
  const countriesStr = String(o.allowed_countries || '').trim();
  const allowed_countries = countriesStr
    ? countriesStr.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];
  return {
    source_platform: cred.platform,
    source_offer_id: String(o.external_id || ''),
    source_advertiser_id: null,
    name: o.name || 'Unnamed Offer',
    description: o.description || null,
    vertical: o.categories || null,
    payout: Number(o.payout || 0),
    payout_type: o.payout_type || 'cpa',
    payout_currency: o.currency || 'USD',
    allowed_countries,
    allowed_devices: [],
    allowed_os: [],
    destination_url: o.tracking_url || o.preview_url || null,
    tracking_url_template: o.tracking_url || null,
    preview_url: o.preview_url || null,
    status: o.status === 'active' ? 'active' : 'paused',
    advertiser_name: o.advertiser_name || null,
    approval_status: o.approval_status || 'unknown',
    raw: o.raw || o,
  };
}

/** Insert or update one candidate row. Returns the row id. */
function upsertCandidate(normalized, credentialId) {
  // B1 fix (2026-05-31): route the tracking URL through toOurMacros at the
  // single upsert chokepoint. Both the native connector path and the legacy
  // bridge path land here, so this single call covers all 13+ platforms.
  // Idempotent: re-applying on an already-translated URL is a no-op (the
  // translation table won't match its own output, and the auto-inject is
  // gated on `!includes('{click_id}')`). The legacy bridge path's URL was
  // already translated upstream — re-running here just confirms.
  // destination_url is left alone because for native connectors it carries
  // the preview/landing URL (not the tracker), where macro injection would
  // be wrong.
  if (normalized.tracking_url_template) {
    normalized.tracking_url_template = toOurMacros(
      normalized.tracking_url_template,
      normalized.source_platform,
    );
  }

  const existing = db.prepare(`
    SELECT id FROM campaign_candidates
    WHERE source_platform = ? AND source_offer_id = ?
  `).get(normalized.source_platform, normalized.source_offer_id);

  const blob = JSON.stringify(normalized);
  const raw  = normalized.raw ? JSON.stringify(normalized.raw) : null;
  const countriesJSON = JSON.stringify(normalized.allowed_countries || []);
  const devicesJSON   = JSON.stringify(normalized.allowed_devices || []);
  const osJSON        = JSON.stringify(normalized.allowed_os || []);

  // Currency Phase 1: compute USD equivalent at upsert time so /candidates can
  // sort + display in a comparable unit regardless of source currency.
  const { payout_usd, fx_rate_used } = toUsd(normalized.payout || 0, normalized.payout_currency);
  // Phase A: capture per-offer approval state for the new pending_approval bucket.
  const approvalStatus = normalized.approval_status || 'unknown';

  if (existing) {
    db.prepare(`
      UPDATE campaign_candidates SET
        name = ?, vertical = ?, payout = ?, payout_type = ?, payout_currency = ?,
        payout_usd = ?, fx_rate_used = ?,
        allowed_countries = ?, allowed_devices = ?, allowed_os = ?,
        destination_url = ?, tracking_url_template = ?, preview_url = ?,
        normalized_payload = ?, raw_payload = ?,
        source_advertiser_id = ?, source_advertiser_name = ?,
        source_credential_id = ?,
        approval_status = ?,
        last_seen_at = unixepoch()
      WHERE id = ?
    `).run(
      normalized.name, normalized.vertical || null, normalized.payout || 0,
      normalized.payout_type || null, normalized.payout_currency || 'USD',
      payout_usd, fx_rate_used,
      countriesJSON, devicesJSON, osJSON,
      normalized.destination_url || null, normalized.tracking_url_template || null, normalized.preview_url || null,
      blob, raw,
      normalized.source_advertiser_id || null, normalized.advertiser_name || null,
      credentialId || null,
      approvalStatus,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO campaign_candidates (
      source_credential_id, source_platform, source_offer_id, source_advertiser_id, source_advertiser_name,
      name, vertical, payout, payout_type, payout_currency,
      payout_usd, fx_rate_used,
      allowed_countries, allowed_devices, allowed_os,
      destination_url, tracking_url_template, preview_url,
      normalized_payload, raw_payload,
      approval_status
    ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?)
  `).run(
    credentialId || null,
    normalized.source_platform, normalized.source_offer_id,
    normalized.source_advertiser_id || null, normalized.advertiser_name || null,
    normalized.name, normalized.vertical || null, normalized.payout || 0,
    normalized.payout_type || null, normalized.payout_currency || 'USD',
    payout_usd, fx_rate_used,
    countriesJSON, devicesJSON, osJSON,
    normalized.destination_url || null, normalized.tracking_url_template || null, normalized.preview_url || null,
    blob, raw,
    approvalStatus,
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
           c.destination_url, c.tracking_url_template, c.allowed_countries, c.approval_status
    FROM discovery_validation_queue q
    JOIN campaign_candidates c ON c.id = q.candidate_id
    WHERE q.status = 'pending' AND q.next_attempt_at <= unixepoch()
    ORDER BY q.next_attempt_at ASC
    LIMIT ?
  `).all(batch);

  let processed = 0;
  for (const row of rows) {
    db.prepare("UPDATE discovery_validation_queue SET status = 'running' WHERE id = ?").run(row.qid);

    // Phase A: skip LP fetch entirely for candidates we haven't been approved on yet.
    // The URL would resolve to the network's "you don't have access" page — wastes a
    // fetch, may anger the network, and the result is meaningless to operators.
    // Mark as done so the queue moves on; the candidate's approval_status carries
    // the actionable signal to the UI.
    if (row.approval_status === 'pending') {
      db.prepare("UPDATE discovery_validation_queue SET status = 'done' WHERE id = ?").run(row.qid);
      db.prepare(`UPDATE campaign_candidates SET validation_status = 'pending_approval', validation_notes = 'awaiting approval — LP check skipped', validation_checked_at = unixepoch() WHERE id = ?`).run(row.candidate_id);
      continue;
    }

    const url = row.destination_url || row.tracking_url_template;
    if (!url) {
      db.prepare("UPDATE discovery_validation_queue SET status = 'done' WHERE id = ?").run(row.qid);
      // 'no_url' is distinct from 'broken' — we never tested anything.
      // Connectors that don't expose destination URLs in their basic feed
      // (e.g. Insparx CAKE OfferFeed) end up here. Operators see "uncheckable"
      // instead of being misled into thinking 318 offers are dead.
      db.prepare(`UPDATE campaign_candidates SET validation_status = 'no_url', validation_notes = 'no url in source feed — connector needs richer endpoint', validation_checked_at = unixepoch() WHERE id = ?`).run(row.candidate_id);
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

// Process pre-normalized candidates: upsert + enqueue validation + score.
// Shared by both the native and bridge paths so the side-effects are identical.
function ingestNormalized(normalizedList, cred) {
  let newCount = 0;
  for (const normalized of normalizedList) {
    try {
      if (!normalized?.source_offer_id) continue;
      const existing = db.prepare('SELECT id FROM campaign_candidates WHERE source_platform = ? AND source_offer_id = ?')
        .get(normalized.source_platform, normalized.source_offer_id);
      const id = upsertCandidate(normalized, cred.id);
      if (!existing) { newCount++; enqueueValidation(id); }
      try {
        const m = matcher.score(normalized);
        db.prepare(`UPDATE campaign_candidates SET best_match_score = ?, best_match_inventory_id = ?, match_breakdown = ? WHERE id = ?`)
          .run(m.score, m.best_inventory_id, JSON.stringify(m.breakdown || {}), id);
      } catch { /* scoring is best-effort; never fail the scan */ }
    } catch (e) { console.error('[discovery] normalize/upsert failed:', e.message); }
  }
  return newCount;
}

/**
 * Scan one credential. Returns { fetched, new_count, via, error? }.
 *
 * Resolution order:
 *   1. Native Discovery Hub connector (utils/connectors/*)
 *   2. Legacy /offer-import bridge (routes/integrations.js → ADAPTERS)
 *
 * The bridge fires when the native connector is missing, throws, or returns 0.
 * Kill switch: DISCOVERY_HUB_BRIDGE=false disables step 2.
 */
async function scanCredential(cred) {
  const c = registry.get(cred.platform);
  const bridgeAdapter = bridgeEnabled() ? getLegacyAdapter(cred.platform) : null;

  // ── Step 1: try native Discovery Hub connector ────────────────────────────
  let nativeRan = false;
  let nativeError = null;
  let nativeRaw = [];
  if (c?.capabilities?.list_offers) {
    nativeRan = true;
    try { nativeRaw = await c.listOffers(cred); }
    catch (e) { nativeError = e.message; nativeRaw = []; }
  }

  const shouldTryBridge = !!bridgeAdapter && (!nativeRan || nativeError || nativeRaw.length === 0);

  // ── Step 2: legacy bridge (only when needed) ──────────────────────────────
  if (shouldTryBridge) {
    let legacyOffers = [];
    let bridgeError = null;
    try { legacyOffers = await bridgeAdapter(cred); }
    catch (e) { bridgeError = e.message; }

    if (!bridgeError && legacyOffers.length > 0) {
      const normalizedList = legacyOffers.map(o => legacyOfferToNormalized(o, cred));
      const newCount = ingestNormalized(normalizedList, cred);
      const note = nativeError
        ? `via legacy bridge (native errored: ${String(nativeError).slice(0, 80)})`
        : (nativeRan ? 'via legacy bridge (native returned 0)' : 'via legacy bridge');
      db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'ok', last_sync_error = ?, last_offer_count = ? WHERE id = ?`)
        .run(note.slice(0, 200), legacyOffers.length, cred.id);
      return { fetched: legacyOffers.length, new_count: newCount, via: 'bridge' };
    }

    // Bridge errored — surface it. If native ran successfully with 0, that's
    // still "ok with 0"; we only surface the bridge error when there's nothing else.
    if (bridgeError && nativeError) {
      const combined = `native: ${nativeError} | bridge: ${bridgeError}`;
      db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'error', last_sync_error = ? WHERE id = ?`)
        .run(combined.slice(0, 200), cred.id);
      return { fetched: 0, new_count: 0, error: nativeError, bridge_error: bridgeError };
    }
    if (bridgeError && !nativeRan) {
      db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'error', last_sync_error = ? WHERE id = ?`)
        .run(String(bridgeError).slice(0, 200), cred.id);
      return { fetched: 0, new_count: 0, error: bridgeError };
    }
    // else: native ran with 0 offers, bridge also returned 0 → fall through to native success path
  }

  // ── Native success path (raw offers, native normalizer) ───────────────────
  if (nativeRan && !nativeError) {
    const normalizedList = [];
    for (const r of nativeRaw) {
      try { normalizedList.push(c.normalizeOffer(r, cred)); }
      catch (e) { console.error('[discovery] normalize failed:', e.message); }
    }
    const newCount = ingestNormalized(normalizedList, cred);
    db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'ok', last_sync_error = NULL, last_offer_count = ? WHERE id = ?`)
      .run(nativeRaw.length, cred.id);
    return { fetched: nativeRaw.length, new_count: newCount, via: 'native' };
  }

  // ── Native errored, no bridge available ───────────────────────────────────
  if (nativeError) {
    db.prepare(`UPDATE advertiser_api_credentials SET last_synced_at = unixepoch(), last_sync_status = 'error', last_sync_error = ? WHERE id = ?`)
      .run(String(nativeError).slice(0, 200), cred.id);
    return { fetched: 0, new_count: 0, error: nativeError };
  }

  // ── No path at all ────────────────────────────────────────────────────────
  return {
    fetched: 0,
    new_count: 0,
    error: c
      ? `${cred.platform} has no list_offers capability and no legacy adapter`
      : `unknown platform ${cred.platform}`,
  };
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
    const hasNative = !!c?.capabilities?.list_offers;
    const hasBridge = bridgeEnabled() && !!getLegacyAdapter(cred.platform);
    if (!hasNative && !hasBridge) continue;   // truly no way to fetch this platform's offers
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
