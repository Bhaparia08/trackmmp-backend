/**
 * Everflow connector
 * Docs: https://developers.everflow.io/
 *
 * Auth: header `X-Eflow-API-Key: <api_key>`
 * Base URL: https://api.eflow.team/v1/networks/<network_id>/...
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

const BASE = 'https://api.eflow.team/v1';

function payoutTypeFromEverflow(t) {
  // Everflow `payout_type`: cpa, cpc, cpi, cpm, cps, revshare, prepay
  const v = String(t || '').toLowerCase();
  if (v === 'prepay' || v === 'cpm') return 'cpa';
  return v || 'cpa';
}

class EverflowConnector extends BaseConnector {
  static platform = 'everflow';
  static label = 'Everflow';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: true,
    get_caps: true, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static async authenticate(creds) {
    if (!creds?.api_key || !creds?.network_id) {
      return { ok: false, error: 'Missing api_key or network_id' };
    }
    try {
      const r = await fetch(`${BASE}/networks/${creds.network_id}/offerstats`, {
        headers: { 'X-Eflow-API-Key': creds.api_key, 'Accept': 'application/json' },
        timeout: 10000,
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const url = `${BASE}/networks/${creds.network_id}/offerstable?page=1&page_size=200&filters[offer_status]=active`;
    const r = await fetch(url, {
      headers: { 'X-Eflow-API-Key': creds.api_key, 'Accept': 'application/json' },
      timeout: 30000,
    });
    if (!r.ok) throw new Error(`Everflow listOffers HTTP ${r.status}`);
    const data = await r.json();
    return Array.isArray(data?.offers) ? data.offers : (Array.isArray(data?.data) ? data.data : []);
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !creds?.network_id) return null;
    const r = await fetch(`${BASE}/networks/${creds.network_id}/offers/${externalId}`, {
      headers: { 'X-Eflow-API-Key': creds.api_key, 'Accept': 'application/json' },
      timeout: 15000,
    });
    if (!r.ok) return null;
    return r.json();
  }

  static normalizeOffer(raw, creds) {
    const id = String(raw.network_offer_id ?? raw.offer_id ?? raw.id ?? '');
    const advName = raw.network_advertiser?.name || raw.advertiser_name || null;
    const advId   = raw.network_advertiser_id ? `everflow-${raw.network_advertiser_id}` : null;

    const countries = (raw.countries || raw.allowed_countries || [])
      .map(c => String(c?.country_code || c).toUpperCase()).filter(Boolean);

    const devices = [];
    if (raw.platforms?.includes('mobile_ios') || raw.platforms?.includes('mobile_android')) devices.push('mobile');
    if (raw.platforms?.includes('desktop')) devices.push('desktop');
    if (raw.platforms?.includes('tablet')) devices.push('tablet');

    const os = [];
    if (raw.platforms?.includes('mobile_ios')) os.push('ios');
    if (raw.platforms?.includes('mobile_android')) os.push('android');

    return {
      source_platform: 'everflow',
      source_offer_id: id,
      source_advertiser_id: advId,

      name: raw.name || raw.offer_name || `Offer ${id}`,
      description: raw.html_description || raw.description || null,
      vertical: raw.network_category?.name || raw.category || null,

      payout: Number(raw.payout) || 0,
      payout_type: payoutTypeFromEverflow(raw.payout_type),
      payout_currency: normCurrency(raw.currency_id),
      revenue: Number(raw.revenue) || null,
      revenue_type: raw.revenue_type || null,

      allowed_countries: countries,
      allowed_devices: devices.length ? devices : ['mobile', 'desktop'],
      allowed_os: os,
      allowed_traffic: raw.allowed_traffic_types || null,

      destination_url: raw.destination_url || raw.preview_url || null,
      tracking_url_template: raw.tracking_url || raw.destination_url || null,
      preview_url: raw.preview_url || null,
      creatives: [],

      caps: {
        daily: raw.cap?.daily || raw.daily_conversion_cap || null,
        monthly: raw.cap?.monthly || null,
        total: raw.cap?.total || raw.total_conversion_cap || null,
      },

      schedule: {
        active_from: raw.start_date ? Math.floor(new Date(raw.start_date).getTime() / 1000) : null,
        active_to:   raw.end_date   ? Math.floor(new Date(raw.end_date).getTime() / 1000) : null,
      },

      status: (raw.offer_status || 'active').toLowerCase(),
      advertiser_name: advName,

      // Everflow: relationship object carries the affiliate↔offer status when
      // present. Network-admin endpoint may omit it — defaults to 'unknown'.
      approval_status: normApprovalStatus(raw.relationship?.status || raw.relationship_status),

      raw,
    };
  }
}

module.exports = EverflowConnector;
