/**
 * Trackier connector (Performance Publisher API v1.0.0)
 *
 * Spec source: https://github.com/trackier/perf-pub-api-docs (openapi-1.0.0.yaml).
 * Stoplight portal: https://api-docs.trackier.io/docs/perf-pub-api-docs
 *
 * ── Credentials (advertiser_api_credentials row) ────────────────────────
 *   api_key — Trackier publisher API key (header: X-Api-Key)
 *             Obtained from: Trackier dashboard → Integration → API tab
 *
 *   No network_id / advertiser_id needed — the API key alone identifies
 *   the publisher account.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 *   Header `X-Api-Key: <api_key>` on every request.
 *   (Spec also accepts ?apiKey= query but we use the header consistently.)
 *
 * ── Endpoints in use ────────────────────────────────────────────────────
 *   GET /v2/publishers/profile           → cheap auth probe
 *   GET /v2/publisher/campaigns          → paginated offer list (note: singular)
 *     ?page=N&limit=1000&showApproved=1  — only fetch offers the publisher
 *                                          is approved on (status filter)
 *
 *   Rate limit: 5 req/sec on /campaigns. We pace 250ms between page fetches.
 *
 * ── Quirks worth knowing ────────────────────────────────────────────────
 *   • `model = 'cps'` ⇒ RevShare — `payout` is a percentage, not a dollar
 *     amount. Don't FX-convert these.
 *   • Trackier collapses CPL into `cpa` — there is no CPL enum value.
 *   • `currency: null` is documented to mean USD (spec line 1022).
 *   • No top-level `status` field on offers. We rely on `showApproved=1`
 *     to filter the list, and treat `cap.type === 'exhausted'` as paused.
 *   • Two pagination styles across the API (page/limit vs cursor); the
 *     /campaigns endpoint we use is page/limit, default 1000.
 *   • Postback URLs are configured in the Trackier dashboard, NOT via API.
 *     Operator must paste our postback URL into Publisher Customize manually.
 *   • Advertiser identity not exposed in the publisher offer payload — to
 *     get advertiser_name we'd need /v2/publishers/reports?group=advertiser,
 *     which we don't call here (Phase B if needed).
 *
 * ── Fields per PublisherCampaign (spec line 1000+) ──────────────────────
 *   id, title, description, categories[], currency, model,
 *   payouts[] (per-geo with allowedValues/variable),
 *   countries[], device, os, os_version,
 *   cap.{type,daily,monthly,lifetime},
 *   creatives[] {mime_type, file_name, title, full_url, dimensions},
 *   tracking_link, preview_url, defaultGoal, goals[],
 *   app_id, app_name (mobile install offers only),
 *   landingPage[], subIdsAllow/Block, isps, citiesInclude/Exclude,
 *   flow, kpi, impressionUrl, bot_check_url.
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const DEFAULT_BASE = 'https://api.trackier.com';
const PAGE_LIMIT = 1000;
const RATE_LIMIT_MS = 250; // 4 req/sec — under the 5/sec documented cap

function baseUrl(creds) {
  try {
    const extra = creds.extra
      ? (typeof creds.extra === 'string' ? JSON.parse(creds.extra) : creds.extra)
      : {};
    return (extra.base_url || DEFAULT_BASE).replace(/\/+$/, '');
  } catch { return DEFAULT_BASE; }
}

function authHeaders(creds) {
  return { 'X-Api-Key': creds.api_key, Accept: 'application/json' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Trackier `model` enum: cpa|cpi|cpc|cpm|cps
// cps == RevShare in Trackier's vocabulary (payout is %, not $)
function payoutTypeFromTrackier(model) {
  const v = String(model || '').toLowerCase();
  if (v === 'cps') return 'revshare';
  if (['cpi', 'cpa', 'cpl', 'cpc', 'cpm'].includes(v)) return v;
  return 'cpa';
}

// Pick the most representative payout from the payouts[] array.
// Strategy: first payout entry's `payout` (or `fixedPayout`) wins; we keep
// the rest in `raw.payouts` for downstream per-geo handling.
function pickHeadlinePayout(payouts) {
  if (!Array.isArray(payouts) || payouts.length === 0) return { amount: 0, currency: null };
  const head = payouts[0] || {};
  const amount = Number(head.payout ?? head.fixedPayout ?? 0) || 0;
  // Per-payout currency wins over offer-level. Spec doesn't document a
  // currency field on the payout row itself, but we read it defensively
  // in case it appears.
  return { amount, currency: head.currency || null };
}

function statusFromTrackier(raw) {
  // No top-level status field. Infer from cap state when possible.
  const capType = String(raw?.cap?.type || '').toLowerCase();
  if (capType === 'exhausted' || capType === 'paused') return 'paused';
  return 'active';
}

function allowedDevices(device) {
  // Trackier `device`: mobile | desktop | tablet | all
  const v = String(device || '').toLowerCase();
  if (!v || v === 'all') return ['mobile', 'tablet', 'desktop'];
  return [v];
}

function allowedOS(os) {
  if (!os) return [];
  if (Array.isArray(os)) return os.map(s => String(s).toLowerCase());
  return [String(os).toLowerCase()];
}

class TrackierConnector extends BaseConnector {
  static platform = 'trackier';
  static label = 'Trackier';
  static capabilities = {
    list_offers:     true,
    get_offer:       true,
    get_creatives:   true,   // creatives ship inline on each offer
    get_caps:        true,   // cap.{daily,monthly,lifetime} inline
    get_payouts:     true,
    get_performance: false,  // would need /v2/publishers/reports
    push_postback:   false,  // dashboard-only
    webhook_inbound: false,
  };

  static credentialHints = {
    api_key:  { label: 'API Key',   help: 'Trackier dashboard → Integration → API → X-Api-Key' },
  };

  static async authenticate(creds) {
    if (!creds?.api_key) {
      return { ok: false, error: 'Missing api_key' };
    }
    try {
      const url = `${baseUrl(creds)}/v2/publishers/profile`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 10_000 });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const body = await r.json();
      if (body && (body.success === false || body.error)) {
        return { ok: false, error: body.error || 'API rejected key' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, opts = {}) {
    if (!creds?.api_key) return [];
    const showApproved = opts.showApproved === false ? 0 : 1;
    const all = [];
    let page = 1;
    // Safety: stop at 50 pages (50k offers) — well above any real publisher catalog.
    for (let i = 0; i < 50; i++) {
      const qs = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_LIMIT),
        showApproved: String(showApproved),
      }).toString();
      const url = `${baseUrl(creds)}/v2/publisher/campaigns?${qs}`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 30_000 });
      if (!r.ok) throw new Error(`Trackier /v2/publisher/campaigns HTTP ${r.status}`);
      const body = await r.json();
      const data = body?.data || {};
      const batch = Array.isArray(data.campaigns) ? data.campaigns : [];
      all.push(...batch);
      if (batch.length < PAGE_LIMIT) break; // last page
      page += 1;
      await sleep(RATE_LIMIT_MS);
    }
    return all;
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !externalId) return null;
    try {
      const url = `${baseUrl(creds)}/v2/publisher/campaign/${encodeURIComponent(externalId)}`;
      const r = await fetch(url, { headers: authHeaders(creds), timeout: 15_000 });
      if (!r.ok) return null;
      const body = await r.json();
      return body?.data || body || null;
    } catch { return null; }
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.id ?? '');
    const { amount: payoutAmount, currency: payoutRowCurrency } = pickHeadlinePayout(raw.payouts);
    const payoutType = payoutTypeFromTrackier(raw.model);

    // Per spec: currency=null defaults to USD. normCurrency handles fall-through.
    const currency = normCurrency(payoutRowCurrency, raw.currency);

    // Categories: Trackier returns array of strings; first is the most common.
    const verticalArr = Array.isArray(raw.categories) ? raw.categories : [];
    const vertical = verticalArr.length ? verticalArr.join(', ') : null;

    const creatives = Array.isArray(raw.creatives)
      ? raw.creatives
          .filter(c => c && c.full_url)
          .map(c => ({
            type: (c.mime_type || '').startsWith('image') ? 'image' : 'asset',
            url: c.full_url,
            dimensions: c.dimensions
              ? `${c.dimensions.width || 0}x${c.dimensions.height || 0}`
              : undefined,
          }))
      : [];

    const thumb = creatives.find(c => c.type === 'image')?.url || null;

    return {
      source_platform: 'trackier',
      source_offer_id: id,
      source_advertiser_id: null, // not exposed in publisher view

      name: raw.title || `Offer ${id}`,
      description: raw.description || null,
      vertical,

      payout: payoutType === 'revshare' ? 0 : payoutAmount, // revshare is %, not $
      payout_type: payoutType,
      payout_currency: currency,
      revshare_percent: payoutType === 'revshare' ? payoutAmount : null,
      revenue: null,

      allowed_countries: Array.isArray(raw.countries) ? raw.countries : [],
      allowed_devices: allowedDevices(raw.device),
      allowed_os: allowedOS(raw.os),

      destination_url: raw.preview_url || null,
      tracking_url_template: raw.tracking_link || null,
      preview_url: thumb,
      creatives,

      caps: {
        daily:   Number(raw?.cap?.daily)    || undefined,
        monthly: Number(raw?.cap?.monthly)  || undefined,
        total:   Number(raw?.cap?.lifetime) || undefined,
      },

      schedule: {},

      status: statusFromTrackier(raw),
      advertiser_name: raw.app_name || null, // best-effort; not the advertiser

      // showApproved=1 means everything in this list is approved for this publisher
      approval_status: normApprovalStatus('approved'),

      raw,
    };
  }
}

module.exports = TrackierConnector;
