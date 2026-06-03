/**
 * Mobidea connector (Feed API v1.1)
 *
 * Docs (provided by publisher):
 *   https://feed.mobidea.com/feed/v1.1/ads?api_key=<key>   — all offers (catalog)
 *   https://feed.mobidea.com/feed/v1.1/adsp?api_key=<key>  — approved offers (rich)
 *
 * Archetype: CPA affiliate network with approval gating. We use /adsp
 * (approved-only) as the primary endpoint because:
 *   1. Only approved offers have tracking URLs (clickTrackingUrl field)
 *   2. Only approved offers can actually run conversions
 *   3. /ads returns 2,400+ offers across all geos — overwhelming noise
 *      for a UI without payout-filtering
 *
 * Operators wanting to browse the full catalog can do so via Mobidea's
 * web UI (https://www.mobidea.com); our connector only surfaces what
 * the operator can immediately run.
 *
 * ── Credentials ─────────────────────────────────────────────────────────
 *   api_key — Mobidea API key (single string). Issued by Mobidea AM or
 *             self-served from their dashboard.
 *
 *   No affiliate_id, no secret, no signing. Single query-string key only.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Query string: `?api_key=<key>` on every request.
 *   No headers.
 *
 * ── Response shapes (DIFFER between endpoints!) ─────────────────────────
 *   /ads  → { id, name, country, category, price, description, preview, leadflow }
 *   /adsp → { id, name, price, preview, clickTrackingUrl, description,
 *             countries, os, osmin, osmax, budgets, cr, ecpm, revenue }
 *
 *   Note `country` (singular, /ads) vs `countries` (plural, /adsp).
 *   Note /adsp has NO leadflow field — assume CPA.
 *   Note /adsp has clickTrackingUrl which is what we actually need.
 *
 * ── Quirks ──────────────────────────────────────────────────────────────
 *   • Top-level response is a JSON ARRAY (no envelope). Older docs may
 *     have shown {ads:[...]} — accept both defensively.
 *   • clickTrackingUrl uses LITERAL placeholder strings, NOT curly-brace
 *     macros:
 *       ?pub_click_id=ADD_CLICK_ID_HERE
 *       ?pub_sub_id=ADD_PUBLISHER_ID_HERE
 *     Our toOurMacros entry translates these to {click_id} and {pid}.
 *   • No currency field — Mobidea pays in USD per their docs.
 *   • budgets[] is an array of {amount, validity, consumed} where
 *     validity is "DAILY"/"WEEKLY"/"TOTAL". Map to caps shape.
 *   • os field can be "WEB" / "ANDROID" / "IOS" — singular string,
 *     not an array.
 */
const fetch = require('node-fetch');
const { BaseConnector, normCurrency, normApprovalStatus } = require('./base');

const DEFAULT_BASE = 'https://feed.mobidea.com/feed/v1.1';

function baseUrl(creds) {
  try {
    const extra = creds.extra
      ? (typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra)
      : {};
    return (extra.base_url || DEFAULT_BASE).replace(/\/+$/, '');
  } catch { return DEFAULT_BASE; }
}

function buildUrl(creds, path) {
  return `${baseUrl(creds)}${path}?api_key=${encodeURIComponent(creds.api_key)}`;
}

// Defensive: accept both top-level array AND {ads:[...]} envelope.
function parseList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.ads)) return body.ads;
  if (Array.isArray(body?.offers)) return body.offers;
  return [];
}

function leadflowToPayoutType(leadflow) {
  // Mobidea leadflow values: CPA / CPI / CPL / CPS / Revshare (when present)
  // Approved-offer endpoint omits this field — default CPA.
  const v = String(leadflow || '').toLowerCase();
  if (v.includes('rev')) return 'revshare';
  if (['cpa', 'cpi', 'cpl', 'cps', 'cpc', 'cpm'].includes(v)) return v;
  return 'cpa';
}

function aggregateCountries(raw) {
  // /ads uses `country` (singular array), /adsp uses `countries` (plural).
  const list = raw?.country || raw?.countries || [];
  if (!Array.isArray(list)) return [];
  return list.map(c => String(c || '').toUpperCase().trim()).filter(Boolean);
}

function devicesFromOS(os) {
  // Mobidea `os` is a string: WEB, ANDROID, IOS, WAP, ALL.
  const v = String(os || '').toUpperCase();
  if (!v || v === 'ALL') return ['mobile', 'tablet', 'desktop'];
  if (v === 'WEB' || v === 'DESKTOP') return ['desktop'];
  if (['ANDROID', 'IOS', 'WAP'].includes(v)) return ['mobile'];
  return [];
}

function osArrayFromOS(os) {
  const v = String(os || '').toUpperCase();
  if (v === 'ANDROID') return ['android'];
  if (v === 'IOS') return ['ios'];
  if (v === 'WEB' || v === 'DESKTOP') return ['windows', 'macos'];
  return [];
}

function capsFromBudgets(budgets) {
  if (!Array.isArray(budgets)) return {};
  const out = {};
  for (const b of budgets) {
    const amount = Number(b?.amount) || undefined;
    if (!amount) continue;
    const v = String(b?.validity || '').toUpperCase();
    if (v === 'DAILY')   out.daily = amount;
    else if (v === 'WEEKLY')  out.weekly = amount;
    else if (v === 'MONTHLY') out.monthly = amount;
    else if (v === 'TOTAL')   out.total = amount;
  }
  return out;
}

class MobideaConnector extends BaseConnector {
  static platform = 'mobidea';
  static label = 'Mobidea';
  static capabilities = {
    list_offers:     true,
    get_offer:       false,  // no single-offer endpoint in v1.1 spec
    get_creatives:   false,  // preview URL only, no separate creatives endpoint
    get_caps:        true,   // budgets[] inline on each /adsp offer
    get_payouts:     true,
    get_performance: false,  // no reporting endpoint in this feed API
    push_postback:   false,  // postback config is dashboard-only
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key: { label: 'API Key', help: 'Mobidea dashboard → API → API Key (single string, no separate affiliate_id needed)' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key) {
      return { ok: false, error: 'Missing api_key' };
    }
    try {
      // Cheap probe: /adsp typically returns a small list. If the key is bad
      // Mobidea returns HTTP 401/403 with an error body.
      const r = await fetch(buildUrl(creds, '/adsp'), { timeout: 15_000 });
      if (r.status === 401 || r.status === 403) return { ok: false, error: 'Invalid api_key' };
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      // 200 is success regardless of how many offers come back — even an
      // empty array means the key is valid but no approvals yet.
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key) return [];
    // Primary: /adsp (approved offers with tracking URLs — the actionable set).
    // Mobidea returns the full list in one shot (no pagination needed per
    // their feed API design).
    const r = await fetch(buildUrl(creds, '/adsp'), { timeout: 30_000 });
    if (!r.ok) throw new Error(`Mobidea /adsp HTTP ${r.status}`);
    const body = await r.json().catch(() => null);
    if (body == null) throw new Error('Mobidea /adsp returned non-JSON');
    return parseList(body);
  }

  static async listAllOffers(creds) {
    // Optional: full catalog (2400+ offers). Not used by listOffers but
    // available for future "browse marketplace" UI.
    if (!creds?.api_key) return [];
    const r = await fetch(buildUrl(creds, '/ads'), { timeout: 60_000 });
    if (!r.ok) throw new Error(`Mobidea /ads HTTP ${r.status}`);
    const body = await r.json().catch(() => null);
    return body == null ? [] : parseList(body);
  }

  // No single-offer GET in the v1.1 feed API. Return null so the orchestrator
  // falls back to cached normalized data.
  static async getOffer(_creds, _externalId) { return null; }

  static normalizeOffer(raw, _creds) {
    const id = String(raw?.id ?? '');
    const payoutAmount = Number(raw?.price) || 0;
    const payoutType = leadflowToPayoutType(raw?.leadflow);

    return {
      source_platform: 'mobidea',
      source_offer_id: id,
      source_advertiser_id: null,  // not exposed in feed

      name: raw?.name || `Offer ${id}`,
      description: raw?.description || null,
      vertical: Array.isArray(raw?.category) ? raw.category.join(', ') : (raw?.category || null),

      payout: payoutType === 'revshare' ? 0 : payoutAmount,
      payout_type: payoutType,
      // Mobidea pays in USD per their docs — no currency field in the API.
      payout_currency: normCurrency('USD'),
      revshare_percent: payoutType === 'revshare' ? payoutAmount : null,
      revenue: Number(raw?.revenue) || null,

      allowed_countries: aggregateCountries(raw),
      allowed_devices: devicesFromOS(raw?.os),
      allowed_os: osArrayFromOS(raw?.os),

      destination_url: raw?.preview || null,
      // clickTrackingUrl only present on /adsp. Has literal placeholder
      // strings (ADD_CLICK_ID_HERE / ADD_PUBLISHER_ID_HERE) — toOurMacros
      // translates them to {click_id} / {pid} before storing.
      tracking_url_template: raw?.clickTrackingUrl || null,
      preview_url: raw?.preview || null,
      creatives: raw?.preview ? [{ type: 'image', url: raw.preview }] : [],

      caps: capsFromBudgets(raw?.budgets),

      schedule: {},

      // /adsp only returns approved offers — implicit status active.
      // /ads doesn't return a status either; default to active.
      status: 'active',
      advertiser_name: null,

      // /adsp = approved by construction; /ads = unfiltered catalog (we
      // don't route through here in listOffers but flagged for future).
      approval_status: normApprovalStatus('approved'),

      raw,
    };
  }
}

module.exports = MobideaConnector;
