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
const { normCurrency } = require('../utils/connectors/base');

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
function toOurMacros(url, platform, options = {}) {
  if (!url) return url;

  // If a fixed affiliate_id is provided (e.g. Apogeemobi's registered ID in a network),
  // embed it directly so it is never resolved as a dynamic macro.
  // Otherwise fall back to {pid} which track.js will substitute with the publisher token.
  const affiliateTarget = options.affiliate_id || '{pid}';

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
      // Everflow uses {macro} format — just rename their macros to ours.
      // {affiliate_id} is replaced with the fixed registered affiliate ID (from credentials),
      // or falls back to {pid} if no affiliate_id is configured.
      ['{transaction_id}',  '{click_id}'],
      ['{affiliate_id}',    affiliateTarget],
      ['{offer_id}',        '{campaign_id}'],
      ['{creative_id}',     '{creative_id}'],
      // sub1-sub5 already match, advertising_id already matches
    ],
    tune: [
      // Same treatment as Everflow: aff_id needs Apogeemobi's fixed affiliate account ID,
      // NOT the publisher token. Use affiliateTarget (fixed value or {pid} fallback).
      ['{transaction_id}',  '{click_id}'],
      ['{affiliate_id}',    affiliateTarget],
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
    admitad: [
      // Admitad deeplink subid params — these are already embedded as query params
      // when we construct the deeplink URL; no macro replacement needed here.
      // This entry is a no-op placeholder kept for consistency.
    ],
    trackier: [
      // Trackier convention: click_id is passed as &p1=, returned in postbacks as {p1}
      ['{your-transaction-id}', '{click_id}'],
      ['{your-click-id}',       '{click_id}'],
      ['{p1}',                  '{click_id}'],   // platform-side placeholder
      ['{your-sub-aff-id}',     '{pid}'],
      ['{sub-aff-id}',          '{pid}'],
      ['{source}',              '{pid}'],
      ['{p2}',                  '{sub1}'],
      ['{p3}',                  '{sub2}'],
      ['{gaid}',                '{gaid}'],
      ['{idfa}',                '{idfa}'],
    ],
    affise: [
      // Affise has NO click_id macro — convention is to pass click_id as {sub1}.
      // We rewrite Affise's typical placeholders to our macros and rely on the
      // auto-inject below to append &sub1={click_id} if not already present.
      ['{sub1}',          '{click_id}'],   // sub1 carries click_id by convention
      ['{sub2}',          '{sub1}'],
      ['{sub3}',          '{sub2}'],
      ['{partner_id}',    '{pid}'],
      ['{pid}',           '{pid}'],
      ['{gaid}',          '{gaid}'],
      ['{idfa}',          '{idfa}'],
      ['{country_code}',  '{country}'],
    ],
    clickdealer: [
      // ClickDealer is CAKE — same macros as Insparx/CAKE generic.
      // CAKE convention: click_id passed as &s2=, returned in postbacks as #s2#.
      ['#s2#',                '{click_id}'],
      ['{s2}',                '{click_id}'],
      ['#requested_action_id#','{goal_value}'],
      ['#price#',             '{payout}'],
      ['#received_amount#',   '{revenue}'],
      ['#s3#',                '{gaid}'],
      ['{s3}',                '{gaid}'],
      ['#s4#',                '{idfa}'],
      ['{s4}',                '{idfa}'],
      ['#s5#',                '{sub1}'],
      ['{s5}',                '{sub1}'],
      ['#affiliate_id#',      affiliateTarget],
      ['{affiliate_id}',      affiliateTarget],
    ],
    cake: [
      // Same as ClickDealer — every CAKE-powered network follows this macro convention.
      ['#s2#',                '{click_id}'],
      ['{s2}',                '{click_id}'],
      ['#requested_action_id#','{goal_value}'],
      ['#price#',             '{payout}'],
      ['#received_amount#',   '{revenue}'],
      ['#s3#',                '{gaid}'],
      ['{s3}',                '{gaid}'],
      ['#s4#',                '{idfa}'],
      ['{s4}',                '{idfa}'],
      ['#s5#',                '{sub1}'],
      ['{s5}',                '{sub1}'],
      ['#affiliate_id#',      affiliateTarget],
      ['{affiliate_id}',      affiliateTarget],
    ],
    zeydoo: [
      // Zeydoo SSP — macro convention is NOT documented in the OpenAPI spec.
      // Defaulting to common SSP convention (clickid) — UPDATE THIS once
      // Zeydoo AM confirms the actual postback macro name.
      ['{clickid}',     '{click_id}'],
      ['{click_id}',    '{click_id}'],
      ['{request_id}',  '{click_id}'],   // alt common SSP convention
      ['{transaction_id}', '{click_id}'],
      ['{zone_id}',     '{campaign_id}'],
      ['{sub_id}',      '{sub1}'],
      ['{sub1}',        '{sub1}'],
      ['{country}',     '{country}'],
    ],
  };

  const pairs = maps[platform] || [];
  let result = url;
  for (const [from, to] of pairs) {
    // Case-insensitive replace for bracket-style macros; exact for curly-brace
    result = result.split(from).join(to);
  }

  // If {click_id} is still not in the URL after macro conversion, auto-inject it
  // using the canonical click_id param name for this platform.
  if (result && !result.includes('{click_id}')) {
    const clickIdParams = {
      impact:      'irclickid={click_id}',
      everflow:    'transaction_id={click_id}',
      tune:        'transaction_id={click_id}',
      cityads:     'click_id={click_id}',
      appsflyer:   'clickid={click_id}',
      swaarm:      'pub_click_id={click_id}',
      admitad:     'subid={click_id}',
      trackier:    'p1={click_id}',           // Trackier's click_id convention
      affise:      'sub1={click_id}',         // Affise has no click_id macro; sub1 carries it
      clickdealer: 's2={click_id}',           // CAKE convention
      cake:        's2={click_id}',           // CAKE convention (any CAKE-powered network)
      zeydoo:      'clickid={click_id}',      // DEFAULT — verify with Zeydoo AM / help.zeydoo.com
    };
    const param = clickIdParams[platform];
    if (param) {
      result = result + (result.includes('?') ? '&' : '?') + param;
    }
  }

  return result;
}

// Phase A: surface per-offer approval state so Discovery Hub can distinguish
// "we're not yet approved on this" from "platform doesn't expose a URL" and
// from "URL is broken". Values: 'approved' | 'pending' | 'rejected' | 'unknown'.
//
// Each platform exposes the signal under a different name; this normalizer
// folds them into one vocabulary. When the platform's signal is absent or
// unrecognized, default to 'unknown' so we never falsely claim approval.
function normApprovalStatus(value, customMap = {}) {
  if (value == null || value === '') return 'unknown';
  const v = String(value).trim().toLowerCase();
  if (customMap[v]) return customMap[v];
  if (['approved', 'active', 'joined', 'connected', 'public'].includes(v)) return 'approved';
  if (['pending', 'application received', 'awaiting approval', 'pendingapproval', 'requires_attention', 'unblocked'].includes(v)) return 'pending';
  if (['rejected', 'declined', 'denied', 'blocked', 'banned'].includes(v)) return 'rejected';
  return 'unknown';
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
  // Parse affiliate_id from extra config — Apogeemobi's registered affiliate ID in this network.
  let extraCfgEf = {};
  try { extraCfgEf = JSON.parse(cred.extra || '{}'); } catch {}
  const efAffiliateId = extraCfgEf.affiliate_id || '';

  // Everflow API is always api.eflow.team regardless of network/white-label name.
  // network_id is an internal label only — not a subdomain.
  // EU accounts use api-eu.eflow.team — detect by checking if network_id contains 'eu'
  const isEU = (cred.network_id || '').toLowerCase().includes('eu');
  const base = isEU ? 'https://api-eu.eflow.team' : 'https://api.eflow.team';

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
      currency:          normCurrency(o.currency),
      status:            o.status === 1 || o.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'everflow', { affiliate_id: efAffiliateId }),
      preview_url:       o.preview_url || '',
      allowed_countries: Array.isArray(o.allowed_countries)
                           ? o.allowed_countries.join(',')
                           : (o.allowed_countries || ''),
      advertiser_name:   o.advertiser?.label || o.advertiser_name || '',
      categories:        (o.categories || []).map(c => c.label || c.name || c).join(', '),
      // Everflow: relationship object signals affiliate↔offer status
      approval_status:   normApprovalStatus(o.relationship?.status || o.relationship_status),
      raw: o,
    };
  });
}

async function fetchTune(cred) {
  // Parse affiliate_id from the extra JSON field.
  // This is Apogeemobi's registered affiliate account ID in this HasOffers network
  // (e.g. the numeric ID shown in the HasOffers dashboard as "Your Affiliate ID").
  // It is embedded directly in the aff_id param — NOT treated as a dynamic macro.
  let extraCfg = {};
  try { extraCfg = JSON.parse(cred.extra || '{}'); } catch {}
  const affiliateId = extraCfg.affiliate_id || '';

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
      // aff_id: use the fixed affiliate ID from credentials if set (preferred),
      // otherwise fall back to {pid} which track.js replaces with the publisher token.
      // NOTE: HasOffers requires a valid registered numeric affiliate ID here.
      const affIdParam = affiliateId || '{pid}';
      rawTracking = `https://${trackingDomain}/aff_c`
        + `?offer_id=${o.id}`
        + `&aff_id=${affIdParam}`
        + `&transaction_id={transaction_id}`
        + `&sub1={sub1}&sub2={sub2}&sub3={sub3}&sub4={sub4}&sub5={sub5}`;
    }

    return {
      external_id:       String(o.id || ''),
      name:              o.name || 'Unnamed Offer',
      description:       o.description || '',
      payout:            parseFloat(o.default_payout || o.payout || 0),
      payout_type:       normPayoutType(o.payout_type || o.revenue_type || 'cpa'),
      currency:          normCurrency(o.currency),
      status:            o.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'tune', { affiliate_id: affiliateId }),
      preview_url:       previewUrl,
      allowed_countries: countries,
      advertiser_name:   adv.company || adv.name || o.advertiser_name || '',
      categories:        '',
      // TUNE: per-affiliate approval lives on AffiliateOffer/findAll, not on
      // Offer/findAll which this fetcher uses. Mark unknown until the affiliate
      // endpoint is wired in (Phase A.1 follow-up). HasOffers' click handler
      // will gracefully reject unauthorized clicks at runtime.
      approval_status:   'unknown',
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
    const currency = normCurrency(CURRENCY[cd.currency_id]);

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
      // CityAds doesn't expose per-publisher approval in the basic feed.
      approval_status:   'unknown',
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
      currency:          normCurrency(o.CurrencyCode, o.currency),
      status:            String(o.Status || o.CampaignStatus || o.status || '').toLowerCase() === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'impact'),
      preview_url:       o.LandingPageUrl || o.preview_url || '',
      allowed_countries: Array.isArray(o.AllowedCountries)
                           ? o.AllowedCountries.join(',')
                           : (o.AllowedCountries || o.allowed_countries || ''),
      advertiser_name:   o.AdvertiserName || o.Advertiser || o.advertiser_name || '',
      categories:        (o.Categories || []).map(c => c.Name || c.name || c).join(', '),
      // Impact: ContractStatus is the publisher↔campaign contract state.
      // "Active" = approved, "Application Received"/"Pending" = pending, "Declined" = rejected.
      approval_status:   normApprovalStatus(o.ContractStatus || o.contract_status),
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
      currency:          normCurrency(o.currency),
      status:            'active',
      tracking_url:      toOurMacros(rawTracking, 'appsflyer'),
      preview_url:       o.store_url || o.preview_url || '',
      allowed_countries: (o.geo || []).join(','),
      advertiser_name:   o.advertiser_name || '',
      categories:        '',
      // AppsFlyer partner-feed is pre-scoped to your partnership — if it's in
      // the feed, you're approved to promote.
      approval_status:   'approved',
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
      currency:          normCurrency(o.payout_currency),
      status:            'active',   // feed only returns available (active) ads
      tracking_url:      rawTracking,
      preview_url:       o.preview_url || '',
      allowed_countries: countries,
      advertiser_name:   '',         // not in feed response
      categories:        Array.isArray(o.app_categories) ? o.app_categories.join(', ') : (platform ? platform.toUpperCase() : ''),
      // Swaarm feed is publisher-scoped — every ad returned is available to
      // promote with this api_key. No per-ad approval handshake.
      approval_status:   'approved',
      raw: o,
    };
  });
}

async function fetchAdmitad(cred) {
  // ── Admitad OAuth2 client_credentials token fetch ──────────────────────────
  // cred.api_key    = client_id
  // cred.api_secret = client_secret
  // extra.website_id = Apogeemobi's Admitad publisher website ID (for deeplinks)
  const clientId     = cred.api_key;
  const clientSecret = cred.api_secret;
  if (!clientId || !clientSecret)
    throw new Error('Admitad requires Client ID (api_key) and Client Secret (api_secret)');

  const base64Auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let extraCfg = {};
  try { extraCfg = JSON.parse(cred.extra || '{}'); } catch {}
  const websiteId = extraCfg.website_id || '';

  // Step 1 — get Bearer token
  const tokenRes = await fetch('https://api.admitad.com/token/', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${base64Auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&scope=advcampaigns+statistics`,
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => '');
    throw new Error(`Admitad token error ${tokenRes.status}: ${txt.slice(0, 300)}`);
  }
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error('Admitad: no access_token in response');

  // Step 2 — fetch campaigns (advcampaigns) the publisher is approved for
  // NOTE: Admitad API is slow (~3-10s per page). To avoid server timeouts we
  // fetch a single page of 200 which covers all practical use cases.
  const limit = 200;
  const campRes = await fetch(
    `https://api.admitad.com/advcampaigns/?limit=${limit}&offset=0&language=en`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' } },
  );
  if (!campRes.ok) {
    const txt = await campRes.text().catch(() => '');
    throw new Error(`Admitad campaigns error ${campRes.status}: ${txt.slice(0, 300)}`);
  }
  const campData = await campRes.json();
  const allOffers = campData.results || campData.campaigns || [];

  return allOffers.map(o => {
    // ── Payout: pick the highest-value action from the actions[] array ──────
    // payment_size can be: "1.50" (fixed), "9.34-15.60%" (revshare range), "10%" (revshare)
    // Action-level currency wins over campaign-level (Admitad campaigns often
    // default to USD even when individual actions are in EUR/GBP/etc.)
    let payout          = 0;
    let payout_type     = 'cpa';
    let payout_currency = null;
    const actions   = Array.isArray(o.actions) ? o.actions : [];
    for (const act of actions) {
      const raw = String(act.payment_size || act.payout || '0');
      const isPercent = raw.includes('%');
      // For ranges like "9.34-15.60%", take the higher end: split by '-', take last number
      const parts  = raw.replace('%', '').split('-');
      const amount = parseFloat(parts[parts.length - 1] || parts[0] || '0') || 0;
      const type   = isPercent ? 'revshare' : normPayoutType(act.type || 'cpa');
      if (amount > payout) {
        payout          = amount;
        payout_type     = type;
        payout_currency = act.currency || act.payment_currency || null;
      }
    }

    // ── Tracking URL: Admitad deeplink format ────────────────────────────────
    // If we have a website_id we build the full deeplink URL with our macros.
    // Otherwise we use the site_url as a plain destination with a note that
    // the user should configure their Admitad website ID in credentials.
    let tracking_url = '';
    if (websiteId && o.id) {
      // Admitad deeplink: subid is the primary passthrough for our click_id
      tracking_url = `https://ad.admitad.com/g/${websiteId}/${o.id}/`
        + `?subid={click_id}&subid1={sub1}&subid2={sub2}&subid3={sub3}`;
    } else {
      // Fallback: direct site URL — still inject subid={click_id} so attribution works
      const fallbackUrl = o.site_url || '';
      if (fallbackUrl && !fallbackUrl.includes('{click_id}')) {
        tracking_url = fallbackUrl + (fallbackUrl.includes('?') ? '&' : '?') + 'subid={click_id}';
      } else {
        tracking_url = fallbackUrl;
      }
    }

    // ── Geo: geotargeting.allow[] is array of ISO-2 codes ───────────────────
    let countries = '';
    try {
      const geo = o.geotargeting || {};
      if (Array.isArray(geo.allow))         countries = geo.allow.join(',');
      else if (Array.isArray(geo.allowed))  countries = geo.allowed.join(',');
    } catch {}

    // ── Status ───────────────────────────────────────────────────────────────
    const status = (String(o.status || '').toLowerCase() === 'active' ||
                    o.is_active === true || o.is_active === 1) ? 'active' : 'paused';

    return {
      external_id:       String(o.id || ''),
      name:              o.name || 'Unnamed Offer',
      description:       o.description || o.short_description || '',
      payout,
      payout_type,
      // Action-level currency wins; falls back to campaign-level then USD.
      currency:          normCurrency(payout_currency, o.currency),
      status,
      tracking_url,
      preview_url:       o.site_url || '',
      allowed_countries: countries,
      advertiser_name:   o.company || o.advertiser || 'Admitad',
      categories:        Array.isArray(o.categories)
                           ? o.categories.map(c => c.name || c).join(', ')
                           : '',
      // Admitad: connection_status is the publisher↔advertiser handshake state.
      // 'connected' = approved, 'pending' / 'requires_attention' = pending,
      // anything else (e.g. 'not_connected') = pending application.
      approval_status:   normApprovalStatus(o.connection_status, { not_connected: 'pending' }),
      raw: o,
    };
  });
}

/**
 * Insparx (CAKE Affiliate Platform) — Offer Import adapter
 *
 * Reuses the live-tested CAKE connector at utils/connectors/insparx.js so we
 * don't duplicate the OfferFeed XML-parsing logic. That module is already
 * verified against affiliate_id 18518 (318 offers fetched).
 *
 * cred.api_key    = Insparx API Key
 * cred.network_id = Insparx Affiliate ID
 */
async function fetchInsparx(cred) {
  if (!cred?.api_key || !cred?.network_id) {
    throw new Error('Insparx requires API Key and Affiliate ID');
  }
  const Insparx = require('../utils/connectors/insparx');
  const rawOffers = await Insparx.listOffers(cred);
  return rawOffers.map(raw => {
    const norm = Insparx.normalizeOffer(raw, cred);
    return {
      external_id:       norm.source_offer_id,
      name:              norm.name,
      description:       norm.description || '',
      payout:            norm.payout || 0,
      payout_type:       norm.payout_type || 'cpa',
      currency:          normCurrency(norm.payout_currency),
      status:            (norm.status === 'active' || norm.status === 'public') ? 'active' : 'paused',
      tracking_url:      norm.tracking_url_template || '',
      preview_url:       norm.preview_url || norm.destination_url || '',
      allowed_countries: (norm.allowed_countries || []).join(','),
      advertiser_name:   norm.advertiser_name || 'Insparx',
      categories:        norm.vertical || '',
      // CAKE OfferFeed doesn't expose affiliate_offer_status — we'd need to
      // hit OfferSummary per offer to learn approval state (Phase B).
      approval_status:   norm.approval_status || 'unknown',
      raw:               raw,
    };
  });
}

async function fetchTrackier(cred) {
  if (!cred?.api_key) {
    throw new Error('Trackier requires API Key');
  }
  const Trackier = require('../utils/connectors/trackier');
  const rawOffers = await Trackier.listOffers(cred);
  return rawOffers.map(raw => {
    const norm = Trackier.normalizeOffer(raw, cred);
    const rawTracking = norm.tracking_url_template || '';
    return {
      external_id:       norm.source_offer_id,
      name:              norm.name,
      description:       norm.description || '',
      payout:            norm.payout || 0,
      payout_type:       norm.payout_type || 'cpa',
      currency:          normCurrency(norm.payout_currency),
      status:            norm.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'trackier'),
      preview_url:       norm.preview_url || norm.destination_url || '',
      allowed_countries: (norm.allowed_countries || []).join(','),
      advertiser_name:   norm.advertiser_name || 'Trackier',
      categories:        norm.vertical || '',
      approval_status:   norm.approval_status || 'approved',
      raw,
    };
  });
}

async function fetchAffise(cred) {
  if (!cred?.api_key) {
    throw new Error('Affise requires API Key');
  }
  // base_url may be stored either at the top level (legacy) or in the `extra`
  // JSON blob (current — buildExtra packs custom fields there). Hoist into the
  // top-level cred so the connector class can read it uniformly.
  const extra = cred.extra ? (typeof cred.extra === 'string' ? (() => { try { return JSON.parse(cred.extra); } catch { return {}; } })() : cred.extra) : {};
  if (!cred.base_url && extra.base_url) cred.base_url = extra.base_url;
  if (!cred.base_url) {
    throw new Error('Affise requires API URL (base_url) — re-save the credential with API URL field filled in');
  }
  const Affise = require('../utils/connectors/affise');
  const rawOffers = await Affise.listOffers(cred);
  return rawOffers.map(raw => {
    const norm = Affise.normalizeOffer(raw, cred);
    const rawTracking = norm.tracking_url_template || '';
    return {
      external_id:       norm.source_offer_id,
      name:              norm.name,
      description:       norm.description || '',
      payout:            norm.payout || 0,
      payout_type:       norm.payout_type || 'cpa',
      currency:          normCurrency(norm.payout_currency),
      status:            norm.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'affise'),
      preview_url:       norm.preview_url || norm.destination_url || '',
      allowed_countries: (norm.allowed_countries || []).join(','),
      advertiser_name:   norm.advertiser_name || 'Affise',
      categories:        norm.vertical || '',
      approval_status:   norm.approval_status || 'unknown',
      raw,
    };
  });
}

async function fetchClickDealer(cred) {
  if (!cred?.api_key || !cred?.network_id) {
    throw new Error('ClickDealer requires API Key and Affiliate ID');
  }
  const ClickDealer = require('../utils/connectors/clickdealer');
  const rawOffers = await ClickDealer.listOffers(cred);
  return rawOffers.map(raw => {
    const norm = ClickDealer.normalizeOffer(raw, cred);
    const rawTracking = norm.tracking_url_template || '';
    return {
      external_id:       norm.source_offer_id,
      name:              norm.name,
      description:       norm.description || '',
      payout:            norm.payout || 0,
      payout_type:       norm.payout_type || 'cpa',
      currency:          normCurrency(norm.payout_currency),
      status:            norm.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'clickdealer'),
      preview_url:       norm.preview_url || norm.destination_url || '',
      allowed_countries: (norm.allowed_countries || []).join(','),
      advertiser_name:   norm.advertiser_name || 'ClickDealer',
      categories:        norm.vertical || '',
      approval_status:   norm.approval_status || 'unknown',
      raw,
    };
  });
}

async function fetchCAKE(cred) {
  if (!cred?.api_key || !cred?.network_id) {
    throw new Error('CAKE network requires API Key and Affiliate ID');
  }
  const extra = cred.extra ? (typeof cred.extra === 'string' ? (() => { try { return JSON.parse(cred.extra); } catch { return {}; } })() : cred.extra) : {};
  if (!cred.base_url && !extra.base_url) {
    throw new Error('CAKE generic platform requires base_url (paste the network API URL)');
  }
  const CAKE = require('../utils/connectors/cake');
  const rawOffers = await CAKE.listOffers(cred);
  return rawOffers.map(raw => {
    const norm = CAKE.normalizeOffer(raw, cred);
    const rawTracking = norm.tracking_url_template || '';
    return {
      external_id:       norm.source_offer_id,
      name:              norm.name,
      description:       norm.description || '',
      payout:            norm.payout || 0,
      payout_type:       norm.payout_type || 'cpa',
      currency:          normCurrency(norm.payout_currency),
      status:            norm.status === 'active' ? 'active' : 'paused',
      tracking_url:      toOurMacros(rawTracking, 'cake'),
      preview_url:       norm.preview_url || norm.destination_url || '',
      allowed_countries: (norm.allowed_countries || []).join(','),
      advertiser_name:   norm.advertiser_name || extra.display_name || 'CAKE Network',
      categories:        norm.vertical || '',
      approval_status:   norm.approval_status || 'unknown',
      raw,
    };
  });
}

async function fetchZeydoo(cred) {
  if (!cred?.api_key) {
    throw new Error('Zeydoo requires Bearer token (api_key)');
  }
  const Zeydoo = require('../utils/connectors/zeydoo');
  const rawOffers = await Zeydoo.listOffers(cred);
  return rawOffers.map(raw => {
    const norm = Zeydoo.normalizeOffer(raw, cred);
    const rawTracking = norm.tracking_url_template || '';
    return {
      external_id:       norm.source_offer_id,
      name:              norm.name,
      description:       norm.description || '',
      payout:            norm.payout || 0,
      payout_type:       norm.payout_type || 'cpa',
      currency:          normCurrency(norm.payout_currency),
      status:            norm.status === 'active' ? 'active' : 'paused',
      // Zeydoo API doesn't return tracking URLs — toOurMacros will pass an
      // empty string through unchanged. Operator must paste the tracking
      // URL manually from the Zeydoo dashboard.
      tracking_url:      toOurMacros(rawTracking, 'zeydoo'),
      preview_url:       norm.preview_url || norm.destination_url || '',
      allowed_countries: (norm.allowed_countries || []).join(','),
      advertiser_name:   norm.advertiser_name || 'Zeydoo',
      categories:        norm.vertical || '',
      approval_status:   norm.approval_status || 'unknown',
      raw,
    };
  });
}

const ADAPTERS = { everflow: fetchEverflow, tune: fetchTune, appsflyer: fetchAppsFlyer, cityads: fetchCityAds, impact: fetchImpact, swaarm: fetchSwaarm, admitad: fetchAdmitad, insparx: fetchInsparx, trackier: fetchTrackier, affise: fetchAffise, clickdealer: fetchClickDealer, cake: fetchCAKE, zeydoo: fetchZeydoo };

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
         payout, payout_type, payout_currency, publisher_payout, publisher_payout_type,
         destination_url, preview_url, allowed_countries, visibility, status,
         source_credential_id, external_offer_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `);

    const updateCampaign = db.prepare(`
      UPDATE campaigns SET
        status = 'active',
        advertiser_name = COALESCE(?, advertiser_name),
        payout = COALESCE(?, payout),
        payout_type = COALESCE(?, payout_type),
        payout_currency = COALESCE(?, payout_currency),
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

      // Check if a campaign with same name already exists (active, paused, or archived)
      const exists = db.prepare('SELECT id, status FROM campaigns WHERE name = ?').get(offer.name);

      if (exists) {
        if (exists.status === 'archived' || exists.status === 'paused') {
          // Re-activate the archived/paused campaign and refresh its details
          updateCampaign.run(
            advName,
            advPayout != null ? advPayout : null,
            offer.payout_type || null,
            normCurrency(offer.currency),   // Currency Phase 2 — preserve currency on re-import
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
          // Already active — skip to avoid duplicates
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
        normCurrency(offer.currency),   // Currency Phase 2 — preserve currency on new import
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

/* ─── POST /api/integrations/test-postback ──────────────────────────────────
 * Phase 4a — Synthetic postback test for the one-click setup UX.
 *
 * Fires a self-call to /acquisition with a known test click_id + the
 * advertiser's saved security_token, then reports step-by-step whether
 * each validation passed. Lets non-technical users verify their integration
 * works end-to-end without waiting for real traffic.
 *
 * Body: { advertiser_id, platform }
 * Returns: { ok, steps: [{name, passed, detail}], summary }
 */
router.post('/test-postback', async (req, res, next) => {
  try {
    const { advertiser_id, platform } = req.body || {};
    if (!advertiser_id) return res.status(400).json({ error: 'advertiser_id required' });
    if (!platform) return res.status(400).json({ error: 'platform required' });

    const steps = [];
    const step = (name, passed, detail) => { steps.push({ name, passed, detail }); return passed; };

    // Step 1 — verify advertiser exists + has a postback_token
    const adv = db.prepare('SELECT id, name, email, postback_token FROM users WHERE id = ? AND role = ?')
                  .get(advertiser_id, 'advertiser');
    if (!step('Advertiser exists', !!adv, adv ? `id=${adv.id} · ${adv.name}` : 'not found in users table')) {
      return res.json({ ok: false, steps, summary: 'advertiser not found' });
    }
    if (!step('Security token configured', !!adv.postback_token, adv.postback_token ? `${adv.postback_token.slice(0, 8)}…` : 'missing — regenerate from API Access')) {
      return res.json({ ok: false, steps, summary: 'no security token' });
    }

    // Step 2 — synthesize a known test click in the DB
    const testClickId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Find any active campaign bound to this advertiser (advertiser_id is the FK).
    // user_id is the admin who CREATED the campaign — not the advertiser it's FOR.
    const camp = db.prepare(`SELECT id, name, campaign_token FROM campaigns WHERE advertiser_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get(advertiser_id);
    if (!step('Test campaign available', !!camp, camp ? `using campaign #${camp.id} — ${camp.name}` : 'no active campaign for this advertiser; create one first')) {
      return res.json({ ok: false, steps, summary: 'no active campaign to test against' });
    }
    try {
      // user_id is the actor — the admin/AM whose session is running this test
      db.prepare(`INSERT INTO clicks (click_id, campaign_id, user_id, status, created_at) VALUES (?, ?, ?, 'clicked', unixepoch())`)
        .run(testClickId, camp.id, req.user?.id || 1);
      step('Test click recorded', true, `click_id=${testClickId}`);
    } catch (e) {
      step('Test click recorded', false, e.message);
      return res.json({ ok: false, steps, summary: 'failed to insert test click' });
    }

    // Step 3 — call /acquisition internally with test postback params
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fetch = require('node-fetch');
    const testPayout = 1.23;
    const testPostbackUrl = `${baseUrl}/acquisition?clickid=${encodeURIComponent(testClickId)}&security_token=${encodeURIComponent(adv.postback_token)}&payout=${testPayout}&event=install`;
    let postbackResult = {};
    try {
      const r = await fetch(testPostbackUrl, { method: 'GET', timeout: 5000 });
      const txt = await r.text();
      postbackResult = { http: r.status, body: txt.slice(0, 200) };
    } catch (e) {
      postbackResult = { http: 0, error: e.message };
    }
    const acqOk = postbackResult.http === 200;
    step('Postback delivered', acqOk, acqOk ? `HTTP ${postbackResult.http}` : `HTTP ${postbackResult.http || 'fail'}: ${postbackResult.body || postbackResult.error}`);

    // Step 4 — verify it landed in postbacks table (attributed status)
    const pb = db.prepare(`SELECT id, status, payout FROM postbacks WHERE click_id = ? ORDER BY id DESC LIMIT 1`).get(testClickId);
    const attributed = !!pb && pb.status === 'attributed';
    step('Conversion attributed', attributed,
      pb ? `postback #${pb.id} · status=${pb.status} · payout=$${pb.payout}` : 'no postback row found — security_token likely mismatched');

    // Cleanup — remove test rows so they don't pollute reports
    try {
      if (pb) db.prepare('DELETE FROM postbacks WHERE id = ?').run(pb.id);
      db.prepare('DELETE FROM clicks WHERE click_id = ?').run(testClickId);
    } catch {}

    const allOk = steps.every(s => s.passed);
    res.json({
      ok: allOk,
      platform,
      advertiser_id,
      test_click_id: testClickId,
      steps,
      summary: allOk
        ? `✓ End-to-end attribution worked. Integration is live.`
        : `Stopped at: ${steps.find(s => !s.passed)?.name || 'unknown step'}`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
// Expose the legacy ADAPTERS map so utils/discoveryEngine.js can fall back to
// the proven /offer-import fetchers when a Discovery Hub connector is missing
// or errors. Read-only — never mutated by the bridge.
module.exports.ADAPTERS = ADAPTERS;
