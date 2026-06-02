/**
 * Generic CAKE Affiliate Platform connector.
 *
 * CAKE (cake.com) powers a long tail of affiliate networks — Insparx,
 * ClickDealer, plus many smaller branded portals. They all expose the
 * same `/offers.asmx/*` API surface with identical auth pattern
 * (api_key + affiliate_id as query strings).
 *
 * This connector handles ANY CAKE-powered network the operator points it
 * at. Differences across CAKE installs we've seen:
 *   • Response format: older installs return XML, newer installs return
 *     JSON. We probe both — try JSON first, fall back to XML parser.
 *   • Base URL: every network has its own host (affiliates.<network>.com).
 *     Operator must paste it in.
 *   • Field availability: minimal CAKE installs return only the OfferFeed
 *     basics (name/payout/status); richer installs (ClickDealer) include
 *     countries/platforms/flow. Normalizer handles both via permissive
 *     `Array.isArray` checks + "all" string coercion.
 *
 * This is a Phase-1.5 step toward single-source-of-truth: the existing
 * dedicated `insparx` and `clickdealer` connectors keep working
 * unchanged, but any new CAKE network plugs in with zero code by using
 * this platform and pasting the base URL.
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key      — Affiliate API key (top of affiliate panel → API tab)
 *   network_id   — Numeric Affiliate ID (CAKE calls this `affiliate_id`)
 *   extra.base_url (REQUIRED) — Network's API base URL.
 *                  Example: https://affiliates.<network>.com/affiliates/api/1
 *   extra.response_format (optional) — 'json' | 'xml' | 'auto' (default)
 *
 * ── Subclassing for branded networks ────────────────────────────────────
 * A future named CAKE network can subclass this and lock the defaults:
 *     class AdsMainConnector extends CAKEConnector {
 *       static platform = 'adsmain';
 *       static label = 'AdsMain (CAKE)';
 *       static defaultBaseUrl = 'https://affiliates.adsmain.com/affiliates/api/1';
 *       static defaultResponseFormat = 'json';
 *     }
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const PAGE_LIMIT = 1000;
const RATE_LIMIT_MS = 250;

// ── Shared helpers ──────────────────────────────────────────────────────

function readExtra(creds) {
  if (!creds || !creds.extra) return {};
  try {
    return typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra;
  } catch {
    return {};
  }
}

function parsePayoutAmount(str) {
  if (str == null) return 0;
  const m = String(str).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function detectCurrencyFromSymbol(str) {
  if (!str) return null;
  const s = String(str);
  if (s.startsWith('€')) return 'EUR';
  if (s.startsWith('£')) return 'GBP';
  if (s.startsWith('$')) return 'USD';
  if (s.startsWith('kr')) return 'DKK';
  if (s.startsWith('¥')) return 'JPY';
  if (s.startsWith('₹')) return 'INR';
  return null;
}

// CAKE price_format strings → our payout_type vocabulary
function payoutTypeFromCake(pf) {
  const v = String(pf || '').toLowerCase();
  if (v.includes('rev')) return 'revshare';
  if (v.includes('cpi')) return 'cpi';
  if (v.includes('cpl')) return 'cpl';
  if (v.includes('cps')) return 'cps';
  if (v.includes('cpc')) return 'cpc';
  if (v.includes('cpm')) return 'cpm';
  return 'cpa';
}

function statusFromCake(name) {
  const v = String(name || '').toLowerCase();
  if (v === 'public' || v === 'active') return 'active';
  if (v === 'apply to run' || v === 'pending') return 'pending';
  if (v === 'paused' || v === 'private') return 'paused';
  if (v === 'expired' || v === 'deleted') return 'archived';
  return v || 'active';
}

// CAKE `platforms[]` is EITHER an array of {platform_id, platform_name} OR
// the string "all". Same shape applies to `flow` and `allowed_media_types`.
// Discovered via live ClickDealer probe 2026-05-25.
function devicesFromPlatforms(platforms) {
  if (platforms === 'all' || platforms == null) return ['mobile', 'tablet', 'desktop'];
  if (!Array.isArray(platforms)) return [];
  const set = new Set();
  for (const p of platforms) {
    const n = String(p?.platform_name || '').toLowerCase();
    if (n.includes('mobile')) set.add('mobile');
    else if (n.includes('tablet')) set.add('tablet');
    else if (n.includes('desktop')) set.add('desktop');
  }
  return [...set];
}

function osFromPlatforms(platforms) {
  if (platforms === 'all' || platforms == null) return ['android', 'ios', 'windows', 'macos'];
  if (!Array.isArray(platforms)) return [];
  const set = new Set();
  for (const p of platforms) {
    const n = String(p?.platform_name || '').toLowerCase();
    if (n.includes('android')) set.add('android');
    if (n.includes('ios'))     set.add('ios');
    if (n.includes('mac'))     set.add('macos');
    if (n.includes('pc') || n.includes('windows')) set.add('windows');
  }
  return [...set];
}

function countriesFromCake(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(c => String(c?.country_code || '').toUpperCase()).filter(Boolean);
}

// Filter out CAKE placeholder thumbnails (host-root URLs with no path)
function realThumbnailOrNull(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/' || u.pathname === '') return null;
    return url;
  } catch {
    return url;
  }
}

// ── XML parser (focused on CAKE's flat <Offer> structure) ──────────────
// Inherited verbatim from the dedicated insparx connector — handles the
// `xsi:nil="true"` empty-element form CAKE emits. Returns a flat array of
// raw objects so downstream normalization treats XML and JSON sources
// identically.
function parseOfferFeedXML(xml) {
  if (typeof xml !== 'string') return [];
  const offers = [];
  const offerRegex = /<Offer>([\s\S]*?)<\/Offer>/g;
  let m;
  while ((m = offerRegex.exec(xml)) !== null) {
    const block = m[1];
    const obj = {};
    const childRegex = /<(\w+)(?:\s+xsi:nil="true"\s*\/>|>([^<]*)<\/\1>)/g;
    let c;
    while ((c = childRegex.exec(block)) !== null) {
      const [, tag, val] = c;
      obj[tag] = val === undefined ? null : val.trim();
    }
    offers.push(obj);
  }
  return offers;
}

// Parse a CAKE response body — auto-detects JSON vs XML, or honours
// explicit responseFormat. Returns { offers: Array, rowCount: number|null }.
//
// H3 fix (2026-06-02): separate JSON parse failure (legitimate fall-through
// to XML in auto mode) from API logic failure (success != true), which must
// always propagate so operators see the real failure. Previously a single
// try/catch swallowed both — leading to "Fetching offers…" hanging on the
// frontend when the API actually said "Invalid api_key" or similar.
function parseFeedResponse(text, format) {
  const trimmed = String(text || '').trimStart();

  // Try JSON if requested or if format is auto and looks JSON-shaped
  if (format === 'json' || (format !== 'xml' && trimmed.startsWith('{'))) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (e) {
      // JSON parse failed.  In explicit json mode → propagate.  In auto mode
      // → leave body=null so we fall through to XML below.
      if (format === 'json') throw e;
    }

    // If JSON parsed successfully, validate success OUTSIDE the parse catch.
    // This throw must reach the caller — it's the operator-actionable signal
    // (Invalid api_key, geo restricted, etc).
    if (body) {
      if (String(body.success) !== 'true' && body.success !== true) {
        const errs = body['Possible errors:'];
        const msg = errs ? Object.keys(errs).join(', ') : 'API returned success != true';
        throw new Error(msg);
      }
      return {
        offers: Array.isArray(body.offers) ? body.offers : [],
        rowCount: Array.isArray(body.row_count) ? Number(body.row_count[0]) : Number(body.row_count) || null,
      };
    }
  }

  // XML fallback (auto mode JSON parse failed, or format=xml)
  const offers = parseOfferFeedXML(text);
  return { offers, rowCount: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CAKEConnector base class ───────────────────────────────────────────

class CAKEConnector extends BaseConnector {
  static platform = 'cake';
  static label = 'CAKE Affiliate Platform (Custom Network)';

  // Subclasses can lock these. The generic platform leaves defaultBaseUrl
  // null so the operator MUST provide one via creds.extra.base_url.
  static defaultBaseUrl = null;
  static defaultResponseFormat = 'auto'; // 'json' | 'xml' | 'auto'

  static capabilities = {
    list_offers:     true,
    get_offer:       false, // GetCampaign — subclasses can enable
    get_creatives:   false,
    get_caps:        true,
    get_payouts:     true,
    get_performance: false,
    push_postback:   false, // SetPostbackURL — subclasses can enable
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key:    { label: 'API Key',     help: 'Affiliate panel → API tab' },
    network_id: { label: 'Affiliate ID', help: 'Numeric affiliate ID from the affiliate panel (CAKE calls this affiliate_id)' },
    base_url:   { label: 'API Base URL', help: 'e.g. https://affiliates.<network>.com/affiliates/api/1 (paste in extra.base_url)' },
  };

  static baseUrl(creds) {
    const extra = readExtra(creds);
    // Accept base_url at top-level (matches Affise's convention) OR nested in
    // extra.base_url (matches Insparx's convention). Subclasses fall back
    // to defaultBaseUrl if both are absent.
    const url = creds?.base_url || extra.base_url || this.defaultBaseUrl;
    if (!url) throw new Error(`${this.platform} requires base_url (paste in cred form or subclass with defaultBaseUrl)`);
    return String(url).replace(/\/+$/, '');
  }

  static responseFormat(creds) {
    const extra = readExtra(creds);
    return creds?.response_format || extra.response_format || this.defaultResponseFormat;
  }

  static buildQS(creds, extras = {}) {
    return new URLSearchParams({
      api_key: creds.api_key,
      affiliate_id: String(creds.network_id || ''),
      ...extras,
    }).toString();
  }

  static async authenticate(creds) {
    if (!creds?.api_key)    return { ok: false, error: 'Missing api_key' };
    if (!creds?.network_id) return { ok: false, error: 'Missing affiliate_id (network_id)' };
    let base;
    try { base = this.baseUrl(creds); }
    catch (e) { return { ok: false, error: e.message }; }
    try {
      const url = `${base}/offers.asmx/OfferFeed?${this.buildQS(creds, { row_limit: '1' })}`;
      const r = await fetch(url, { timeout: 15_000, headers: { Accept: 'application/json' } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const text = await r.text();
      try {
        parseFeedResponse(text, this.responseFormat(creds));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `Parse/API error: ${e.message}` };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const base = this.baseUrl(creds);
    const format = this.responseFormat(creds);
    const all = [];
    let startAtRow = 1;
    for (let i = 0; i < 50; i++) {
      const qs = this.buildQS(creds, {
        offer_status_id: opts.status || 'All',
        row_limit: String(PAGE_LIMIT),
        start_at_row: String(startAtRow),
      });
      const url = `${base}/offers.asmx/OfferFeed?${qs}`;
      const r = await fetch(url, { timeout: 30_000, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`CAKE OfferFeed HTTP ${r.status} (${base})`);
      const text = await r.text();
      const { offers } = parseFeedResponse(text, format);
      all.push(...offers);
      if (offers.length < PAGE_LIMIT) break;
      startAtRow += PAGE_LIMIT;
      await sleep(RATE_LIMIT_MS);
    }
    return all;
  }

  // Subclasses with GetCampaign capability can override this.
  static async getOffer(_creds, _externalId) { return null; }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.offer_id ?? '');
    const payoutAmount = parsePayoutAmount(raw.payout);
    const payoutType = payoutTypeFromCake(raw.price_format);

    const currency = normCurrency(raw.currency, detectCurrencyFromSymbol(raw.payout));

    // Status can come as offer_status: { status_name } (JSON, newer CAKE)
    // or as a flat status_name (XML, older CAKE)
    const statusName = raw?.offer_status?.status_name || raw.status_name || raw.status || '';
    const status = statusFromCake(statusName);

    return {
      source_platform: this.platform,
      source_offer_id: id,
      source_advertiser_id: null,

      name: raw.offer_name || `Offer ${id}`,
      description: raw.description || null,
      vertical: raw.vertical_name || raw.vertical || null,

      payout: payoutType === 'revshare' ? 0 : payoutAmount,
      payout_type: payoutType,
      payout_currency: currency,
      revshare_percent: payoutType === 'revshare' ? payoutAmount : null,
      revenue: null,

      allowed_countries: countriesFromCake(raw.allowed_countries),
      allowed_devices: devicesFromPlatforms(raw.platforms),
      allowed_os: osFromPlatforms(raw.platforms),

      destination_url: raw.preview_link || null,
      tracking_url_template: null, // not in OfferFeed; requires Apply + GetCampaign
      preview_url: realThumbnailOrNull(raw.thumbnail_image_url),
      creatives: realThumbnailOrNull(raw.thumbnail_image_url)
        ? [{ type: 'image', url: raw.thumbnail_image_url }]
        : [],

      caps: {
        total: raw.default_campaign_cap ? Number(raw.default_campaign_cap) || undefined : undefined,
      },

      schedule: {
        active_to: raw.expiration_date
          ? Math.floor(new Date(raw.expiration_date).getTime() / 1000)
          : null,
      },

      status,
      advertiser_name: raw.advertiser_name || null,

      approval_status: status === 'pending' ? 'pending' : normApprovalStatus(statusName),

      raw,
    };
  }
}

// Export helpers too so subclasses (or test code) can reuse them.
module.exports = CAKEConnector;
module.exports.helpers = {
  parsePayoutAmount,
  detectCurrencyFromSymbol,
  payoutTypeFromCake,
  statusFromCake,
  devicesFromPlatforms,
  osFromPlatforms,
  countriesFromCake,
  realThumbnailOrNull,
  parseOfferFeedXML,
  parseFeedResponse,
};
