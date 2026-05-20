/**
 * MaxBounty connector
 * Docs: https://app.maxbounty.com/api/docs (publisher login required)
 *
 * Auth: Bearer <api token>
 *   Get one from MaxBounty Account → API → Generate Token
 *
 * Credentials shape:
 *   api_key:     <api token>
 *   network_id:  <affiliate id (numeric)>
 *   api_secret:  (unused)
 */
const fetch = require('node-fetch');
const { BaseConnector, normApprovalStatus } = require('./base');

const BASE = 'https://api.maxbounty.com/v1';

class MaxBountyConnector extends BaseConnector {
  static platform = 'maxbounty';
  static label = 'MaxBounty';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: true,
    get_caps: true, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static async authenticate(creds) {
    if (!creds?.api_key) return { ok: false, error: 'Missing api_key (MaxBounty API token)' };
    try {
      const r = await fetch(`${BASE}/offers?limit=1`, {
        headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
        timeout: 10_000,
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key) return [];
    const r = await fetch(`${BASE}/offers?status=active&limit=500`, {
      headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
      timeout: 30_000,
    });
    if (!r.ok) throw new Error(`MaxBounty listOffers HTTP ${r.status}`);
    const data = await r.json();
    return Array.isArray(data?.offers) ? data.offers : (Array.isArray(data?.data) ? data.data : []);
  }

  static async getOffer(creds, externalId) {
    if (!creds?.api_key) return null;
    const r = await fetch(`${BASE}/offers/${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${creds.api_key}`, Accept: 'application/json' },
      timeout: 15_000,
    });
    return r.ok ? r.json() : null;
  }

  static normalizeOffer(raw, _creds) {
    const id = String(raw.id || raw.offer_id);
    const countries = (raw.countries || raw.allowed_countries || []).map(c => String(c).toUpperCase()).filter(Boolean);
    const devices   = (raw.devices   || raw.allowed_devices  || []).map(d => String(d).toLowerCase());

    return {
      source_platform:       'maxbounty',
      source_offer_id:       id,
      source_advertiser_id:  raw.advertiser_id ? `mb-${raw.advertiser_id}` : null,
      advertiser_name:       raw.advertiser_name || raw.brand || null,
      name:                  raw.name || raw.offer_name || `Offer ${id}`,
      description:           raw.description || null,
      vertical:              raw.vertical || raw.category || null,
      payout:                Number(raw.payout) || Number(raw.amount) || 0,
      payout_type:           (raw.payout_type || raw.model || 'cpa').toLowerCase(),
      payout_currency:       raw.currency || 'USD',
      revenue:               null, revenue_type: null,
      allowed_countries:     countries,
      allowed_devices:       devices.length ? devices : ['mobile','desktop'],
      allowed_os:            raw.os || [],
      destination_url:       raw.destination_url || raw.preview_url || null,
      tracking_url_template: raw.tracking_url || null,
      preview_url:           raw.preview_url || null,
      creatives:             Array.isArray(raw.creatives) ? raw.creatives : [],
      caps: {
        daily:   raw.daily_cap || null,
        monthly: raw.monthly_cap || null,
        total:   raw.total_cap || null,
      },
      schedule: {
        active_from: raw.start_date ? Math.floor(new Date(raw.start_date).getTime()/1000) : null,
        active_to:   raw.end_date   ? Math.floor(new Date(raw.end_date).getTime()/1000)   : null,
      },
      status: (raw.status || 'active').toLowerCase(),
      // MaxBounty: per-offer approval state. `is_approved` boolean is most
      // common; some responses use `approval_status` string.
      approval_status: normApprovalStatus(
        raw.is_approved != null ? raw.is_approved : raw.approval_status
      ),
      raw,
    };
  }
}

module.exports = MaxBountyConnector;
