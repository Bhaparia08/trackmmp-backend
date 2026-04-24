const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const BASE = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

// SDK Inventory definitions — click ID macro + device ID macro per network
const SDK_INVENTORIES = [
  {
    key: 'unity',
    name: 'Unity Ads',
    color: '#222c37',
    click_id_macro: '{clickid}',
    device_ios: '{advertising_id}',
    device_android: '{advertising_id}',
    postback_click_param: 'clickid',
    notes: 'Unity uses {advertising_id} for both iOS (IDFA) and Android (GAID) in one URL. Paste Click URL into Unity Ads → Campaign → Tracking → Click URL.',
  },
  {
    key: 'ironsource',
    name: 'ironSource / Unity LevelPlay',
    color: '#0075ff',
    click_id_macro: '{click_id}',
    device_ios: '{advertising_id}',
    device_android: '{advertising_id}',
    postback_click_param: 'click_id',
    notes: 'ironSource → Campaign → Tracking → Add Third-Party Tracking. Use same URL for iOS and Android.',
  },
  {
    key: 'applovin',
    name: 'AppLovin MAX',
    color: '#f63b3b',
    click_id_macro: '{clickid}',
    device_ios: '{idfa}',
    device_android: '{gaid}',
    postback_click_param: 'clickid',
    notes: 'AppLovin MAX → Campaign Manager → Create Campaign → Tracking URL. Separate iOS and Android URLs required.',
    separate_ios_android: true,
  },
  {
    key: 'vungle',
    name: 'Vungle / Liftoff',
    color: '#5c34d5',
    click_id_macro: '{transaction_id}',
    device_ios: '{advertising_id}',
    device_android: '{advertising_id}',
    postback_click_param: 'transaction_id',
    notes: 'Vungle uses {transaction_id} as their click ID macro. Add Click URL in Vungle Dashboard → Campaign → Tracking.',
  },
  {
    key: 'inmobi',
    name: 'InMobi',
    color: '#ff6b35',
    click_id_macro: '{click_id}',
    device_ios: '{idfa}',
    device_android: '{gps_adid}',
    postback_click_param: 'click_id',
    notes: 'InMobi → Campaign → Tracking → Custom Tracking URL. iOS uses {idfa}, Android uses {gps_adid}.',
    separate_ios_android: true,
  },
  {
    key: 'digitalturbine',
    name: 'Digital Turbine (AdColony/Fyber)',
    color: '#00b4d8',
    click_id_macro: '{click_id}',
    device_ios: '{advertising_id}',
    device_android: '{advertising_id}',
    postback_click_param: 'click_id',
    notes: 'Digital Turbine dashboard → Campaign → Click Tracking URL.',
  },
  {
    key: 'chartboost',
    name: 'Chartboost',
    color: '#f8961e',
    click_id_macro: '{click_id}',
    device_ios: '{advertising_id}',
    device_android: '{advertising_id}',
    postback_click_param: 'click_id',
    notes: 'Chartboost → Campaign → Click URL in Tracking section.',
  },
  {
    key: 'mintegral',
    name: 'Mintegral',
    color: '#e63946',
    click_id_macro: '{click_id}',
    device_ios: '{idfa}',
    device_android: '{gaid}',
    postback_click_param: 'click_id',
    notes: 'Mintegral → Campaign → Tracking URL. Separate iOS/Android URLs.',
    separate_ios_android: true,
  },
  {
    key: 'moloco',
    name: 'Moloco',
    color: '#6c63ff',
    click_id_macro: '{click_id}',
    device_ios: '{idfa}',
    device_android: '{gaid}',
    postback_click_param: 'click_id',
    notes: 'Moloco → Campaign → Tracking → Click URL.',
    separate_ios_android: true,
  },
  {
    key: 'generic',
    name: 'Generic / Custom S2S',
    color: '#6b7280',
    click_id_macro: '{click_id}',
    device_ios: '{idfa}',
    device_android: '{gaid}',
    postback_click_param: 'click_id',
    notes: 'Use for any network not listed above. Replace {click_id} with the network\'s click ID macro name.',
  },
];

function campaignFilter(user) {
  if (user.role === 'admin' || user.role === 'account_manager') return { clause: '1=1', params: [] };
  if (user.role === 'advertiser') return { clause: 'c.advertiser_id = ?', params: [user.id] };
  return { clause: '1=0', params: [] };
}

// GET /api/impact/campaigns — list campaigns
router.get('/campaigns', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const rows = db.prepare(`
    SELECT c.id, c.name, c.campaign_token, c.destination_url, c.status,
           c.payout, c.payout_type, c.advertiser_name,
           COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id), 0) AS total_clicks,
           COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id AND status='installed'), 0) AS total_installs
    FROM campaigns c
    WHERE ${clause} AND c.status != 'archived'
    ORDER BY c.created_at DESC
  `).all(...params);

  const IMPACT_PATTERNS = ['impact.com', 'imp.pxf.io', 'linksynergy', 'pjatr', 'pjtra', 'dpbolvw', 'tkqlhce', 'clkde.com'];
  const enriched = rows.map(r => ({
    ...r,
    is_impact: IMPACT_PATTERNS.some(p => (r.destination_url || '').toLowerCase().includes(p)),
    cr: r.total_clicks > 0 ? +((r.total_installs / r.total_clicks) * 100).toFixed(2) : 0,
  }));

  res.json(enriched);
});

// GET /api/impact/sdk-links/:id — generate SDK inventory links for a campaign
router.get('/sdk-links/:id', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const c = db.prepare(
    `SELECT c.* FROM campaigns c WHERE c.id = ? AND (${clause})`
  ).get(req.params.id, ...params);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  const owner = db.prepare('SELECT postback_token FROM users WHERE id = ?').get(c.user_id);
  const postbackToken = owner?.postback_token || '';

  // Build click URL without URLSearchParams — macros like {clickid} must not be percent-encoded
  function buildClickUrl(base, campaignId, clickIdMacro, deviceMacro) {
    return `${base}?pid={YOUR_PUB_TOKEN}&af_c_id=${campaignId}&clickid=${clickIdMacro}&advertising_id=${deviceMacro}&af_sub1={sub1}&af_sub2={sub2}`;
  }

  // Postback URL uses clickid= (not click_id=) so the attribution lookup uses publisher_click_id
  function buildPostbackUrl(clickIdMacro) {
    return `${BASE}/pb?clickid=${clickIdMacro}&event=install&advertising_id={advertising_id}${postbackToken ? `&security_token=${postbackToken}` : ''}`;
  }

  const sdkLinks = SDK_INVENTORIES.map(sdk => {
    const base = `${BASE}/track/click/${c.campaign_token}`;

    if (sdk.separate_ios_android) {
      return {
        ...sdk,
        click_url_ios:    buildClickUrl(base, c.id, sdk.click_id_macro, sdk.device_ios),
        click_url_android: buildClickUrl(base, c.id, sdk.click_id_macro, sdk.device_android),
        postback_url:     buildPostbackUrl(sdk.click_id_macro),
      };
    }

    return {
      ...sdk,
      click_url:    buildClickUrl(base, c.id, sdk.click_id_macro, sdk.device_ios),
      postback_url: buildPostbackUrl(sdk.click_id_macro),
    };
  });

  // Impact integration config
  const IMPACT_PATTERNS = ['impact.com', 'imp.pxf.io', 'linksynergy', 'pjatr', 'pjtra', 'dpbolvw'];
  const isImpactCampaign = IMPACT_PATTERNS.some(p => (c.destination_url || '').toLowerCase().includes(p));
  const destUrl = c.destination_url || 'YOUR_IMPACT_LINK';
  // If subId1 already present, replace it; otherwise append
  let destinationWithMacro;
  if (destUrl.includes('subId1=')) {
    destinationWithMacro = destUrl.replace(/subId1=[^&]*/, 'subId1={click_id}');
  } else {
    const destSep = destUrl.includes('?') ? '&' : '?';
    destinationWithMacro = `${destUrl}${destSep}subId1={click_id}`;
  }

  const impactConfig = {
    is_impact_campaign: isImpactCampaign,
    destination_url_with_macro: destinationWithMacro,
    impact_postback_to_us: `${BASE}/pb?click_id={subId1}&event=install${postbackToken ? `&security_token=${postbackToken}` : ''}`,
    impact_event_postback: `${BASE}/pb?click_id={subId1}&event={event_name}${postbackToken ? `&security_token=${postbackToken}` : ''}`,
    instructions: [
      'In your Impact dashboard, edit the offer\'s Destination URL to include ?subId1={click_id}',
      'In Impact → Offer → Postback URL, add the "Postback to Us" URL above',
      'Impact will fire the postback when a conversion happens, passing back our click_id in subId1',
      'Our platform matches the click_id and attributes the conversion',
    ],
  };

  res.json({
    campaign: { id: c.id, name: c.name, token: c.campaign_token, destination_url: c.destination_url, status: c.status },
    sdk_links: sdkLinks,
    impact_config: impactConfig,
    postback_token: postbackToken,
    base_url: BASE,
  });
});

// GET /api/impact/sdk-definitions — return static SDK list (no auth needed for labels)
router.get('/sdk-definitions', (req, res) => {
  res.json(SDK_INVENTORIES.map(s => ({ key: s.key, name: s.name, color: s.color })));
});

module.exports = router;
