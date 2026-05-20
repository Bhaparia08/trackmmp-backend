/**
 * CJ Affiliate (Commission Junction) connector
 * Docs: https://developers.cj.com/
 *
 * Auth: Bearer <personal access token>
 *   Get one from CJ Account → Account → Web Services → API Access
 *
 * CJ migrated to GraphQL in 2023.  We use the publisher commission API to
 * list advertisers + their advertiser-level offer details.  For per-product
 * SKUs CJ has a separate Product Search API which can be added later.
 *
 * Credentials shape:
 *   api_key:     <personal access token>
 *   network_id:  <publisher company id (CID)>
 *   api_secret:  (unused)
 */
const fetch = require('node-fetch');
const { BaseConnector } = require('./base');

const GRAPHQL_URL = 'https://ads.api.cj.com/query';

class CJConnector extends BaseConnector {
  static platform = 'cj';
  static label = 'CJ Affiliate';
  static capabilities = {
    list_offers: true, get_offer: true, get_creatives: false,
    get_caps: false, get_payouts: true, get_performance: false,
    push_postback: false, webhook_inbound: false,
  };

  static async authenticate(creds) {
    if (!creds?.api_key)    return { ok: false, error: 'Missing api_key (CJ personal access token)' };
    if (!creds?.network_id) return { ok: false, error: 'Missing network_id (CJ publisher company id, "CID")' };
    try {
      // Tiny query — fetch our own publisher profile
      const q = `{ publisherCommissions(forPublishers:["${creds.network_id}"], maxComputedAt:"2024-01-01T00:00:00Z") { count } }`;
      const r = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
        timeout: 10_000,
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    // CJ advertiser search — returns programs we can promote
    const query = `
      query {
        advertiserLookup(advertiserStatus:JOINED, requestorCid:"${creds.network_id}") {
          payloadInfo { totalAvailable }
          advertisers {
            advertiserId advertiserName programUrl primaryCategory { name }
            mobileSupported networkRank sevenDayEpc threeMonthEpc
            relationshipStatus actionPayouts {
              actionName payoutCurrency itemSale percentageDefault }
          }
        }
      }`;
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      timeout: 30_000,
    });
    if (!r.ok) throw new Error(`CJ listOffers HTTP ${r.status}`);
    const data = await r.json();
    return data?.data?.advertiserLookup?.advertisers || [];
  }

  static normalizeOffer(raw, creds) {
    const id = String(raw.advertiserId);
    const advName = raw.advertiserName;
    const primary = raw.actionPayouts?.[0] || {};
    const payout  = Number(primary.percentageDefault) || Number(primary.itemSale) || 0;
    const ptype   = primary.percentageDefault ? 'revshare' : 'cpa';

    return {
      source_platform:        'cj',
      source_offer_id:        id,
      source_advertiser_id:   `cj-${id}`,
      advertiser_name:        advName,
      name:                   advName,
      vertical:               raw.primaryCategory?.name || null,
      payout, payout_type: ptype, payout_currency: primary.payoutCurrency || 'USD',
      allowed_countries:      [],          // CJ programs aren't strictly geo-restricted at the listing level
      allowed_devices:        raw.mobileSupported ? ['mobile','desktop'] : ['desktop'],
      allowed_os:             [],
      destination_url:        raw.programUrl,
      tracking_url_template:  raw.programUrl,
      preview_url:            raw.programUrl,
      creatives:              [],
      caps:                   { daily: null, monthly: null, total: null },
      schedule:               { active_from: null, active_to: null },
      status:                 (raw.relationshipStatus || 'active').toLowerCase(),
      raw,
    };
  }
}

module.exports = CJConnector;
