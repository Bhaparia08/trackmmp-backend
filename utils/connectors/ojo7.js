/**
 * Ojo7 connector (O7-API v1.0.0)  — LEAD-GEN ARCHETYPE
 *
 * Spec source:
 *   https://app.swaggerhub.com/apis/Ojo7/O7-API/1.0.0
 *   https://api.swaggerhub.com/apis/Ojo7/O7-API/1.0.0/swagger.json
 *
 * IMPORTANT: Ojo7 is NOT a typical CPA/offer-feed network.
 * It is a Mexican loan **lead-submission / ping-tree API**.
 *
 * What the API exposes:
 *   POST /lead              — submit a ping (email, phone, loan amount)
 *   POST /lead/{id}/apply   — convert lead with full personal-info (CLABE, SEPOMEX...)
 *   GET  /catalog/*         — enum dropdowns (employment_status, loan_purpose, ...)
 *
 * What the API does NOT expose (deliberate gaps documented for clarity):
 *   • No offer list — you don't pull an offer catalogue from Ojo7
 *   • No conversions/reports endpoint — you can't reconcile approved/funded
 *     loans against submitted leads via this spec (must request from AM)
 *   • No postback configuration endpoint
 *
 * Why this connector is a stub:
 *   This file registers Ojo7 in the platform registry so credentials can be
 *   saved + auth-probed via the standard UI. listOffers is deliberately
 *   disabled (capabilities.list_offers = false). The full lead-submission
 *   flow is a separate feature build (UI lead-capture form, new DB schema
 *   for lead_status, reconciliation job) that requires the missing pieces
 *   from Ojo7 above.
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key — X-API-KEY header. Issued by Ojo7 account manager.
 *             (No public registration flow documented.)
 *
 *   No affiliate_id or network_id needed.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Header: `X-API-KEY: <api_key>` on every request.
 *
 * ── Base URLs ───────────────────────────────────────────────────────────
 *   Staging:    https://stg-api7.ojo7.com/affiliates
 *   Production: https://api7.ojo7.com/affiliates
 *
 *   Operators can override via extra.base_url. Defaults to production.
 *
 * ── Auth probe ──────────────────────────────────────────────────────────
 *   GET /catalog/loan_purpose — cheapest authed endpoint. Returns a small
 *   array of dropdown options. 200 = key valid. 401 = key invalid.
 */
const fetch = require('node-fetch');
const { BaseConnector } = require('./base');

const DEFAULT_BASE = 'https://api7.ojo7.com/affiliates';

function baseUrl(creds) {
  try {
    const extra = creds.extra
      ? (typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra)
      : {};
    return (extra.base_url || DEFAULT_BASE).replace(/\/+$/, '');
  } catch { return DEFAULT_BASE; }
}

function authHeaders(creds) {
  return { 'X-API-KEY': creds.api_key, Accept: 'application/json' };
}

class Ojo7Connector extends BaseConnector {
  static platform = 'ojo7';
  static label = 'Ojo7 (MX Loans, lead-gen)';

  // Lead-gen archetype: NO list_offers, NO get_offer. Discovery Hub will
  // skip this platform automatically (scanCredential gates on
  // capabilities.list_offers). The audit-platforms script needs an
  // exemption for lead-gen platforms — added separately.
  static capabilities = {
    list_offers:     false,   // Ojo7 has no offer feed
    get_offer:       false,
    get_creatives:   false,
    get_caps:        false,
    get_payouts:     false,
    get_performance: false,   // No reporting API in spec — needs AM follow-up
    push_postback:   false,
    webhook_inbound: false,
    // Custom lead-gen flag — not in the base capability set yet, but
    // future code (the lead-submission UI) can branch on this.
    lead_submit:     true,
  };

  static credentialHints = {
    api_key:  { label: 'X-API-KEY',     help: 'Issued by your Ojo7 account manager (no public registration)' },
    base_url: { label: 'API Base URL',  help: 'Production: https://api7.ojo7.com/affiliates · Staging: https://stg-api7.ojo7.com/affiliates' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key) {
      return { ok: false, error: 'Missing api_key (X-API-KEY header)' };
    }
    try {
      const url = `${baseUrl(creds)}/catalog/loan_purpose`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 10_000 });
      if (r.status === 401) return { ok: false, error: 'Invalid X-API-KEY' };
      if (!r.ok)            return { ok: false, error: `HTTP ${r.status}` };
      // 200 — key is valid. We don't validate the response body shape
      // because the catalog endpoints aren't documented in detail.
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Intentionally returns empty array. Discovery Hub will see
  // capabilities.list_offers=false and skip Ojo7 entirely, but this guard
  // covers the case where some future caller invokes it directly.
  static async listOffers(_creds, _opts = {}) {
    return [];
  }

  // No normalization — Ojo7 doesn't return offer-shaped data.
  // Throwing surfaces misuse rather than silently producing bad data.
  static normalizeOffer(_raw, _creds) {
    throw new Error('Ojo7 is a lead-gen platform — no offer normalization. Use the lead-submission flow instead.');
  }

  // Future hook for the lead-submission UI to call. Not wired up yet.
  static async submitLead(_creds, _leadPayload) {
    throw new Error('Ojo7 lead submission not implemented yet — pending API key + reporting API from Ojo7 AM');
  }
}

module.exports = Ojo7Connector;
