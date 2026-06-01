/**
 * Offer18 connector (Affiliate API)
 *
 * Doc sources:
 *   https://knowledgebase.offer18.com/affiliate/affiliate-apis
 *   https://knowledgebase.offer18.com/affiliate/affiliate-apis/offers-api
 *   https://knowledgebase.offer18.com/affiliate/affiliate-apis/request-offer-api
 *
 * Archetype: standard affiliate-network CPA offer feed (Trackier/Affise
 * sibling). Distinct from RedTrack / Voluum which are media-buyer trackers
 * and don't expose offer catalogs.
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key      — Offer18 API key. Dashboard → Account → API Access → Security
 *   network_id   — Affiliate ID (Offer18 calls this `aid`)
 *   extra.mid    — Network/Advertiser MID (Offer18 calls this `mid`)
 *
 *   All three are REQUIRED — Offer18 won't authorize without all of them.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Query-string only — no header auth. Every request includes:
 *     ?key=<api_key>&aid=<network_id>&mid=<mid>
 *
 * ── Endpoint in use ─────────────────────────────────────────────────────
 *   GET /api/af/offers
 *     ?key=…&aid=…&mid=…&page=N&offer_status=1&authorized=1&offer_access=1
 *
 *   `offer_status=1` = active offers only
 *   `authorized=1`   = only offers the affiliate has access to
 *   `offer_access=1` = only offers approved for the affiliate
 *
 *   Pagination: `page` query param. We don't know the exact page size
 *   limit — default to 50 pages (~50k offers) as a safety cap.
 *
 * ── Quirks worth knowing ────────────────────────────────────────────────
 *   • `model` field carries the payout type: CPA / CPC / CPI / CPL / RevShare.
 *   • `price` is the payout amount, `currency` is the ISO code.
 *   • `country_allow` and `country_block` are arrays of ISO-2 codes.
 *     Empty country_allow + non-empty country_block ⇒ global except blocked.
 *   • `events` carries the goal/event list (id, name, payout per event).
 *   • Suppression list URLs are valid only 2 hours — we don't fetch them
 *     in listOffers; that's a separate per-offer call if needed.
 *   • Tracking link convention: aff_sub passes the affiliate's click_id.
 *     We translate via toOurMacros at the legacy-adapter / Discovery Hub
 *     boundary so this connector itself doesn't need to know.
 *   • Postback management is dashboard-only — no API endpoint to set
 *     postback URLs programmatically.
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const DEFAULT_BASE = 'https://api.offer18.com';
const RATE_LIMIT_MS = 200;
const MAX_PAGES = 50;

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

function buildQS(creds, extras = {}) {
  const extra = readExtra(creds);
  const mid = extra.mid || creds.mid || '';
  return new URLSearchParams({
    key: creds.api_key,
    aid: String(creds.network_id || ''),
    mid: String(mid),
    ...extras,
  }).toString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Offer18 `model` enum: CPA / CPC / CPI / CPL / RevShare (case varies)
function payoutTypeFromOffer18(model) {
  const v = String(model || '').toLowerCase();
  if (v.includes('rev')) return 'revshare';
  if (v === 'cpi') return 'cpi';
  if (v === 'cpl') return 'cpl';
  if (v === 'cpc') return 'cpc';
  if (v === 'cpm') return 'cpm';
  if (v === 'cps') return 'cps';
  return 'cpa';
}

function statusFromOffer18(raw) {
  // Offer18 `status`: 1 = active, 0 = paused (most common). Some envelopes
  // use string "active"/"paused"/"pending".
  const s = String(raw.status ?? '').toLowerCase();
  if (s === '1' || s === 'active' || s === 'public') return 'active';
  if (s === 'pending' || s === 'apply' || s === 'request') return 'pending';
  return 'paused';
}

function countriesFromOffer18(raw) {
  // country_allow wins when non-empty. Otherwise we expose nothing
  // (consumers can infer "global except country_block" if needed).
  if (Array.isArray(raw.country_allow) && raw.country_allow.length) {
    return raw.country_allow.map(c => String(c).toUpperCase()).filter(Boolean);
  }
  if (typeof raw.country_allow === 'string' && raw.country_allow.trim()) {
    return raw.country_allow.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

function creativesFromOffer18(raw) {
  const out = [];
  if (Array.isArray(raw.creatives)) {
    for (const c of raw.creatives) {
      const url = c?.url || c?.file_url || c?.full_url;
      if (url) {
        out.push({
          type: (c.mime_type || c.type || '').includes('image') ? 'image' : 'asset',
          url,
          dimensions: (c.width && c.height) ? `${c.width}x${c.height}` : undefined,
        });
      }
    }
  }
  if (raw.logo) out.push({ type: 'image', url: raw.logo });
  return out;
}

class Offer18Connector extends BaseConnector {
  static platform = 'offer18';
  static label = 'Offer18';
  static capabilities = {
    list_offers:     true,
    get_offer:       true,   // /offers with offer_id filter
    get_creatives:   true,   // creatives[] inline on each offer
    get_caps:        true,   // capping field
    get_payouts:     true,
    get_performance: true,   // Reports API available (separate endpoint)
    push_postback:   false,  // Dashboard-only
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key:    { label: 'API Key',      help: 'Dashboard → Account → API Access → Security → API Key' },
    network_id: { label: 'Affiliate ID', help: 'Dashboard → Account → API Access → Security → AID (numeric)' },
    mid:        { label: 'Network MID',  help: 'Dashboard → Account → API Access → Security → MID (paste in extra.mid or top-level mid field)' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key)    return { ok: false, error: 'Missing api_key' };
    if (!creds?.network_id) return { ok: false, error: 'Missing aid (network_id)' };
    const extra = readExtra(creds);
    if (!creds.mid && !extra.mid) return { ok: false, error: 'Missing mid (paste in extra.mid or top-level mid field)' };
    try {
      const url = `${baseUrl(creds)}/api/af/offers?${buildQS(creds, { page: '1' })}`;
      const r = await fetch(url, { timeout: 15_000, headers: { Accept: 'application/json' } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = await r.json().catch(() => null);
      if (!body) return { ok: false, error: 'Non-JSON response' };
      // Offer18 returns { status: 'success', ... } on success, { status: 'error', message: '...' } on failure.
      if (body.status === 'error' || body.error) {
        return { ok: false, error: body.message || body.error || 'API rejected credentials' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const extra = readExtra(creds);
    if (!creds.mid && !extra.mid) return [];

    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = buildQS(creds, {
        page: String(page),
        offer_status: opts.status === 'all' ? '' : '1',  // default: active only
        authorized: '1',
        offer_access: '1',
      });
      const url = `${baseUrl(creds)}/api/af/offers?${qs}`;
      const r = await fetch(url, { timeout: 30_000, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`Offer18 /offers HTTP ${r.status}`);
      const body = await r.json().catch(() => null);
      if (!body || body.status === 'error') {
        throw new Error(`Offer18 API error: ${body?.message || 'status=error'}`);
      }
      // Response shape: { status: 'success', data: { offers: [...], page, total } }
      // or { status: 'success', offers: [...] } depending on tenant
      const offers = Array.isArray(body?.data?.offers) ? body.data.offers
                   : Array.isArray(body?.offers)       ? body.offers
                   : [];
      all.push(...offers);
      if (offers.length === 0) break;
      // If the API tells us total pages, respect it; otherwise stop on first empty page
      const totalPages = body?.data?.total_pages || body?.pagination?.total_pages || null;
      if (totalPages && page >= Number(totalPages)) break;
      await sleep(RATE_LIMIT_MS);
    }
    return all;
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !creds?.network_id || !externalId) return null;
    try {
      const url = `${baseUrl(creds)}/api/af/offers?${buildQS(creds, { offer_id: String(externalId) })}`;
      const r = await fetch(url, { timeout: 15_000, headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      const offers = Array.isArray(body?.data?.offers) ? body.data.offers
                   : Array.isArray(body?.offers)       ? body.offers
                   : [];
      return offers[0] || null;
    } catch { return null; }
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.offerid ?? raw.offer_id ?? raw.id ?? '');
    const payoutAmount = Number(raw.price ?? raw.payout ?? 0) || 0;
    const payoutType = payoutTypeFromOffer18(raw.model);

    const currency = normCurrency(raw.currency);

    const status = statusFromOffer18(raw);

    return {
      source_platform: 'offer18',
      source_offer_id: id,
      source_advertiser_id: raw.advertiser_id ? String(raw.advertiser_id) : null,

      name: raw.name || raw.offer_name || `Offer ${id}`,
      description: raw.description || raw.preview_text || null,
      vertical: raw.category || raw.vertical || null,

      payout: payoutType === 'revshare' ? 0 : payoutAmount,
      payout_type: payoutType,
      payout_currency: currency,
      revshare_percent: payoutType === 'revshare' ? payoutAmount : null,
      revenue: null,

      allowed_countries: countriesFromOffer18(raw),
      allowed_devices: [],  // not in basic offer payload; targeting object has device hints
      allowed_os: [],

      destination_url: raw.preview_url || raw.landing_page || null,
      tracking_url_template: raw.tracking_url || raw.tracking_link || null,
      preview_url: raw.logo || null,
      creatives: creativesFromOffer18(raw),

      caps: {
        daily:   Number(raw?.capping?.daily)   || Number(raw?.cap_daily)   || undefined,
        monthly: Number(raw?.capping?.monthly) || Number(raw?.cap_monthly) || undefined,
        total:   Number(raw?.capping?.total)   || Number(raw?.cap_total)   || undefined,
      },

      schedule: {
        active_to: raw.expiration_date
          ? Math.floor(new Date(raw.expiration_date).getTime() / 1000)
          : null,
      },

      status,
      advertiser_name: raw.advertiser_name || raw.network_name || null,

      // authorized=1 filter means we only see offers approved for us.
      approval_status: status === 'pending' ? 'pending' : normApprovalStatus('approved'),

      raw,
    };
  }
}

module.exports = Offer18Connector;
