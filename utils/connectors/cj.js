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
const { BaseConnector, normApprovalStatus, normCurrency } = require('./base');

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
      // Probe: a small query with a DYNAMIC date (30 days ago).
      // Previously hardcoded "2024-01-01" — would have eventually drifted
      // out of CJ's accepted date window. Dynamic = forever-current.
      const sinceDate = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10) + 'T00:00:00Z';
      const q = `{ publisherCommissions(forPublishers:["${creds.network_id}"], maxComputedAt:"${sinceDate}") { count } }`;
      const r = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
        timeout: 10_000,
      });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      // GraphQL "errors" key is independent of HTTP status — surface it
      // so genuine auth failures (e.g. expired token) don't return ok:true.
      const data = await r.json().catch(() => null);
      if (data?.errors && data.errors.length) {
        return { ok: false, error: data.errors.map(e => e.message).join('; ').slice(0, 200) };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  static async listOffers(creds, _opts = {}) {
    if (!creds?.api_key || !creds?.network_id) return [];
    // Pagination loop (added 2026-06-03): previously single-call, silently
    // truncating publishers with many joined advertisers. CJ's advertiserLookup
    // supports `limit` + `offset`. Loop terminates when a page returns < LIMIT.
    const LIMIT = 100;        // CJ default max per page
    const MAX_PAGES = 50;     // safety cap: 5000 advertisers
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * LIMIT;
      const query = `
        query {
          advertiserLookup(advertiserStatus:JOINED, requestorCid:"${creds.network_id}", limit:${LIMIT}, offset:${offset}) {
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
      if (!r.ok) throw new Error(`CJ listOffers HTTP ${r.status} (page ${page})`);
      const data = await r.json();
      // GraphQL errors propagate (e.g. invalid CID, rate-limited). Previously
      // swallowed — fetch returned [] silently when CJ returned errors.
      if (data?.errors && data.errors.length) {
        throw new Error('CJ GraphQL errors: ' + data.errors.map(e => e.message).join('; ').slice(0, 200));
      }
      const batch = data?.data?.advertiserLookup?.advertisers || [];
      all.push(...batch);
      if (batch.length < LIMIT) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return all;
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
      payout, payout_type: ptype, payout_currency: normCurrency(primary.payoutCurrency),
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
      // CJ: relationshipStatus is "Joined" | "PendingApproval" | "Rejected" |
      // "NotJoined". advertiserStatus:JOINED filter already excludes most NotJoined,
      // but PendingApproval can still appear for in-flight applications.
      approval_status:        normApprovalStatus(raw.relationshipStatus),
      raw,
    };
  }
}

module.exports = CJConnector;
