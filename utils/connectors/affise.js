/**
 * Affise connector (Affiliate API 3.1)
 *
 * Doc sources:
 *   https://api-demo.affise.com/docs3.1/#affiliate-methods
 *   https://help-center.affise.com/en/articles/6790524-api-3-1-documentation-overview-affiliates
 *   https://help-center.affise.com/en/articles/6790455-start-with-api-affiliates
 *   https://help-center.affise.com/en/articles/6655842-affiliate-postback-macros-affiliates
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key  — Affiliate panel → Settings → Security
 *   base_url — Affiliate panel → Settings → Tracking domains → API URL.
 *              Example: https://api-rocketcompany.affise.com
 *              REQUIRED. Each Affise network runs on its own subdomain
 *              (api-<network>.affise.com or a custom CNAME).
 *
 *   No api_secret, no affiliate_id needed — the api_key is scoped to the
 *   single partner account on the network.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Header: `API-Key: <api_key>` (canonical casing per docs).
 *   Affise also accepts `?api-key=` query but we use the header.
 *
 * ── Endpoints in use ────────────────────────────────────────────────────
 *   GET /3.0/partner/offers
 *     ?page=N&limit=500       — paginated; partner can see only offers
 *                               they're connected to (already approved).
 *   GET /3.0/partner/offer/{offer_id}
 *
 *   Note: paths use /3.0/ even though the API line is branded "3.1".
 *
 * ── Quirks worth knowing ────────────────────────────────────────────────
 *   • Field is `payments[]` (NOT `payouts[]`); per-row amount is `revenue`
 *     (NOT `payout`).
 *   • Two IDs per offer: numeric `id` AND string `offer_id` (Mongo ObjectId).
 *     We use `offer_id` as the external_id since it's the stable public
 *     identifier used everywhere else (tracking links, postbacks, UI).
 *   • `description_lang` is a {lang: text} object, not a single string.
 *   • Country-filtered listing also returns globally-targeted offers,
 *     so the normalizer should re-derive allowed_countries from
 *     `payments[].countries`, not just trust the query filter.
 *   • There is NO `{click_id}` macro on Affise — convention is to pass
 *     the click ID as `{sub1}`. The frontend postback wizard reflects this.
 *   • `cps` = revshare (percent), same semantics as TUNE/Trackier.
 *   • Rate limits are not publicly documented — Affise reserves the right
 *     to throttle per network. We pace 200ms between page fetches.
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const PAGE_LIMIT = 500;
const RATE_LIMIT_MS = 200;

function baseUrl(creds) {
  // base_url is REQUIRED for Affise — there is no shared host.
  const raw = (creds.base_url || '').trim();
  if (!raw) throw new Error('Affise requires base_url (e.g. https://api-<network>.affise.com)');
  return raw.replace(/\/+$/, '');
}

function authHeaders(creds) {
  return { 'API-Key': creds.api_key, Accept: 'application/json' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Affise revenue_type enum: cpa | cpi | cpl | cps | cpc | revshare
function payoutTypeFromAffise(t) {
  const v = String(t || '').toLowerCase();
  if (v === 'cps') return 'revshare';
  if (['cpi', 'cpa', 'cpl', 'cpc', 'cpm', 'revshare'].includes(v)) return v;
  return 'cpa';
}

// Pick the most representative payment row. Strategy: prefer the row with
// the most countries listed (usually the "default" row), else the first.
function pickHeadlinePayment(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;
  return payments.reduce((best, p) => {
    const bestLen = best?.countries?.length || 0;
    const pLen = p?.countries?.length || 0;
    return pLen > bestLen ? p : best;
  }, payments[0]);
}

function descriptionFrom(raw) {
  if (raw.description) return String(raw.description);
  const langs = raw.description_lang;
  if (langs && typeof langs === 'object') {
    return langs.en || langs.es || langs.pt || langs.ru || langs.cn ||
           Object.values(langs).find(v => typeof v === 'string') || null;
  }
  return null;
}

// Derive allowed_countries from the union of all payment rows, not the
// listing filter — see quirks note above.
function allowedCountriesFrom(payments) {
  if (!Array.isArray(payments)) return [];
  const set = new Set();
  for (const p of payments) {
    if (Array.isArray(p?.countries)) p.countries.forEach(c => set.add(String(c).toUpperCase()));
  }
  return [...set];
}

function devicesFromPayments(payments) {
  if (!Array.isArray(payments)) return [];
  const set = new Set();
  for (const p of payments) {
    if (Array.isArray(p?.devices)) p.devices.forEach(d => set.add(String(d).toLowerCase()));
  }
  return [...set];
}

function osFromPayments(payments) {
  if (!Array.isArray(payments)) return [];
  const set = new Set();
  for (const p of payments) {
    if (Array.isArray(p?.os)) p.os.forEach(o => set.add(String(o).toLowerCase()));
  }
  return [...set];
}

function statusFromAffise(raw) {
  // Affise offer states observed: active | suspended | stopped | premoderation
  const s = String(raw.status || '').toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'premoderation' || s === 'pending') return 'pending';
  return 'paused';
}

function approvalFromAffise(raw) {
  // /partner/offers only returns offers the partner is connected to — so
  // every row is implicitly approved unless Affise flags otherwise.
  // Re-derive defensively from any explicit field if present.
  return normApprovalStatus(raw.partner_status || raw.connection_status || 'approved');
}

class AffiseConnector extends BaseConnector {
  static platform = 'affise';
  static label = 'Affise';
  static capabilities = {
    list_offers:     true,
    get_offer:       true,
    get_creatives:   true,
    get_caps:        true,
    get_payouts:     true,
    get_performance: true,    // /3.0/stats/* endpoints available
    push_postback:   false,   // postback URL is set in affiliate UI per offer
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key:  { label: 'API Key',  help: 'Affiliate panel → Settings → Security' },
    base_url: { label: 'API URL',  help: 'Affiliate panel → Settings → Tracking domains → API URL (e.g. https://api-rocketcompany.affise.com)' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key) return { ok: false, error: 'Missing api_key' };
    if (!creds?.base_url) return { ok: false, error: 'Missing base_url' };
    try {
      // Cheap probe — page 1, limit 1.
      const url = `${baseUrl(creds)}/3.0/partner/offers?page=1&limit=1`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 10_000 });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = await r.json();
      if (body && body.status === 1) return { ok: true };
      return { ok: false, error: body?.error || 'unexpected response' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.base_url) return [];
    const all = [];
    let page = 1;
    for (let i = 0; i < 50; i++) {
      const url = `${baseUrl(creds)}/3.0/partner/offers?page=${page}&limit=${PAGE_LIMIT}`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 30_000 });
      if (!r.ok) throw new Error(`Affise /partner/offers HTTP ${r.status}`);
      const body = await r.json();
      if (body?.status !== 1) {
        throw new Error(`Affise API error: ${body?.error || 'status != 1'}`);
      }
      const batch = Array.isArray(body.offers) ? body.offers : [];
      all.push(...batch);
      // Pagination envelope is documented inconsistently — use length check.
      if (batch.length < PAGE_LIMIT) break;
      page += 1;
      await sleep(RATE_LIMIT_MS);
    }
    return all;
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !creds?.base_url || !externalId) return null;
    try {
      const url = `${baseUrl(creds)}/3.0/partner/offer/${encodeURIComponent(externalId)}`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 15_000 });
      if (!r.ok) return null;
      const body = await r.json();
      return body?.offer || null;
    } catch { return null; }
  }

  static normalizeOffer(raw, _creds) {
    // Use the string offer_id (ObjectId) as the stable external ID.
    const externalId = String(raw.offer_id || raw.id || '');

    const headlinePayment = pickHeadlinePayment(raw.payments);
    const payoutType = payoutTypeFromAffise(headlinePayment?.revenue_type || raw.revenue_type);
    const payoutAmount = Number(headlinePayment?.revenue ?? 0) || 0;

    // Payment row currency wins over offer-level (matches Admitad fix pattern).
    const currency = normCurrency(headlinePayment?.currency, raw.currency);

    const cats = Array.isArray(raw.full_categories)
      ? raw.full_categories.map(c => c?.title).filter(Boolean)
      : (Array.isArray(raw.categories) ? raw.categories : []);
    const vertical = cats.length ? cats.join(', ') : null;

    const creatives = Array.isArray(raw.creatives)
      ? raw.creatives
          .filter(c => c && (c.url || c.full_url))
          .map(c => ({
            type: (c.mime_type || c.type || '').includes('image') ? 'image' : 'asset',
            url: c.url || c.full_url,
            dimensions: c.width && c.height ? `${c.width}x${c.height}` : undefined,
          }))
      : [];

    const thumb = raw.logo || raw.logo_source || creatives.find(c => c.type === 'image')?.url || null;

    return {
      source_platform: 'affise',
      source_offer_id: externalId,
      source_advertiser_id: raw.advertiser_id ? String(raw.advertiser_id) : null,

      name: raw.title || `Offer ${externalId}`,
      description: descriptionFrom(raw),
      vertical,

      payout: payoutType === 'revshare' ? 0 : payoutAmount,
      payout_type: payoutType,
      payout_currency: currency,
      revshare_percent: payoutType === 'revshare' ? payoutAmount : null,
      revenue: null,

      // Re-derive from payments[] not the listing query filter (quirks note).
      allowed_countries: allowedCountriesFrom(raw.payments),
      allowed_devices: devicesFromPayments(raw.payments),
      allowed_os: osFromPayments(raw.payments),

      destination_url: raw.preview_url || null,
      tracking_url_template: raw.tracking_url || raw.link || null,
      preview_url: thumb,
      creatives,

      caps: {
        daily:   Number(raw?.caps?.day)   || Number(raw?.cap_daily)   || undefined,
        monthly: Number(raw?.caps?.month) || Number(raw?.cap_monthly) || undefined,
        total:   Number(raw?.caps?.total) || Number(raw?.cap_total)   || undefined,
      },

      schedule: {
        active_to: raw.stop_at ? Math.floor(new Date(raw.stop_at).getTime() / 1000) : null,
      },

      status: statusFromAffise(raw),
      advertiser_name: raw.advertiser_name || null,

      approval_status: approvalFromAffise(raw),

      raw,
    };
  }
}

module.exports = AffiseConnector;
