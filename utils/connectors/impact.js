/**
 * Impact (Impact.com) connector
 * Docs: https://developer.impact.com/default
 *
 * Auth: HTTP Basic with Account SID + Auth Token
 * Base URL: https://api.impact.com/Mediapartners/<accountSid>/...
 *
 * NOTE: Impact's offer model is "Campaigns". We pull the campaign list and
 * normalize each as an offer. Payout/revenue is read from the campaign's
 * default rate card.
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus } = require('./base');

function basicAuth(creds) {
  const user = creds.network_id || creds.account_sid;
  const pass = creds.api_key   || creds.auth_token;
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

class ImpactConnector extends BaseConnector {
  static platform = 'impact';
  static label = 'Impact';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: true,
    get_caps: false, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static endpoint(creds) {
    const sid = creds.network_id || creds.account_sid;
    return `https://api.impact.com/Mediapartners/${sid}`;
  }

  static async authenticate(creds) {
    if (!(creds.network_id || creds.account_sid) || !(creds.api_key || creds.auth_token)) {
      return { ok: false, error: 'Missing account SID or auth token' };
    }
    try {
      const r = await fetch(`${this.endpoint(creds)}/Campaigns?PageSize=1`, {
        headers: { 'Authorization': basicAuth(creds), 'Accept': 'application/json' },
        timeout: 10000,
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  static async listOffers(creds, _opts = {}) {
    if (!(creds.network_id || creds.account_sid)) return [];
    const url = `${this.endpoint(creds)}/Campaigns?PageSize=200`;
    const r = await fetch(url, {
      headers: { 'Authorization': basicAuth(creds), 'Accept': 'application/json' },
      timeout: 30000,
    });
    if (!r.ok) throw new Error(`Impact listOffers HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j?.Campaigns) ? j.Campaigns : [];
  }

  static async getOffer(creds, externalId) {
    if (!(creds.network_id || creds.account_sid)) return null;
    const r = await fetch(`${this.endpoint(creds)}/Campaigns/${externalId}`, {
      headers: { 'Authorization': basicAuth(creds), 'Accept': 'application/json' },
      timeout: 15000,
    });
    return r.ok ? r.json() : null;
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.Id ?? raw.id ?? '');
    const countries = (raw.AllowedCountries || raw.GeoCountries || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    return {
      source_platform: 'impact',
      source_offer_id: id,
      source_advertiser_id: raw.AdvertiserId ? `impact-${raw.AdvertiserId}` : null,

      name: raw.CampaignName || raw.Name || `Campaign ${id}`,
      description: raw.CampaignDescription || raw.Description || null,
      vertical: raw.Verticals || raw.Category || null,

      payout: Number(raw.DefaultPayout || raw.Payout) || 0,
      payout_type: 'cpa',          // Impact is mostly CPA/CPS
      payout_currency: raw.CurrencyCode || 'USD',
      revenue: null,

      allowed_countries: countries,
      allowed_devices: [],
      allowed_os: [],

      destination_url: raw.LandingPageUrl || raw.PreviewUrl || null,
      tracking_url_template: raw.TrackingLink || null,
      preview_url: raw.PreviewUrl || null,
      creatives: [],

      caps: {},
      schedule: {
        active_from: raw.StartDate ? Math.floor(new Date(raw.StartDate).getTime() / 1000) : null,
        active_to:   raw.EndDate   ? Math.floor(new Date(raw.EndDate).getTime() / 1000) : null,
      },

      status: (raw.CampaignStatus || raw.Status || 'active').toLowerCase(),
      advertiser_name: raw.AdvertiserName || null,

      // Impact: ContractStatus is the publisher↔campaign contract state.
      // "Active" = approved, "Application Received"/"Pending" = pending.
      approval_status: normApprovalStatus(raw.ContractStatus || raw.contract_status),

      raw,
    };
  }
}

module.exports = ImpactConnector;
