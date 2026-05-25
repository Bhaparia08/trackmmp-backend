/**
 * ClickDealer connector (CAKE Affiliate Platform — JSON variant)
 *
 * Default base: https://partners.clickdealer.com/affiliates/api/1
 *
 * Same CAKE backend as Insparx but returns JSON natively (Insparx returns
 * XML on the same endpoints) and exposes a richer endpoint surface.
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key      — ClickDealer affiliate API key (top of affiliate panel → API)
 *   network_id   — Affiliate ID (numeric). ClickDealer calls this `affiliate_id`.
 *                  We store it under `network_id` to match other connectors.
 *   extra.base_url (optional) — override default ClickDealer host if running
 *                  on a custom CAKE network domain.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Query-string only: api_key + affiliate_id on every request.
 *   Same pattern as Insparx.
 *
 * ── Endpoints in use ────────────────────────────────────────────────────
 *   GET /offers.asmx/OfferFeed          — primary list endpoint (JSON)
 *   GET /offers.asmx/GetCampaign        — single-offer detail incl. tracking link
 *   GET /offers.asmx/ApplyForOffer      — auto-apply (creates a campaign)
 *   GET /offers.asmx/SetPostbackURL     — set S2S postback per campaign
 *
 *   Auth probe uses /offers.asmx/OfferFeed with row_limit=1.
 *
 * ── Quirks worth knowing ────────────────────────────────────────────────
 *   • Response is JSON envelope `{ success, row_count, offers: [...] }`
 *     where `success` is a STRING `"true"`/`"false"` (not a boolean).
 *   • Payout fields are currency-prefixed strings ("$4.00", "kr89.00").
 *     We parse numeric value + use the explicit `currency` field, with
 *     fallback to detecting the symbol prefix.
 *   • `payout_converted` + `currency_converted` give USD-converted values
 *     for free — we still write our own payout_usd via discoveryEngine.
 *   • `allowed_countries` is an array of `{country_code, country_name}` objects,
 *     not strings.
 *   • `platforms[]` is an array of `{platform_id, platform_name}` objects.
 *     Names look like "desktop (mac)", "mobile (android)" etc. — we split.
 *   • `flow[]` (OfferFeed) vs `flows[]` (GetCampaign) — note the plural diff.
 *   • Tracking URL is NOT in OfferFeed. Only available after applying for the
 *     offer (ApplyForOffer creates a campaign) or via GetCampaign once a
 *     campaign exists. Our normalizer sets tracking_url_template to null
 *     and exposes preview_link only.
 *   • Postback macros (CAKE convention): #s2# = our click_id passthrough,
 *     #s3#–#s5# = sub IDs, #price# = payout, #requested_action_id# = goal.
 *     Same macros as Insparx.
 *   • Row limit on every list endpoint: 1000 max per docs. We page by
 *     start_at_row+row_limit=1000.
 *   • Status field: `offer_status.status_id` + `offer_status.status_name`
 *     ("Public", "Apply to run", "Active", "Pending"). We map Public+Active
 *     to active; Apply to run + Pending to pending.
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const DEFAULT_BASE = 'https://partners.clickdealer.com/affiliates/api/1';
const PAGE_LIMIT = 1000;
const RATE_LIMIT_MS = 250;

function baseUrl(creds) {
  try {
    const extra = creds.extra
      ? (typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra)
      : {};
    return (extra.base_url || DEFAULT_BASE).replace(/\/+$/, '');
  } catch { return DEFAULT_BASE; }
}

function buildQS(creds, extras = {}) {
  return new URLSearchParams({
    api_key: creds.api_key,
    affiliate_id: String(creds.network_id || ''),
    ...extras,
  }).toString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse currency-prefixed payout strings: "$4.00", "kr89.00", "1.10", "€6.50"
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
  if (s.startsWith('kr')) return 'DKK';  // CAKE convention; could also be SEK/NOK
  if (s.startsWith('¥')) return 'JPY';
  if (s.startsWith('₹')) return 'INR';
  return null;
}

// CAKE price_format → our payout_type vocabulary
function payoutTypeFromCake(pf) {
  const v = String(pf || '').toLowerCase();
  if (v.includes('rev'))     return 'revshare';
  if (v.includes('cpi'))     return 'cpi';
  if (v.includes('cpl'))     return 'cpl';
  if (v.includes('cps'))     return 'cps';
  if (v.includes('cpc'))     return 'cpc';
  if (v.includes('cpm'))     return 'cpm';
  // "Fixed", "CPA", "CPA Flat" all map to cpa
  return 'cpa';
}

// CAKE status names → our vocabulary
function statusFromCake(statusName) {
  const v = String(statusName || '').toLowerCase();
  if (v === 'public' || v === 'active') return 'active';
  if (v === 'apply to run' || v === 'pending') return 'pending';
  return 'paused';
}

// CAKE platforms is EITHER an array `[{platform_id, platform_name}]` or the
// string "all" when every platform is permitted. Same pattern for flow and
// allowed_media_types. Discovered via live probe 2026-05-25.
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

// CAKE allowed_countries: array of {country_code, country_name} when restricted,
// empty array [] when ALL countries are allowed (the affiliate has no geo restriction).
function countriesFromCake(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(c => String(c?.country_code || '').toUpperCase()).filter(Boolean);
}

// CAKE returns a placeholder thumbnail (just the host root) when no real
// thumbnail exists. Detect via path being empty/single-slash.
function realThumbnailOrNull(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/' || u.pathname === '') return null;
    return url;
  } catch {
    return url; // not a parseable URL — let the consumer deal with it
  }
}

class ClickDealerConnector extends BaseConnector {
  static platform = 'clickdealer';
  static label = 'ClickDealer (CAKE)';
  static capabilities = {
    list_offers:     true,
    get_offer:       true,   // GetCampaign
    get_creatives:   true,   // GetCampaign returns creatives[]
    get_caps:        true,   // OfferFeed exposes default_campaign_cap
    get_payouts:     true,
    get_performance: true,   // /reports.asmx/Conversions + Summary
    push_postback:   true,   // /offers.asmx/SetPostbackURL — unique to CAKE
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key:    { label: 'API Key',     help: 'ClickDealer affiliate panel → API → API key' },
    network_id: { label: 'Affiliate ID', help: 'ClickDealer affiliate panel → API → Affiliate ID (numeric, e.g. 298858)' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key)    return { ok: false, error: 'Missing api_key' };
    if (!creds?.network_id) return { ok: false, error: 'Missing affiliate_id (network_id)' };
    try {
      const url = `${baseUrl(creds)}/offers.asmx/OfferFeed?${buildQS(creds, { row_limit: '1' })}`;
      const r = await fetch(url, { timeout: 15_000, headers: { Accept: 'application/json' } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = await r.json().catch(() => null);
      if (!body) return { ok: false, error: 'Non-JSON response' };
      if (String(body.success) !== 'true') {
        const msg = body['Possible errors:']
          ? Object.keys(body['Possible errors:']).join(', ')
          : 'API rejected credentials';
        return { ok: false, error: msg };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const all = [];
    let startAtRow = 1;
    for (let i = 0; i < 50; i++) {
      const qs = buildQS(creds, {
        offer_status_id: opts.status || 'All',
        row_limit: String(PAGE_LIMIT),
        start_at_row: String(startAtRow),
      });
      const url = `${baseUrl(creds)}/offers.asmx/OfferFeed?${qs}`;
      const r = await fetch(url, { timeout: 30_000, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`ClickDealer OfferFeed HTTP ${r.status}`);
      const body = await r.json().catch(() => null);
      if (!body || String(body.success) !== 'true') {
        throw new Error(`ClickDealer OfferFeed error: ${JSON.stringify(body?.['Possible errors:'] || body)}`);
      }
      const batch = Array.isArray(body.offers) ? body.offers : [];
      all.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      startAtRow += PAGE_LIMIT;
      await sleep(RATE_LIMIT_MS);
    }
    return all;
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !creds?.network_id || !externalId) return null;
    try {
      const url = `${baseUrl(creds)}/offers.asmx/GetCampaign?${buildQS(creds, {
        offer_id: String(externalId),
        row_limit: '1',
      })}`;
      const r = await fetch(url, { timeout: 15_000, headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      // GetCampaign returns the offer at key "0" (numeric-key envelope).
      return body?.['0'] || null;
    } catch { return null; }
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.offer_id ?? '');
    const payoutAmount = parsePayoutAmount(raw.payout);
    const payoutType = payoutTypeFromCake(raw.price_format);

    // Use explicit currency, then symbol-detect from the payout string.
    const currency = normCurrency(raw.currency, detectCurrencyFromSymbol(raw.payout));

    const statusName = raw?.offer_status?.status_name || raw.status_name || '';
    const status = statusFromCake(statusName);

    const platforms = raw.platforms || [];

    return {
      source_platform: 'clickdealer',
      source_offer_id: id,
      source_advertiser_id: null,  // CAKE OfferFeed doesn't expose advertiser id

      name: raw.offer_name || `Offer ${id}`,
      description: raw.description || null,
      vertical: raw.vertical_name || null,

      payout: payoutType === 'revshare' ? 0 : payoutAmount,
      payout_type: payoutType,
      payout_currency: currency,
      revshare_percent: payoutType === 'revshare' ? payoutAmount : null,
      revenue: null,

      allowed_countries: countriesFromCake(raw.allowed_countries),
      allowed_devices: devicesFromPlatforms(platforms),
      allowed_os: osFromPlatforms(platforms),

      destination_url: raw.preview_link || null,
      tracking_url_template: null,  // not in OfferFeed; need GetCampaign after Apply
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
      advertiser_name: null,  // not in OfferFeed

      // OfferFeed returns all offers visible to the affiliate; "Public" =
      // can run immediately, "Apply to run" = needs approval. We surface
      // this as approval_status.
      approval_status: status === 'pending' ? 'pending' : normApprovalStatus(statusName),

      raw,
    };
  }
}

module.exports = ClickDealerConnector;
