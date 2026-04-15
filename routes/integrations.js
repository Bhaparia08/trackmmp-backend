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
   Each adapter receives the stored credential row and returns a normalised array:
   [{ external_id, name, description, payout, payout_type, currency,
      status, preview_url, allowed_countries, advertiser_name, raw }]
─────────────────────────────────────────────────────────────────────────────── */

async function fetchEverflow(cred) {
  // Everflow affiliate API — fetch offers available to this affiliate account
  // Docs: https://developers.eflow.team/
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
  return offers.map(o => ({
    external_id:       String(o.network_offer_id || o.id || ''),
    name:              o.name || o.offer_name || 'Unnamed Offer',
    description:       o.description || o.offer_description || '',
    payout:            parseFloat(o.default_payout || o.payout || o.revenue_type?.payout || 0),
    payout_type:       normPayoutType(o.payout_type || o.revenue_type?.type || 'cpi'),
    currency:          o.currency || 'USD',
    status:            o.status === 1 || o.status === 'active' ? 'active' : 'paused',
    preview_url:       o.preview_url || o.offer_url || '',
    allowed_countries: Array.isArray(o.allowed_countries)
                         ? o.allowed_countries.join(',')
                         : (o.allowed_countries || ''),
    advertiser_name:   o.advertiser?.label || o.advertiser_name || '',
    categories:        (o.categories || []).map(c => c.label || c.name || c).join(', '),
    raw: o,
  }));
}

async function fetchTune(cred) {
  // TUNE / HasOffers affiliate API
  // Endpoint: https://NETWORKID.api.hasoffers.com/Apiv3/json
  const networkId = cred.network_id || '';
  const base = networkId
    ? `https://${networkId}.api.hasoffers.com`
    : 'https://api.hasoffers.com';

  const params = new URLSearchParams({
    NetworkId:  networkId,
    Target:     'Affiliate_Offer',
    Method:     'findAll',
    api_key:    cred.api_key,
    'filters[status]': 'active',
    'fields[]':  ['id', 'name', 'description', 'default_payout', 'payout_type',
                  'currency', 'status', 'preview_url', 'allowed_countries',
                  'Advertiser.company'].join('&fields[]='),
    limit:      200,
  });

  const res = await fetch(`${base}/Apiv3/json?${params}`);
  if (!res.ok) throw new Error(`TUNE API error ${res.status}`);
  const json = await res.json();
  const data = json.response?.data?.data || json.response?.data || {};
  const offers = Object.values(data);

  return offers.map(o => ({
    external_id:       String(o.id || ''),
    name:              o.name || 'Unnamed Offer',
    description:       o.description || '',
    payout:            parseFloat(o.default_payout || 0),
    payout_type:       normPayoutType(o.payout_type || 'cpi'),
    currency:          o.currency || 'USD',
    status:            o.status === 'active' ? 'active' : 'paused',
    preview_url:       o.preview_url || '',
    allowed_countries: Array.isArray(o.allowed_countries)
                         ? o.allowed_countries.join(',')
                         : '',
    advertiser_name:   o.Advertiser?.company || '',
    categories:        '',
    raw: o,
  }));
}

async function fetchCityAds(cred) {
  // CityAds affiliate API — webmaster/v1/offers
  // Docs: https://userdocs.cityads.com/docs/udocs/en/latest/
  const params = new URLSearchParams({
    token:    cred.api_key,
    limit:    200,
    offset:   0,
    language: 'en',
  });
  const res = await fetch(`https://api.cityads.com/api/rest/webmaster/v1/offers?${params}`);
  if (!res.ok) throw new Error(`CityAds API error ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`CityAds API: ${json.error}`);

  const offers = Array.isArray(json.offer) ? json.offer : [];

  // CityAds currency_id mapping (most common)
  const CURRENCY = { '1': 'RUB', '2': 'USD', '3': 'EUR', '4': 'GBP' };

  return offers.map(o => {
    const cd = o.commission_data || {};
    const currency = CURRENCY[cd.currency_id] || 'USD';

    // Determine payout_type and amount
    let payout_type = 'cpa';
    let payout = 0;
    if (cd.percent && (parseFloat(cd.percent.min) > 0 || parseFloat(cd.percent.max) > 0)) {
      payout_type = 'revshare';
      payout = parseFloat(cd.percent.max || cd.percent.min || 0);
    } else if (cd.amount && (parseFloat(cd.amount.min) > 0 || parseFloat(cd.amount.max) > 0)) {
      payout = parseFloat(cd.amount.max || cd.amount.min || 0);
    }

    return {
      external_id:       String(o.id || ''),
      name:              o.name || o.translated_name || 'Unnamed Offer',
      description:       o.text || o.text_en || '',
      payout,
      payout_type,
      currency,
      status:            o.is_active === '1' && o.is_deleted === '0' ? 'active' : 'paused',
      preview_url:       o.site_url || '',
      allowed_countries: '',   // regions are IDs — not ISO codes in v1, skip for now
      advertiser_name:   String(o.advertiser || ''),
      categories:        '',
      raw: o,
    };
  });
}

async function fetchAppsFlyer(cred) {
  // AppsFlyer Partner API — fetch campaigns available to this partner
  const res = await fetch('https://hq1.appsflyer.com/api/partner-feed/v1/offers', {
    headers: { 'Authorization': `Bearer ${cred.api_key}` },
  });
  if (!res.ok) throw new Error(`AppsFlyer API error ${res.status}`);
  const json = await res.json();
  const offers = json.data || json.offers || [];
  return offers.map(o => ({
    external_id:       String(o.id || o.offer_id || ''),
    name:              o.name || o.app_name || 'Unnamed',
    description:       o.description || '',
    payout:            parseFloat(o.payout || 0),
    payout_type:       normPayoutType(o.payout_type || 'cpi'),
    currency:          o.currency || 'USD',
    status:            'active',
    preview_url:       o.store_url || o.preview_url || '',
    allowed_countries: (o.geo || []).join(','),
    advertiser_name:   o.advertiser_name || '',
    categories:        '',
    raw: o,
  }));
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

const ADAPTERS = { everflow: fetchEverflow, tune: fetchTune, appsflyer: fetchAppsFlyer, cityads: fetchCityAds };

/* ─── POST /api/integrations/fetch-offers ───────────────────────────────────── */
router.post('/fetch-offers', async (req, res, next) => {
  try {
    const { credential_id } = req.body;
    if (!credential_id) return res.status(400).json({ error: 'credential_id required' });

    const cred = db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ? AND user_id = ?')
                   .get(credential_id, req.user.id);
    if (!cred) return res.status(404).json({ error: 'Credentials not found' });

    const adapter = ADAPTERS[cred.platform];
    if (!adapter) {
      return res.status(400).json({
        error: `No API adapter for platform "${cred.platform}". Supported: ${Object.keys(ADAPTERS).join(', ')}`,
      });
    }

    const offers = await adapter(cred);
    res.json({ offers, platform: cred.platform, label: cred.label, total: offers.length });
  } catch (err) {
    // Return a clean error to the frontend instead of crashing
    res.status(502).json({ error: err.message || 'Failed to fetch offers from platform' });
  }
});

/* ─── POST /api/integrations/import ─────────────────────────────────────────── */
router.post('/import', (req, res, next) => {
  try {
    const { offers, advertiser_id, credential_id } = req.body;
    if (!Array.isArray(offers) || offers.length === 0)
      return res.status(400).json({ error: 'offers array is required' });

    const cred = credential_id
      ? db.prepare('SELECT * FROM advertiser_api_credentials WHERE id = ?').get(credential_id)
      : null;

    const imported = [];
    const skipped  = [];

    const insertCampaign = db.prepare(`
      INSERT INTO campaigns
        (user_id, advertiser_id, name, advertiser_name, campaign_token, security_token,
         payout, payout_type, destination_url, allowed_countries, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `);

    for (const offer of offers) {
      // Skip if a campaign with same name already exists for this user
      const exists = db.prepare('SELECT id FROM campaigns WHERE user_id = ? AND name = ?')
                       .get(req.user.id, offer.name);
      if (exists) { skipped.push({ name: offer.name, reason: 'already exists' }); continue; }

      const result = insertCampaign.run(
        req.user.id,
        advertiser_id || null,
        offer.name,
        offer.advertiser_name || cred?.label || null,
        nanoid12(),
        nanoid20hex(),
        offer.payout || 0,
        offer.payout_type || 'cpi',
        offer.preview_url || '',
        offer.allowed_countries || '',
      );
      imported.push({ id: result.lastInsertRowid, name: offer.name });
    }

    res.json({ imported, skipped, total_imported: imported.length });
  } catch (err) { next(err); }
});

module.exports = router;
