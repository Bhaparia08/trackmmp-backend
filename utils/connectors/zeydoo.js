/**
 * Zeydoo connector (Zeydoo SSP API — /api/cpa/ path)
 *
 * Spec source:
 *   https://api.zeydoo.com/api/cpa/docs/   (Swagger UI)
 *   https://api.zeydoo.com/api/cpa/docs/zeydoo.yaml   (raw OpenAPI 3.0)
 *
 * IMPORTANT: This is a PARTIAL integration. Zeydoo self-titles as an
 * "SSP API" (Supply-Side Platform / ad monetization), not a classic
 * CPA affiliate network. Their offer payload is sparse compared to
 * Trackier/Affise/CAKE — fields below default to placeholders that
 * MUST BE VERIFIED with Zeydoo's account manager:
 *
 *   • payout_currency  defaults to 'USD'   — API returns no currency field
 *   • payout_type      defaults to 'cpa'   — API has no payout type flag
 *   • tracking_url     null                — API does NOT return tracking links
 *   • postback macros  unknown (likely 'clickid' — common SSP convention,
 *                      VERIFY with help.zeydoo.com/en/ or Zeydoo AM)
 *
 * Once Zeydoo AM confirms the conventions, update the corresponding
 * entries in utils/macroInjection.js (if/when re-applied).
 *
 * ── Credentials ─────────────────────────────────────────────────────────
 *   api_key — Bearer token (single string). Obtained from:
 *     https://app.zeydoo.com/profile → "API Token" section
 *     after logging in to the publisher dashboard.
 *
 *   No affiliate_id, no secret, no signing — single bearer token only.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Header: `Authorization: Bearer <api_key>` on every request.
 *
 * ── Endpoints in use ────────────────────────────────────────────────────
 *   GET /balance/         — cheap authed probe (returns {total_balance, in_hold})
 *   GET /get_my_offers/   — publisher's assigned offers with rates[] per geo
 *   GET /statistics/      — daily/zone-level reporting (future revenue page)
 *
 * ── Quirks worth knowing ────────────────────────────────────────────────
 *   • NO pagination on offer endpoints — full list in one shot.
 *   • Rate limits enforced via X-RateLimit-* response headers; the
 *     numeric limit isn't documented in the spec. 429 = back off.
 *   • Two offer endpoints:
 *       /get_my_offers/  — assigned offers WITH rates[]
 *       /get_offers/     — marketplace catalog WITHOUT rates
 *     We use /get_my_offers/ because payout data is essential.
 *   • Numeric fields in /statistics/ come back as STRINGS (e.g.
 *     money: "10.50"). Not relevant to listOffers but flagged for
 *     future revenue-reconciliation code.
 *   • Offer object schema: { id, title, status, targeting:{include,exclude}, rates:[{amount, countries}] }.
 *     No advertiser, no description, no creatives, no caps.
 */
const fetch = require('node-fetch');
const { BaseConnector, normCurrency, normApprovalStatus } = require('./base');

const DEFAULT_BASE = 'https://api.zeydoo.com/api/cpa';

function readExtra(creds) {
  if (!creds || !creds.extra) return {};
  try {
    return typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra;
  } catch { return {}; }
}

function baseUrl(creds) {
  const extra = readExtra(creds);
  return (extra.base_url || DEFAULT_BASE).replace(/\/+$/, '');
}

function authHeaders(creds) {
  return { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' };
}

// Sum all rate amounts across all rate rows, then pick a representative payout.
// Strategy: take the FIRST rate row's amount as the headline. Multi-geo offers
// will surface their full rate list in `raw.rates` for downstream consumers.
function headlinePayout(rates) {
  if (!Array.isArray(rates) || rates.length === 0) return 0;
  const first = rates[0] || {};
  return Number(first.amount) || 0;
}

// Aggregate ALL countries across all rate rows + targeting.include.country.
// rates[].countries can be present even when targeting is empty, and vice versa.
function aggregateCountries(raw) {
  const set = new Set();
  if (Array.isArray(raw?.rates)) {
    for (const r of raw.rates) {
      if (Array.isArray(r?.countries)) {
        for (const c of r.countries) {
          const code = String(c || '').toUpperCase().trim();
          if (code) set.add(code);
        }
      }
    }
  }
  const include = raw?.targeting?.include?.country;
  if (Array.isArray(include)) {
    for (const c of include) {
      const code = String(c || '').toUpperCase().trim();
      if (code) set.add(code);
    }
  }
  return [...set];
}

function aggregateDevices(raw) {
  // Zeydoo targeting.device_type values include: phone, tablet, desktop, tv...
  // Map to our vocabulary (mobile|tablet|desktop).
  const out = new Set();
  const types = raw?.targeting?.include?.device_type;
  if (Array.isArray(types)) {
    for (const t of types) {
      const v = String(t || '').toLowerCase();
      if (v.includes('phone') || v.includes('mobile')) out.add('mobile');
      else if (v.includes('tablet')) out.add('tablet');
      else if (v.includes('desktop')) out.add('desktop');
    }
  }
  return [...out];
}

function aggregateOS(raw) {
  const out = new Set();
  const oses = raw?.targeting?.include?.os;
  if (Array.isArray(oses)) {
    for (const o of oses) {
      const v = String(o || '').toLowerCase();
      if (v.includes('android')) out.add('android');
      else if (v.includes('ios')) out.add('ios');
      else if (v.includes('win'))  out.add('windows');
      else if (v.includes('mac'))  out.add('macos');
      else if (v.includes('linux')) out.add('linux');
    }
  }
  return [...out];
}

function statusFromZeydoo(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'active' || v === 'public' || v === 'enabled') return 'active';
  if (v === 'paused' || v === 'inactive' || v === 'disabled') return 'paused';
  if (v === 'pending' || v === 'review') return 'pending';
  return v || 'active';
}

class ZeydooConnector extends BaseConnector {
  static platform = 'zeydoo';
  static label = 'Zeydoo (SSP — partial)';
  static capabilities = {
    list_offers:     true,
    get_offer:       false,  // no per-offer GET endpoint in spec
    get_creatives:   false,
    get_caps:        false,  // not in spec
    get_payouts:     true,
    get_performance: true,   // /statistics/ available
    push_postback:   false,  // dashboard-only per common SSP convention
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key:  { label: 'Bearer Token', help: 'https://app.zeydoo.com/profile → API Token section (Bearer token, single string)' },
    base_url: { label: 'API Base URL (optional override)', help: 'Defaults to https://api.zeydoo.com/api/cpa' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key) {
      return { ok: false, error: 'Missing api_key (Bearer token)' };
    }
    try {
      const url = `${baseUrl(creds)}/balance/`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 10_000 });
      if (r.status === 401) return { ok: false, error: 'Invalid Bearer token' };
      if (r.status === 403) return { ok: false, error: 'HTTP 403 — check Zeydoo account permissions / IP-whitelisting' };
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      // 200 — token valid. We don't validate response shape because /balance/
      // returns minimal data; presence of a 200 is sufficient.
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key) return [];
    const url = `${baseUrl(creds)}/get_my_offers/`;
    const r = await fetch(url, { headers: authHeaders(creds), timeout: 30_000 });
    if (!r.ok) throw new Error(`Zeydoo /get_my_offers/ HTTP ${r.status}`);
    const body = await r.json().catch(() => null);
    if (!body) throw new Error('Zeydoo /get_my_offers/ returned non-JSON');
    return Array.isArray(body.offers) ? body.offers : [];
  }

  // Single-offer GET isn't in the spec. Return null so the orchestrator falls
  // back to the cached normalized blob from the last listOffers run.
  static async getOffer(_creds, _externalId) { return null; }

  static normalizeOffer(raw, _creds) {
    const id = String(raw?.id ?? '');
    const payoutAmount = headlinePayout(raw?.rates);

    return {
      source_platform: 'zeydoo',
      source_offer_id: id,
      source_advertiser_id: null,  // not exposed in API

      name: raw?.title || `Offer ${id}`,
      description: null,           // not in API
      vertical: null,              // not in API

      // PARTIAL: Zeydoo doesn't return currency or payout_type fields.
      // Defaulting to USD/CPA — verify with Zeydoo AM and update if wrong.
      payout: payoutAmount,
      payout_type: 'cpa',
      payout_currency: normCurrency('USD'),  // explicit default
      revshare_percent: null,
      revenue: null,

      allowed_countries: aggregateCountries(raw),
      allowed_devices: aggregateDevices(raw),
      allowed_os: aggregateOS(raw),

      destination_url: null,           // not in API — operator copies from dashboard
      tracking_url_template: null,     // not in API
      preview_url: null,
      creatives: [],                   // not in API

      caps: {},                        // not in API

      schedule: {},

      status: statusFromZeydoo(raw?.status),
      advertiser_name: null,

      // /get_my_offers/ returns offers the publisher is approved to run.
      approval_status: normApprovalStatus('approved'),

      raw,
    };
  }
}

module.exports = ZeydooConnector;
