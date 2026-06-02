/**
 * Ojo7 connector (O7-API v1.0.0) — LEAD-GEN ARCHETYPE
 *
 * Spec source:
 *   https://app.swaggerhub.com/apis/Ojo7/O7-API/1.0.0
 *   https://api.swaggerhub.com/apis/Ojo7/O7-API/1.0.0/swagger.json
 *
 * IMPORTANT: Ojo7 is NOT a typical CPA/offer-feed network.
 * It is a Mexican loan lead-submission / ping-tree API.
 *
 * What this connector enables today:
 *   - Save Ojo7 credentials via /api-access
 *   - Auth-probe credentials via GET /catalog/loan_purpose
 *   - Discovery Hub correctly SKIPS Ojo7 (list_offers=false)
 *
 * What this connector does NOT enable (deferred lead-capture flow):
 *   - Publisher-facing lead-capture form widget
 *   - POST /lead and POST /lead/{id}/apply submission flow
 *   - Conversion reconciliation against Ojo7 reporting API (pending — the
 *     public spec doesn't include one; needs Ojo7 AM follow-up)
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key — X-API-KEY header value. Issued by Ojo7 account manager.
 *   base_url (top-level OR extra.base_url) — REQUIRED.
 *     Production: https://api7.ojo7.com/affiliates
 *     Staging:    https://stg-api7.ojo7.com/affiliates
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Header: `X-API-KEY: <api_key>` on every request.
 *
 * ── IP whitelisting (operational note) ───────────────────────────────────
 *   Ojo7's AWS WAF blocks unallowlisted IPs. After deploying this
 *   connector, the auth probe from Render's egress IP will return 403
 *   until you've emailed Ojo7 AM with Render's outbound IPs to add to
 *   their allowlist.
 */
const fetch = require('node-fetch');
const { BaseConnector } = require('./base');

const DEFAULT_BASE = 'https://api7.ojo7.com/affiliates';

function readExtra(creds) {
  if (!creds || !creds.extra) return {};
  try {
    return typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra;
  } catch { return {}; }
}

function baseUrl(creds) {
  const extra = readExtra(creds);
  // Accept base_url at top level (matches Affise) OR in extra.base_url (matches
  // Insparx/ClickDealer). Fall back to production default.
  const raw = creds?.base_url || extra.base_url || DEFAULT_BASE;
  return String(raw).replace(/\/+$/, '');
}

function authHeaders(creds) {
  return { 'X-API-KEY': creds.api_key, Accept: 'application/json' };
}

class Ojo7Connector extends BaseConnector {
  static platform = 'ojo7';
  static label = 'Ojo7 (MX Loans, lead-gen)';

  // Lead-gen archetype: NO list_offers, NO get_offer. Discovery Hub will
  // skip this platform automatically (scanCredential gates on
  // capabilities.list_offers).
  static capabilities = {
    list_offers:     false,   // Ojo7 has no offer feed — it's lead-submission
    get_offer:       false,
    get_creatives:   false,
    get_caps:        false,
    get_payouts:     false,
    get_performance: false,   // No reporting API in spec — needs AM follow-up
    push_postback:   false,
    webhook_inbound: false,
    // Custom lead-gen flag — not in BaseConnector capability set yet, but
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
      if (r.status === 403) {
        return { ok: false, error: 'HTTP 403 — IP not whitelisted by Ojo7. Email Ojo7 AM with your server\'s outbound IPs.' };
      }
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Intentionally returns empty array — Discovery Hub will see
  // capabilities.list_offers=false and skip Ojo7 entirely, but this guard
  // covers the case where some caller invokes it directly.
  static async listOffers(_creds, _opts = {}) {
    return [];
  }

  // No normalization — Ojo7 doesn't return offer-shaped data.
  // Throwing surfaces misuse rather than silently producing bad data.
  static normalizeOffer(_raw, _creds) {
    throw new Error('Ojo7 is a lead-gen platform — no offer normalization. Use the lead-submission flow instead.');
  }

  // Future hook for the lead-submission UI. Not wired up yet — pending
  // (a) Ojo7 reporting API endpoint, (b) publisher-facing form widget.
  static async submitLead(_creds, _leadPayload) {
    throw new Error('Ojo7 lead submission not implemented yet — pending lead-capture feature build');
  }
}

module.exports = Ojo7Connector;
