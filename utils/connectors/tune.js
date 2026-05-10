/**
 * TUNE / HasOffers connector
 * Docs: https://developers.tune.com/network-sdk/
 *
 * Auth: query string `NetworkId=<id>&Target=Offer&Method=findAll&api_key=<key>`
 * Base URL: https://<network_id>.api.hasoffers.com/Apiv3/json
 */
const fetch = require('node-fetch');
const { BaseConnector } = require('./base');

function payoutTypeFromTune(t) {
  const v = String(t || '').toLowerCase();
  if (v === 'cpa_flat') return 'cpa';
  if (v === 'cpa_percentage') return 'revshare';
  return v || 'cpa';
}

class TuneConnector extends BaseConnector {
  static platform = 'tune';
  static label = 'TUNE / HasOffers';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: true,
    get_caps: true, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static endpoint(creds) {
    return `https://${creds.network_id}.api.hasoffers.com/Apiv3/json`;
  }

  static async authenticate(creds) {
    if (!creds?.api_key || !creds?.network_id) return { ok: false, error: 'Missing api_key or network_id' };
    try {
      const url = `${this.endpoint(creds)}?NetworkId=${creds.network_id}&Target=Offer&Method=findAll&api_key=${encodeURIComponent(creds.api_key)}&fields[]=id&limit=1`;
      const r = await fetch(url, { timeout: 10000 });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      return j?.response?.status === 1 ? { ok: true } : { ok: false, error: j?.response?.errorMessage || 'auth failed' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    const fields = ['id','name','status','description','preview_url','default_payout','payout_type','revenue','currency','expiration_date','default_goal_name'];
    const fieldQs = fields.map(f => `fields[]=${f}`).join('&');
    const url = `${this.endpoint(creds)}?NetworkId=${creds.network_id}&Target=Offer&Method=findAll&filters[status]=active&limit=500&${fieldQs}&api_key=${encodeURIComponent(creds.api_key)}`;
    const r = await fetch(url, { timeout: 30000 });
    if (!r.ok) throw new Error(`TUNE listOffers HTTP ${r.status}`);
    const j = await r.json();
    if (j?.response?.status !== 1) return [];
    const data = j.response.data || {};
    // TUNE returns an object keyed by offer id — convert to array
    return Object.values(data).map(row => row.Offer || row).filter(Boolean);
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key || !creds?.network_id) return null;
    const url = `${this.endpoint(creds)}?NetworkId=${creds.network_id}&Target=Offer&Method=findById&id=${externalId}&api_key=${encodeURIComponent(creds.api_key)}`;
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.response?.data || null;
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.id ?? '');
    return {
      source_platform: 'tune',
      source_offer_id: id,
      source_advertiser_id: raw.advertiser_id ? `tune-${raw.advertiser_id}` : null,

      name: raw.name || `Offer ${id}`,
      description: raw.description || null,
      vertical: raw.category || raw.vertical || null,

      payout: Number(raw.default_payout) || 0,
      payout_type: payoutTypeFromTune(raw.payout_type),
      payout_currency: raw.currency || 'USD',
      revenue: Number(raw.revenue) || null,

      allowed_countries: [],     // TUNE exposes via separate Country endpoint
      allowed_devices: [],
      allowed_os: [],

      destination_url: raw.preview_url || null,
      tracking_url_template: null,  // built per-affiliate
      preview_url: raw.preview_url || null,
      creatives: [],

      caps: {
        daily: raw.daily_conversion_cap || null,
        total: raw.total_conversion_cap || null,
      },

      schedule: {
        active_to: raw.expiration_date ? Math.floor(new Date(raw.expiration_date).getTime() / 1000) : null,
      },

      status: (raw.status || 'active').toLowerCase(),
      advertiser_name: raw.advertiser_name || null,

      raw,
    };
  }
}

module.exports = TuneConnector;
