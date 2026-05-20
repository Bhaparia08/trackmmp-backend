/**
 * Insparx connector (CAKE Affiliate API v1)
 *
 * Verified live against https://affiliates.insparx.com/affiliates/api/1/
 * on 2026-05-12 — endpoint shape, response format, and field names are
 * confirmed working.
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key       — Insparx API Key
 *   network_id    — Insparx Affiliate ID (CAKE calls this affiliate_id)
 *   (no other creds needed)
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Query-string only: api_key + affiliate_id on every request.
 *
 * ── Endpoint actually in use ────────────────────────────────────────────
 *   GET /affiliates/api/1/Offers.asmx/OfferFeed
 *     ?api_key=…&affiliate_id=…&offer_id=0&media_type_id=0&category_id=0
 *     &country_code=&tag_id=0&tag_name=&include_test_offers=false
 *
 *   Returns XML (CAKE v1 does not honour format=json). We parse a flat
 *   <Offer> list with a small focused regex parser — no XML library
 *   dependency added.
 *
 * ── Known fields per Offer (from live response) ─────────────────────────
 *   offer_id, offer_contract_id, campaign_id (nilable), offer_name,
 *   vertical, status_id, status_name ("Public" / "Active"),
 *   payout (currency-prefixed string "€6.00"), price_format ("CPA" etc.),
 *   thumbnail_image_url, expiration_date (nilable).
 *
 * ── Fields NOT in the basic feed (would need OfferSummary if/when we
 *    figure out its full param set) ────────────────────────────────────
 *   destination_url, tracking_url, allowed_countries (per-country payouts),
 *   allowed_devices, daily/total caps, advertiser_name.
 *
 *   Result: candidates land in the Discovery Hub with name + vertical +
 *   payout + status, but landing-page validation is skipped (no URL).
 *   That's acceptable for a first cut — your team can still review and
 *   import; we can iterate to add URLs in a follow-up.
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const DEFAULT_BASE = 'https://affiliates.insparx.com/affiliates/api/1';

function baseUrl(creds) {
  try {
    const extra = creds.extra ? (typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra) : {};
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

// Parse currency-prefixed payout strings like "€6.00", "$2.50", "1.10"
function parsePayout(str) {
  if (!str) return 0;
  const m = String(str).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function detectCurrency(str) {
  if (!str) return 'USD';
  if (String(str).startsWith('€')) return 'EUR';
  if (String(str).startsWith('£')) return 'GBP';
  if (String(str).startsWith('$')) return 'USD';
  return 'USD';
}

function payoutTypeFromCake(pf) {
  const v = String(pf || '').toLowerCase();
  if (v.includes('rev'))   return 'revshare';
  if (v.includes('cpi'))   return 'cpi';
  if (v.includes('cpl'))   return 'cpl';
  if (v.includes('cps'))   return 'cps';
  if (v.includes('cpc'))   return 'cpc';
  return 'cpa';
}

function statusFromCake(name) {
  const v = String(name || '').toLowerCase();
  if (v === 'public' || v === 'active') return 'active';
  if (v === 'paused' || v === 'private') return 'paused';
  if (v === 'expired' || v === 'deleted') return 'archived';
  return v || 'active';
}

// ── XML parser (focused on CAKE's flat <Offer> structure) ──────────────
// Returns an array of plain objects, one per <Offer> node, with all child
// element values as string properties. Handles xsi:nil="true" → null.
function parseOfferFeedXML(xml) {
  if (typeof xml !== 'string') return [];
  const offers = [];
  const offerRegex = /<Offer>([\s\S]*?)<\/Offer>/g;
  let m;
  while ((m = offerRegex.exec(xml)) !== null) {
    const block = m[1];
    const obj = {};
    // Match child elements: <tag>value</tag>  OR  <tag xsi:nil="true" />
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

class InsparxConnector extends BaseConnector {
  static platform = 'insparx';
  static label = 'Insparx (CAKE)';
  static capabilities = {
    list_offers: true,    get_offer: false,         // OfferSummary not yet wired up
    get_creatives: false, get_caps: false,
    get_payouts: true,    get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static async authenticate(creds) {
    if (!creds?.api_key || !creds?.network_id) {
      return { ok: false, error: 'Missing api_key or affiliate_id' };
    }
    try {
      const url = `${baseUrl(creds)}/Offers.asmx/GetMediaTypes?${buildQS(creds)}`;
      const r = await fetch(url, { timeout: 10_000 });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = await r.text();
      // Successful GetMediaTypes response always contains <MediaType>
      return body.includes('<MediaType>')
        ? { ok: true }
        : { ok: false, error: 'unexpected response (no MediaType nodes)' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const url = `${baseUrl(creds)}/Offers.asmx/OfferFeed?${buildQS(creds, {
      offer_id: '0',
      media_type_id: '0',
      category_id: '0',
      country_code: '',
      tag_id: '0',
      tag_name: '',
      include_test_offers: 'false',
    })}`;
    const r = await fetch(url, { timeout: 30_000 });
    if (!r.ok) throw new Error(`Insparx OfferFeed HTTP ${r.status}`);
    const xml = await r.text();
    return parseOfferFeedXML(xml);
  }

  // OfferSummary requires params we haven't pinned down yet — leave it
  // unimplemented so the orchestrator falls back to the cached feed row.
  static async getOffer(_creds, _externalId) { return null; }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.offer_id ?? '');
    const payoutNum = parsePayout(raw.payout);
    return {
      source_platform: 'insparx',
      source_offer_id: id,
      source_advertiser_id: null,     // Not in OfferFeed; need OfferSummary

      name: raw.offer_name || `Offer ${id}`,
      description: null,
      vertical: raw.vertical || null,

      payout: payoutNum,
      payout_type: payoutTypeFromCake(raw.price_format),
      payout_currency: normCurrency(detectCurrency(raw.payout)),
      revenue: null,

      allowed_countries: [],          // Not in basic feed
      allowed_devices: [],
      allowed_os: [],

      destination_url: null,          // Not in basic feed
      tracking_url_template: null,
      preview_url: raw.thumbnail_image_url || null,
      creatives: raw.thumbnail_image_url
        ? [{ type: 'image', url: raw.thumbnail_image_url }]
        : [],

      caps: {},

      schedule: {
        active_to: raw.expiration_date
          ? Math.floor(new Date(raw.expiration_date).getTime() / 1000)
          : null,
      },

      status: statusFromCake(raw.status_name),
      advertiser_name: null,           // Not exposed in OfferFeed

      // CAKE OfferFeed doesn't return per-affiliate approval state — that
      // lives on OfferSummary which isn't wired up yet (Phase B follow-up).
      approval_status: 'unknown',

      raw,
    };
  }
}

module.exports = InsparxConnector;
