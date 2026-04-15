/**
 * /api/integrations  — Fetch offers from advertiser platforms and import them as campaigns
 *
 * POST /api/integrations/fetch-offers   — call external platform API, return normalised offer list
 * POST /api/integrations/import         — import selected offers as campaigns
 */
const express = require('express');
const fetch   = require('node-fetch');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { customAlphabet } = require('nanoid');

const nanoid12  = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 12);
const nanoid20hex = customAlphabet('0123456789abcdef', 20);

const router = express.Router();
router.use(requireAuth);

/* ─── Platform adapters ───────────────────────────────────────────────────────
   Each adapter returns a normalised offer array. Each offer includes:
   - tracking_url : the advertiser's actual click tracking URL with OUR macros
                    substituted in place of their platform-specific macro syntax
   - preview_url  : the landing/preview page URL (no macros)
   The import route uses tracking_url as destination_url so our track.js can
   resolve and redirect with real values at click time.
─────────────────────────────────────────────────────────────────────────────── */

/**
 * Convert a platform's native macro syntax into our standard {macro} tokens.
 * Called on the tracking URL returned by each platform before storing.
 *
 * Platform macro formats:
 *   Impact       : [MACRO_NAME]  e.g. [clickId], [subId1], [mediaPartner]
 *   Everflow     : {macro}       e.g. {transaction_id}, {affiliate_id}  (already close to ours)
 *   TUNE/HasOffers: {macro}      e.g. {transaction_id}, {affiliate_id}
 *   CityAds      : {macro}       e.g. {click_id}, {webmaster_id}
 *   AppsFlyer    : {macro}       — AF macros map directly
 */
function toOurMacros(url, platform) {
  if (!url) return url;

  // Per-platform translation tables  [ their_macro , our_macro ]
  const maps = {
    impact: [
      // click ID — THE most important: we put our click_id here so Impact returns it in postbacks
      ['[clickId]',         '{click_id}'],
      ['[CLICK_ID]',        '{click_id}'],
      ['[irclickid]',       '{click_id}'],
      ['[IRCLICKID]',       '{click_id}'],
      // Sub IDs
      ['[subId1]',          '{sub1}'],
      ['[subId2]',          '{sub2}'],
      ['[subId3]',          '{sub3}'],
      ['[subId4]',          '{sub4}'],
      ['[subId5]',          '{sub5}'],
      ['[SUB1]',            '{sub1}'],
      ['[SUB2]',            '{sub2}'],
      ['[SUB3]',            '{sub3}'],
      // Publisher / media partner
      ['[mediaPartner]',    '{pid}'],
      ['[MEDIA_PARTNER_ID]','{pid}'],
      ['[PUBLISHER_ID]',    '{pid}'],
      ['[publisherId]',     '{pid}'],
      // Device / geo
      ['[device]',          '{device_type}'],
      ['[DEVICE]',          '{device_type}'],
      ['[country]',         '{country}'],
      ['[COUNTRY]',         '{country}'],
      ['[advertisingId]',   '{advertising_id}'],
      ['[ADVERTISING_ID]',  '{advertising_id}'],
      ['[idfa]',            '{idfa}'],
      ['[IDFA]',            '{idfa}'],
      ['[gaid]',            '{gaid}'],
      ['[ip]',              '{ip}'],
    ],
    everflow: [
      // Everflow uses {macro} format — just rename their macros to ours
      ['{transaction_id}',  '{click_id}'],
      ['{affiliate_id}',    '{pid}'],
      ['{offer_id}',        '{campaign_id}'],
      ['{creative_id}',     '{creative_id}'],
      // sub1-sub5 already match, advertising_id already matches
    ],
    tune: [
      ['{transaction_id}',  '{click_id}'],
      ['{affiliate_id}',    '{pid}'],
      ['{offer_id}',        '{campaign_id}'],
      // sub1-sub5 already match
    ],
    cityads: [
      ['{click_id}',        '{click_id}'],   // already matches
      ['{clickid}',         '{click_id}'],
      ['{webmaster_id}',    '{pid}'],
      ['{sub_id}',          '{sub1}'],
    ],
    appsflyer: [
      // AF uses {macro} — map their names to ours
      ['{clickid}',              '{click_id}'],
      ['{publisher_click_id}',   '{publisher_click_id}'],
      ['{af_sub1}',              '{sub1}'],
      ['{af_sub2}',              '{sub2}'],
      ['{af_sub3}',              '{sub3}'],
      ['{af_sub4}',              '{sub4}'],
      ['{af_sub5}',              '{sub5}'],
      ['{advertising_id}',       '{advertising_id}'],
    ],
    swaarm: [
      // Swaarm click-ID variations
      ['{pub_click_id}',    '{click_id}'],
      ['[pub_click_id]',    '{click_id}'],
      ['{clickid}',         '{click_id}'],
      ['[clickid]',         '{click_id}'],
      ['{click_id}',        '{click_id}'],    // already our format
      ['[click_id]',        '{click_id}'],
      // Publisher ID
      ['{pub_id}',          '{pid}'],
      ['[pub_id]',          '{pid}'],
      ['{publisher_id}',    '{pid}'],
      ['[publisher_id]',    '{pid}'],
      // Sub IDs
      ['{sub_id}',          '{sub1}'],
      ['{sub1}',            '{sub1}'],
      ['{sub2}',            '{sub2}'],
      ['{sub3}',            '{sub3}'],
      ['[sub1]',            '{sub1}'],
      ['[sub2]',            '{sub2}'],
      ['[sub3]',            '{sub3}'],
      // Offer / campaign ID
      ['{offer_id}',        '{campaign_id}'],
      ['[offer_id]',        '{campaign_id}'],
    ],
  };

  const pairs = maps[platform] || [];
  let result = url;
  for (const [from, to] of pairs) {
    // Case-insensitive replace for bracket-style macros; exact for curly-brace
    result = result.split(from).join(to);
  }
  return result;
}

function normPayoutType(raw = '') {
  const t = raw.toLowerCase();
  if (t.includes('install') || t === 'cpi') return 'cpi';
  if (t.includes('lead')    || t === 'cpl') return 'cpl';
  if (t.includes('action')  || t === 'cpa') return 'cpa';
  if (t.includes('rev')     || t === 'revshare') return 'revshare';
  if (t.includes('click')   || t === 'cpc') return 'cpc';
  return 'cpi';
}

async function fetchEverflow(cred) {
  const base = cred.network_id
    ? `https://${cred.network_id}.api.eflow.team`
    : 'https://api.eflow.team';

  const res = await fetch(`${base}/v1/affiliates/offers?page=1&page_size=200`, {
    headers: { 'X-Eflow-API-Key': cred.api_key, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Everflow API error ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const offers = json.offers || json.data || json.results || [];

  return offers.map(o => {
    // Everflow: offer_url is the click tracking URL with their macros
    // preview_url is just the landing page
    const rawTracking = o.offer_url || o.click_url || o.tracking_url || o.preview_url || '';
    return {
      external_id:       String(o.network_offer_id || o.id || ''),
      name:              o.name || o.offer_name || 'Unnamed Offer',
      description:       o.description || o.offer_description || '',
      payout:            parseFloat(o.default_payout || o.payout || o.revenue_type?.payout || 0),
      payout_type:       normPayoutType(o.payout_type || o.revenue_type?.type || 'cpi'),
      currency:          o.currency || 'USD',
      status:            o.status === 1 || o.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'everflow'),
      preview_url:       o.preview_url || '',
      allowed_countries: Array.isArray(o.allowed_countries)
                           ? o.allowed_countries.join(',')
                           : (o.allowed_countries || ''),
      advertiser_name:   o.advertiser?.label || o.advertiser_name || '',
      categories:        (o.categories || []).map(c => c.label || c.name || c).join(', '),
      raw: o,
    };
  });
}

async function fetchTune(cred) {
  const rawNid = (cred.network_id || '').trim();
  const networkId = rawNid.includes('.') ? rawNid.split('.')[0] : rawNid;
  const base = `https://${networkId}.api.hasoffers.com`;

  const params = new URLSearchParams();
  params.append('NetworkId',        networkId);
  params.append('Target',           'Affiliate_Offer');
  params.append('Method',           'findAll');
  params.append('api_key',          cred.api_key);
  params.append('filters[status]',  'active');
  params.append('limit',            '200');

  // Request offer_url so we get the tracking link, not just the preview page
  const fields = ['id','name','description','default_payout','payout_type',
                  'currency','status','preview_url','offer_url','allowed_countries','advertiser_id'];
  fields.forEach(f => params.append('fields[]', f));

  const res = await fetch(`${base}/Apiv3/json?${params}`);
  if (!res.ok) throw new Error(`TUNE API error ${res.status}`);
  const json = await res.json();

  if (json.response?.status === -1) {
    const errMsg = json.response?.errors?.[0]?.publicMessage || json.response?.errorMessage || 'API error';
    throw new Error(`HasOffers: ${errMsg}`);
  }

  const raw = json.response?.data?.data || json.response?.data || {};
  const entries = Object.values(raw);

  return entries.map(entry => {
    const o   = entry.Offer || entry;
    const adv = entry.Advertiser || {};

    let countries = '';
    if (Array.isArray(o.allowed_countries)) countries = o.allowed_countries.join(',');
    else if (o.allowed_countries && typeof o.allowed_countries === 'object') countries = Object.values(o.allowed_countries).join(',');
    else if (typeof o.allowed_countries === 'string') countries = o.allowed_countries;

    // Build tracking URL. TUNE's offer_url is the affiliate click URL with {macros}.
    // Many TUNE networks don't return offer_url in field-filtered responses —
    // in that case we CONSTRUCT the standard HasOffers tracking URL ourselves.
    // Format: https://{network}.hasoffers.com/aff_c?offer_id=N&aff_id={affiliate_id}&transaction_id={transaction_id}
    let rawTracking = o.offer_url || '';
    const previewUrl = o.preview_url || '';

    if (!rawTracking || rawTracking === previewUrl) {
      // Derive the click-tracking base domain from the HasOffers network subdomain.
      // e.g. networkId="surfshark" → surfshark.hasoffers.com
      const trackingDomain = `${networkId}.hasoffers.com`;
      rawTracking = `https://${trackingDomain}/aff_c`
        + `?offer_id=${o.id}`
        + `&aff_id={affiliate_id}`
        + `&transaction_id={transaction_id}`
        + `&sub1={sub1}&sub2={sub2}&sub3={sub3}`;
    }

    return {
      external_id:       String(o.id || ''),
      name:              o.name || 'Unnamed Offer',
      description:       o.description || '',
      payout:            parseFloat(o.default_payout || o.payout || 0),
      payout_type:       normPayoutType(o.payout_type || o.revenue_type || 'cpa'),
      currency:          o.currency || 'USD',
      status:            o.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'tune'),
      preview_url:       previewUrl,
      allowed_countries: countries,
      advertiser_name:   adv.company || adv.name || o.advertiser_name || '',
      categories:        '',
      raw: entry,
    };
  });
}

async function fetchCityAds(cred) {
  const params = new URLSearchParams({ token: cred.api_key, limit: 200, offset: 0, language: 'en' });
  const res = await fetch(`https://api.cityads.com/api/rest/webmaster/v1/offers?${params}`);
  if (!res.ok) throw new Error(`CityAds API error ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`CityAds API: ${json.error}`);

  const offers = Array.isArray(json.offer) ? json.offer : [];
  const CURRENCY = { '1': 'RUB', '2': 'USD', '3': 'EUR', '4': 'GBP' };

  return offers.map(o => {
    const cd = o.commission_data || {};
    const currency = CURRENCY[cd.currency_id] || 'USD';

    let payout_type = 'cpa', payout = 0;
    if (cd.percent && (parseFloat(cd.percent.min) > 0 || parseFloat(cd.percent.max) > 0)) {
      payout_type = 'revshare';
      payout = parseFloat(cd.percent.max || cd.percent.min || 0);
    } else if (cd.amount && (parseFloat(cd.amount.min) > 0 || parseFloat(cd.amount.max) > 0)) {
      payout = parseFloat(cd.amount.max || cd.amount.min || 0);
    }

    // CityAds: affiliate_link or site_url is the tracking URL
    const rawTracking = o.affiliate_link || o.click_url || o.site_url || '';
    return {
      external_id:       String(o.id || ''),
      name:              o.name || o.translated_name || 'Unnamed Offer',
      description:       o.text || o.text_en || '',
      payout,
      payout_type,
      currency,
      status:            o.is_active === '1' && o.is_deleted === '0' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'cityads'),
      preview_url:       o.site_url || '',
      allowed_countries: '',
      advertiser_name:   String(o.advertiser || ''),
      categories:        '',
      raw: o,
    };
  });
}

async function fetchImpact(cred) {
  const accountSid = cred.api_key;
  const authToken  = cred.api_secret;
  if (!accountSid || !authToken)
    throw new Error('Impact requires Account SID (api_key) and Auth Token (api_secret)');

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const url = `https://api.impact.com/Mediapartners/${encodeURIComponent(accountSid)}/Campaigns?PageSize=200`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Impact API error ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const list = json.Campaigns || json.campaigns || json.data || [];

  return list.map(o => {
    // Impact: TrackingLink is the actual click tracking URL with [MACRO] syntax
    // LandingPageUrl is just the advertiser's landing page (no macros)
    const rawTracking = o.TrackingLink || o.tracking_link || o.TrackingUrl || o.LandingPageUrl || '';
    return {
      external_id:       String(o.Id || o.CampaignId || o.id || ''),
      name:              o.Name || o.CampaignName || o.name || 'Unnamed',
      description:       o.Description || o.description || '',
      payout:            parseFloat(o.DefaultPayout || o.Payout || o.payout || 0),
      payout_type:       normPayoutType(o.PayoutType || o.payout_type || 'cpa'),
      currency:          o.CurrencyCode || o.currency || 'USD',
      status:            String(o.Status || o.CampaignStatus || o.status || '').toLowerCase() === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'impact'),
      preview_url:       o.LandingPageUrl || o.preview_url || '',
      allowed_countries: Array.isArray(o.AllowedCountries)
                           ? o.AllowedCountries.join(',')
                           : (o.AllowedCountries || o.allowed_countries || ''),
      advertiser_name:   o.AdvertiserName || o.Advertiser || o.advertiser_name || '',
      categories:        (o.Categories || []).map(c => c.Name || c.name || c).join(', '),
      raw: o,
    };
  });
}

async function fetchAppsFlyer(cred) {
  const res = await fetch('https://hq1.appsflyer.com/api/partner-feed/v1/offers', {
    headers: { 'Authorization': `Bearer ${cred.api_key}` },
  });
  if (!res.ok) throw new Error(`AppsFlyer API error ${res.status}`);
  const json = await res.json();
  const offers = json.data || json.offers || [];
  return offers.map(o => {
    const rawTracking = o.tracking_url || o.click_url || o.store_url || o.preview_url || '';
    return {
      external_id:       String(o.id || o.offer_id || ''),
      name:              o.name || o.app_name || 'Unnamed',
      description:       o.description || '',
      payout:            parseFloat(o.payout || 0),
      payout_type:       normPayoutType(o.payout_type || 'cpi'),
      currency:          o.currency || 'USD',
      status:            'active',
      tracking_url:      toOurMacros(rawTracking, 'appsflyer'),
      preview_url:       o.store_url || o.preview_url || '',
      allowed_countries: (o.geo || []).join(','),
      advertiser_name:   o.advertiser_name || '',
      categories:        '',
      raw: o,
    };
  });
}

async function fetchSwaarm(cred) {
  // Swaarm Feed API v1.2
  // Endpoint : GET https://{network}.trckswrm.com/feed/v1.2/ads
  // Auth     : ?api_key={token}   (underscore, NOT "apiKey")
  // Response : { ads: [ Ad, ... ], publisher: { id, subSources } }
  //
  // credentials:
  //   api_key    = API token  (e.g. 6ca30b57-c78f-4b7a-a643-f8c8a99803de)
  //   network_id = subdomain  (e.g. "pokkt" from pokkt.trckswrm.com)

  if (!cred.api_key) throw new Error('Swaarm: API Key is required');

  // Accept "pokkt", "pokkt.trckswrm.com", full URL — extract just the first label
  const rawNid    = (cred.network_id || '').trim().toLowerCase();
  const networkId = rawNid.replace(/^https?:\/\//, '').split('.')[0];
  if (!networkId) throw new Error('Swaarm: Network Domain is required (e.g. "pokkt")');

  const url = `https://${networkId}.trckswrm.com/feed/v1.2/ads?api_key=${encodeURIComponent(cred.api_key)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Swaarm API error ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();

  // Response: { ads: [...], publisher: {...} }
  const adList = json?.ads || (Array.isArray(json) ? json : []);
  if (!Array.isArray(adList)) {
    throw new Error(`Swaarm: unexpected response — ${JSON.stringify(json).slice(0, 200)}`);
  }

  return adList.map(o => {
    // click_url comes pre-built with this publisher's pub_id hardcoded, e.g.:
    //   https://pokkt.trckswrm.com/click?offer_id=3814&pub_id=1068
    // There is no click_id macro — append sub1 so we can track our click IDs.
    let rawTracking = o.click_url || o.clickUrl || '';

    if (!rawTracking) {
      // Fallback: construct standard Swaarm click URL
      rawTracking = `https://${networkId}.trckswrm.com/click?offer_id=${o.id || ''}`;
    }
    // Append our click tracking params (sub1 = click_id, sub2/sub3 passthrough)
    rawTracking += (rawTracking.includes('?') ? '&' : '?')
      + 'sub1={click_id}&sub2={sub2}&sub3={sub3}';

    // Geo targeting → comma-separated country list
    const geoAllowed = o.targeting?.allowedGeoTargeting?.countries || [];
    const countries  = Array.isArray(geoAllowed) ? geoAllowed.join(',') : '';

    // leadflow: "CPI" = paid on install, "CPA" = paid on action
    const payType = normPayoutType(o.leadflow || o.payout_type || 'cpi');

    // OS platform from device targeting
    const osRaw = o.targeting?.allowedDeviceTargeting?.os || '';
    const platform = osRaw.toLowerCase() === 'ios' ? 'ios'
                   : osRaw.toLowerCase() === 'android' ? 'android'
                   : '';

    return {
      external_id:       String(o.id || ''),
      name:              o.name || o.app_title || 'Unnamed',
      description:       o.description || o.app_description || '',
      payout:            parseFloat(o.payout || 0),
      payout_type:       payType,
      currency:          o.payout_currency || 'USD',
      status:            'active',   // feed only returns available (active) ads
      tracking_url:      rawTracking,
      preview_url:       o.preview_url || '',
      allowed_countries: countries,
      advertiser_name:   '',         // not in feed response
      categories:        Array.isArray(o.app_categories) ? o.app_categories.join(', ') : (platform ? platform.toUpperCase() : ''),
      raw: o,
    };
  });
}

const ADAPTERS = { everflow: fetchEverflow, tune: fetchTune, appsflyer: fetchAppsFlyer, cityads: fetchCityAds, impact: fetchImpact, swaarm: fetchSwaarm };

/* ─── POST /api/integrations/fetch-offers ───────────────────────────────────── */
router.post('/fetch-offers', async (req, res, next) => {
  try {
    const { credential_id } = req.body;
    if (!credential_id) return res.status(400).json({ error: 'credential_id required' });

    const cred = db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?')
                   .get(credential_id);
    if (!cred) return res.status(404).json({ error: 'Credentials not found' });

    const adapter = ADAPTERS[cred.platform];
    if (!adapter) {
      return res.status(400).json({
        error: `No API adapter for platform "${cred.platform}". Supported: ${Object.keys(ADAPTERS).join(', ')}`,
      });
    }

    const offers = await adapter(cred);

    // ── Build importedMap: offer external_id → campaign on our platform ──────────
    // Two-pass lookup so campaigns imported before source_credential_id existed
    // (those with NULL source_credential_id) are still found via name match.
    const autoPaused      = [];
    const autoResumed     = [];
    const trackingUpdated = [];
    const importedMap     = {}; // external_offer_id → { id, status, campaign_token, name }

    try {
      // Pass 1: campaigns explicitly linked to this credential
      const byCredential = db.prepare(`
        SELECT id, name, external_offer_id, status, campaign_token
        FROM campaigns
        WHERE source_credential_id = ? AND status != 'archived'
      `).all(credential_id);

      for (const c of byCredential) {
        if (c.external_offer_id) {
          importedMap[String(c.external_offer_id)] = {
            id: c.id, status: c.status, campaign_token: c.campaign_token, name: c.name,
          };
        }
      }

      // Pass 2: name-match for campaigns imported before source_credential_id tracking
      // (one batch query — not one per offer)
      const unmappedNames = offers
        .filter(o => !importedMap[String(o.external_id)])
        .map(o => o.name);

      if (unmappedNames.length > 0) {
        const ph = unmappedNames.map(() => '?').join(',');
        const byName = db.prepare(
          `SELECT id, name, status, campaign_token FROM campaigns
           WHERE name IN (${ph}) AND status != 'archived'`
        ).all(...unmappedNames);

        for (const c of byName) {
          const offer = offers.find(o => o.name === c.name);
          if (offer && !importedMap[String(offer.external_id)]) {
            importedMap[String(offer.external_id)] = {
              id: c.id, status: c.status, campaign_token: c.campaign_token, name: c.name,
            };
          }
        }
      }

      // ── Auto-sync: pause/resume campaigns + update tracking URLs ────────────
      const activeOfferIds = new Set(
        offers.filter(o => o.status === 'active').map(o => String(o.external_id))
      );
      // Build a map of external_id → offer so we can get tracking_url per offer
      const offerById = {};
      for (const o of offers) offerById[String(o.external_id)] = o;

      for (const [extId, camp] of Object.entries(importedMap)) {
        const nowActive = activeOfferIds.has(extId);
        const offer     = offerById[extId];

        // Status sync
        if (!nowActive && camp.status === 'active') {
          db.prepare("UPDATE campaigns SET status='paused', updated_at=unixepoch() WHERE id=?").run(camp.id);
          importedMap[extId].status = 'paused';
          autoPaused.push({ id: camp.id, name: camp.name });
        } else if (nowActive && camp.status === 'paused') {
          db.prepare("UPDATE campaigns SET status='active', updated_at=unixepoch() WHERE id=?").run(camp.id);
          importedMap[extId].status = 'active';
          autoResumed.push({ id: camp.id, name: camp.name });
        }

        // Tracking URL sync: update destination_url if the platform gave us a tracking URL
        // and it differs from what is currently stored
        if (offer && offer.tracking_url) {
          const existing = db.prepare('SELECT destination_url FROM campaigns WHERE id=?').get(camp.id);
          if (existing && existing.destination_url !== offer.tracking_url) {
            db.prepare("UPDATE campaigns SET destination_url=?, updated_at=unixepoch() WHERE id=?")
              .run(offer.tracking_url, camp.id);
            importedMap[extId].tracking_url = offer.tracking_url;
            trackingUpdated.push({ id: camp.id, name: camp.name, tracking_url: offer.tracking_url });
          }
        }
      }
    } catch (syncErr) {
      console.warn('[sync] skipped:', syncErr.message);
    }

    res.json({
      offers, platform: cred.platform, label: cred.label, total: offers.length,
      sync: { paused: autoPaused, resumed: autoResumed, tracking_updated: trackingUpdated },
      imported_map: importedMap,
    });
  } catch (err) {
    // Return a clean error to the frontend instead of crashing
    res.status(502).json({ error: err.message || 'Failed to fetch offers from platform' });
  }
});

/* ─── POST /api/integrations/set-campaign-status ────────────────────────────── */
// Pause or resume a specific imported campaign by its external offer ID.
// Works for every platform — the link is stored in source_credential_id + external_offer_id.
router.post('/set-campaign-status', (req, res, next) => {
  try {
    const { credential_id, external_offer_id, campaign_id, status } = req.body;
    if (!status || !['active', 'paused'].includes(status))
      return res.status(400).json({ error: 'status must be "active" or "paused"' });

    // Look up by campaign_id (fastest) or by credential+external_offer_id
    let camp;
    if (campaign_id) {
      camp = db.prepare('SELECT id, status FROM campaigns WHERE id = ?').get(campaign_id);
    } else if (credential_id && external_offer_id) {
      camp = db.prepare(
        'SELECT id, status FROM campaigns WHERE source_credential_id = ? AND external_offer_id = ?'
      ).get(credential_id, String(external_offer_id));
    }

    if (!camp) return res.status(404).json({ error: 'Campaign not found' });

    db.prepare("UPDATE campaigns SET status=?, updated_at=unixepoch() WHERE id=?").run(status, camp.id);
    res.json({ success: true, campaign_id: camp.id, status });
  } catch (err) { next(err); }
});

/* ─── POST /api/integrations/import ─────────────────────────────────────────── */
router.post('/import', (req, res, next) => {
  try {
    const {
      offers, advertiser_id, credential_id, advertiser_name: batchAdvName,
      // Visibility + publisher payout settings applied to every imported offer
      visibility = 'open',
      publisher_payout_pct,    // e.g. 80 → pub gets 80% of advertiser payout
      publisher_payout: fixedPubPayout, // fixed amount override (used when pct is not set)
      publisher_payout_type,   // payout type override (defaults to same as offer payout_type)
      approved_publishers = [], // publisher IDs to pre-approve on every imported campaign
    } = req.body;
    if (!Array.isArray(offers) || offers.length === 0)
      return res.status(400).json({ error: 'offers array is required' });

    const cred = credential_id
      ? db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(credential_id)
      : null;

    const imported = [];
    const skipped  = [];

    // Resolve advertiser: explicit advertiser_id > credential's advertiser_id > null
    const resolvedAdvertiserId = advertiser_id || cred?.advertiser_id || null;
    // Advertiser name fallback chain:
    //   1. batchAdvName  — explicitly passed from the UI (Offer Import "Advertiser Name" field)
    //   2. offer.advertiser_name — per-offer name from the platform API
    //   3. cred.label    — saved credential label (e.g. "Surfshark")
    //   4. cred.platform — platform name (e.g. "tune", "everflow") as last resort
    const credAdvertiserName = cred?.label || null;
    const platformFallback = cred?.platform
      ? cred.platform.charAt(0).toUpperCase() + cred.platform.slice(1)
      : null;

    const resolvedVisibility = ['open','approval_required','private'].includes(visibility) ? visibility : 'open';

    // Helper: pre-approve publishers for a campaign
    const upsertApproval = db.prepare(`
      INSERT INTO campaign_access_requests (campaign_id, publisher_id, user_id, status, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, 'approved', ?, unixepoch())
      ON CONFLICT(campaign_id, publisher_id) DO UPDATE SET
        status = 'approved', reviewed_by = excluded.reviewed_by, reviewed_at = unixepoch()
    `);
    function applyApprovedPublishers(campaignId) {
      if (!Array.isArray(approved_publishers) || approved_publishers.length === 0) return;
      for (const pubId of approved_publishers) upsertApproval.run(campaignId, pubId, req.user.id, req.user.id);
    }

    const insertCampaign = db.prepare(`
      INSERT INTO campaigns
        (user_id, advertiser_id, name, advertiser_name, campaign_token, security_token,
         payout, payout_type, publisher_payout, publisher_payout_type,
         destination_url, preview_url, allowed_countries, visibility, status,
         source_credential_id, external_offer_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `);

    const updateCampaign = db.prepare(`
      UPDATE campaigns SET
        status = 'active',
        advertiser_name = COALESCE(?, advertiser_name),
        payout = COALESCE(?, payout),
        payout_type = COALESCE(?, payout_type),
        publisher_payout = COALESCE(?, publisher_payout),
        publisher_payout_type = COALESCE(?, publisher_payout_type),
        destination_url = COALESCE(?, destination_url),
        preview_url = COALESCE(?, preview_url),
        allowed_countries = COALESCE(?, allowed_countries),
        visibility = COALESCE(?, visibility),
        source_credential_id = COALESCE(?, source_credential_id),
        external_offer_id = COALESCE(?, external_offer_id),
        tags = COALESCE(?, tags),
        updated_at = unixepoch()
      WHERE id = ?
    `);

    for (const offer of offers) {
      const advName = batchAdvName || offer.advertiser_name || credAdvertiserName || platformFallback || null;
      const destUrl = offer.tracking_url || null;   // tracking URL only — never fall back to preview
      const prevUrl = offer.preview_url || null;
      const advPayout = offer.payout || 0;

      // Publisher payout: percentage mode takes priority, then fixed, then 0
      let pubPayout = 0;
      if (publisher_payout_pct != null && publisher_payout_pct !== '') {
        pubPayout = Math.round(advPayout * Number(publisher_payout_pct) / 100 * 100) / 100;
      } else if (fixedPubPayout != null && fixedPubPayout !== '') {
        pubPayout = Number(fixedPubPayout);
      }
      const pubPayoutType = publisher_payout_type || offer.payout_type || 'cpi';

      // Check if a campaign with same name already exists (active OR archived)
      const exists = db.prepare('SELECT id, status FROM campaigns WHERE name = ?').get(offer.name);

      if (exists) {
        if (exists.status === 'archived') {
          // Re-activate the archived campaign and refresh its details
          updateCampaign.run(
            advName,
            advPayout != null ? advPayout : null,
            offer.payout_type || null,
            pubPayout != null ? pubPayout : null,
            pubPayoutType || null,
            destUrl,
            prevUrl,
            offer.allowed_countries || null,
            resolvedVisibility,
            credential_id || null,
            offer.external_id || null,
            offer.categories || null,
            exists.id,
          );
          const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(exists.id);
          applyApprovedPublishers(exists.id);
          imported.push({ id: exists.id, name: offer.name, campaign_token: campaign.campaign_token, campaign, reactivated: true });
        } else {
          // Active/paused campaign — skip to avoid duplicates
          skipped.push({ name: offer.name, reason: 'already exists and is active' });
        }
        continue;
      }

      const token = nanoid12();
      const secToken = nanoid20hex();

      const result = insertCampaign.run(
        req.user.id,
        resolvedAdvertiserId,
        offer.name,
        advName,
        token,
        secToken,
        advPayout,
        offer.payout_type || 'cpi',
        pubPayout,
        pubPayoutType,
        destUrl,
        prevUrl || '',
        offer.allowed_countries || '',
        resolvedVisibility,
        credential_id || null,
        offer.external_id || null,
        offer.categories || '',
      );
      const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid);
      applyApprovedPublishers(result.lastInsertRowid);
      imported.push({ id: result.lastInsertRowid, name: offer.name, campaign_token: token, campaign });
    }

    const reactivated = imported.filter(i => i.reactivated);
    res.json({
      imported,
      skipped,
      total_imported: imported.length,
      total_reactivated: reactivated.length,
      reactivated,
    });
  } catch (err) { next(err); }
});

module.exports = router;
