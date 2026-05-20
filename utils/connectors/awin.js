/**
 * Awin connector
 * Docs: https://developer.awin.com/apidocs
 *
 * Auth: Bearer <OAuth2 token>
 *   Get one from Awin Account → Toolbox → API Credentials → "API Token"
 *
 * Credentials shape:
 *   api_key:     <OAuth2 bearer token>
 *   network_id:  <publisher id (numeric)>
 *   api_secret:  (unused)
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const BASE = 'https://api.awin.com';

class AwinConnector extends BaseConnector {
  static platform = 'awin';
  static label = 'Awin';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: true,
    get_caps: false, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static async authenticate(creds) {
    if (!creds?.api_key)    return { ok: false, error: 'Missing api_key (Awin OAuth2 token)' };
    if (!creds?.network_id) return { ok: false, error: 'Missing network_id (Awin publisher id)' };
    try {
      const r = await fetch(`${BASE}/publishers/${creds.network_id}/programmes?relationship=joined`, {
        headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
        timeout: 10_000,
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const r = await fetch(`${BASE}/publishers/${creds.network_id}/programmes?relationship=joined`, {
      headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
      timeout: 30_000,
    });
    if (!r.ok) throw new Error(`Awin listOffers HTTP ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data : (data?.programmes || []);
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !creds?.network_id) return null;
    const r = await fetch(`${BASE}/publishers/${creds.network_id}/programmedetails?advertiserId=${externalId}`, {
      headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
      timeout: 15_000,
    });
    return r.ok ? r.json() : null;
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.id || raw.advertiserId || raw.programmeId);
    const countries = (raw.validDomains || raw.regions || []).map(c => {
      // Awin sometimes returns ISO country codes, sometimes "GB", "US" etc.
      const s = typeof c === 'string' ? c : (c?.country || c?.code || '');
      return String(s).toUpperCase();
    }).filter(s => s.length === 2);

    // Awin commission ranges — pick top "default" / "joining" commission
    const comm = raw.commissionRange || raw.commission || raw.actionPayouts?.[0] || {};
    const payout = Number(comm.max) || Number(comm.value) || Number(comm.default) || 0;
    const ptype  = comm.type === 'percentage' ? 'revshare' : 'cpa';

    return {
      source_platform:       'awin',
      source_offer_id:       id,
      source_advertiser_id:  `awin-${id}`,
      advertiser_name:       raw.name || raw.advertiserName || null,
      name:                  raw.name || raw.displayName || `Advertiser ${id}`,
      description:           raw.description || raw.programmeDescription || null,
      vertical:              raw.primarySector?.name || raw.sector || raw.category || null,
      payout, payout_type: ptype,
      payout_currency:       normCurrency(comm.currency, raw.currencyCode),
      revenue: null, revenue_type: null,
      allowed_countries:     countries,
      allowed_devices:       ['mobile','desktop'],
      allowed_os:            [],
      destination_url:       raw.clickThroughUrl || raw.displayUrl || raw.logoUrl,
      tracking_url_template: raw.clickThroughUrl || null,
      preview_url:           raw.displayUrl || raw.logoUrl || null,
      creatives:             [],
      caps:                  { daily: null, monthly: null, total: null },
      schedule:              { active_from: null, active_to: null },
      status:                (raw.status || raw.programmeStatus || 'active').toLowerCase(),
      // Awin: listOffers filters by `relationship=joined` — every programme
      // returned is one the publisher is already approved on. Auto-approved.
      approval_status:       'approved',
      raw,
    };
  }
}

module.exports = AwinConnector;
