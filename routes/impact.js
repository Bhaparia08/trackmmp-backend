const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const BASE = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

// ── SDK Inventory definitions ─────────────────────────────────────────────────
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

// ── Partnership Platform definitions ─────────────────────────────────────────
// Each entry describes how to inject our click_id and how the platform returns it.
const PARTNERSHIP_PLATFORMS = [
  {
    key: 'impact',
    name: 'Impact.com',
    color: '#6366f1',
    patterns: ['impact.com', 'imp.pxf.io', 'pjatr.com', 'pjtra.com', 'clkde.com'],
    sub_param: 'subId1',
    postback_macro: '{subId1}',
    dashboard_hint: 'Impact dashboard → Offers → edit offer → Tracking Settings → Server Postback → Add for Install event.',
    dest_hint: 'In Impact dashboard → edit offer → Destination URL, ensure the URL includes subId1={click_id}.',
  },
  {
    key: 'cj',
    name: 'CJ Affiliate',
    color: '#003087',
    patterns: ['anrdoezrs.net', 'dpbolvw.net', 'kqzyfj.com', 'jdoqocy.com', 'qksrv.net', 'emjcd.com', 'tkqlhce.com'],
    sub_param: 'sid',
    postback_macro: '%%SID%%',
    dashboard_hint: 'CJ dashboard → Advertisers → Account → Tracking → Server Postback. Add Install Postback URL and enable SID passthrough.',
    dest_hint: 'Append ?sid={click_id} to your CJ affiliate link. CJ returns %%SID%% in the postback.',
  },
  {
    key: 'rakuten',
    name: 'Rakuten Advertising',
    color: '#bf0000',
    patterns: ['linksynergy.com', 'rakuten.com', 'rakutenadvertising.com'],
    sub_param: 'u1',
    postback_macro: '[U1]',
    dashboard_hint: 'Rakuten dashboard → Programs → Program Settings → Pixels → Add Server-to-Server Pixel for Install event with U1 passthrough.',
    dest_hint: 'Append ?u1={click_id} to your Rakuten link. Rakuten returns [U1] in the postback.',
  },
  {
    key: 'awin',
    name: 'Awin',
    color: '#00b9a8',
    patterns: ['awin1.com', 'awin.com'],
    sub_param: 'clickref',
    postback_macro: 'CLICKREF',
    dashboard_hint: 'Awin → Advertisers → Program Settings → Conversion Tracking → Server-to-Server. Add Install Postback URL with CLICKREF substitution.',
    dest_hint: 'Append ?clickref={click_id} to your Awin link (max 50 chars — our 12-char ID fits fine).',
  },
  {
    key: 'partnerize',
    name: 'Partnerize',
    color: '#ff6900',
    patterns: ['prf.hn', 'partnerize.com'],
    sub_param: 'pubref',
    postback_macro: '{PUBREF}',
    dashboard_hint: 'Partnerize dashboard → Program → Tracking → Server Postback. Add Install Postback URL with {PUBREF} substitution.',
    dest_hint: 'Append ?pubref={click_id} to your Partnerize link.',
  },
  {
    key: 'admitad',
    name: 'Admitad',
    color: '#e63946',
    patterns: ['admitad.com'],
    sub_param: 'subid',
    postback_macro: '{subid}',
    dashboard_hint: 'Admitad dashboard → Offers → Postback URL. Paste the Install Postback URL with {subid} substitution.',
    dest_hint: 'Append ?subid={click_id} to your Admitad offer link.',
  },
  {
    key: 'tune',
    name: 'TUNE / Assembly',
    color: '#5c6bc0',
    patterns: ['go2cloud.org', 'go2jump.org', 'tune.com', 'hasoffers.com'],
    sub_param: 'aff_sub',
    postback_macro: '{aff_sub}',
    dashboard_hint: 'TUNE dashboard → Offer → Conversion Pixels / Postback URL. Add Install Postback URL with {aff_sub} substitution.',
    dest_hint: 'Append ?aff_sub={click_id} to your TUNE offer link.',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectPlatform(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  for (const p of PARTNERSHIP_PLATFORMS) {
    if (p.patterns.some(pat => lower.includes(pat))) return p;
  }
  return null;
}

// Inject sub_param={click_id} into a URL, preserving any # fragment.
// If the param already exists it is replaced; otherwise appended.
function injectSubParam(url, paramName) {
  if (!url) return url;
  // Separate fragment
  const hashIdx = url.indexOf('#');
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : '';
  // Replace existing occurrence
  const regex = new RegExp(`${paramName}=[^&#]*`);
  if (regex.test(base)) {
    return base.replace(regex, `${paramName}={click_id}`) + fragment;
  }
  // Append
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${paramName}={click_id}${fragment}`;
}

function campaignFilter(user) {
  if (user.role === 'admin' || user.role === 'account_manager') return { clause: '1=1', params: [] };
  if (user.role === 'advertiser') return { clause: 'c.advertiser_id = ?', params: [user.id] };
  return { clause: '1=0', params: [] };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/impact/campaigns
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

  const enriched = rows.map(r => {
    const platform = detectPlatform(r.destination_url);
    return {
      ...r,
      platform_key: platform ? platform.key : null,
      platform_name: platform ? platform.name : null,
      platform_color: platform ? platform.color : null,
      is_partnership: !!platform,
      cr: r.total_clicks > 0 ? +((r.total_installs / r.total_clicks) * 100).toFixed(2) : 0,
    };
  });

  res.json(enriched);
});

// GET /api/impact/sdk-links/:id
router.get('/sdk-links/:id', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const c = db.prepare(
    `SELECT c.* FROM campaigns c WHERE c.id = ? AND (${clause})`
  ).get(req.params.id, ...params);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  const owner = db.prepare('SELECT postback_token FROM users WHERE id = ?').get(c.user_id);
  const postbackToken = owner?.postback_token || '';

  // Build click URL — manual string building preserves macro braces (URLSearchParams would encode them)
  function buildClickUrl(base, campaignId, clickIdMacro, deviceMacro) {
    return `${base}?pid={YOUR_PUB_TOKEN}&af_c_id=${campaignId}&clickid=${clickIdMacro}&advertising_id=${deviceMacro}&af_sub1={sub1}&af_sub2={sub2}`;
  }

  // Postback URL uses clickid= so attribution lookup uses publisher_click_id column
  function buildPostbackUrl(clickIdMacro) {
    return `${BASE}/pb?clickid=${clickIdMacro}&event=install&advertising_id={advertising_id}${postbackToken ? `&security_token=${postbackToken}` : ''}`;
  }

  const sdkLinks = SDK_INVENTORIES.map(sdk => {
    const base = `${BASE}/track/click/${c.campaign_token}`;
    if (sdk.separate_ios_android) {
      return {
        ...sdk,
        click_url_ios:     buildClickUrl(base, c.id, sdk.click_id_macro, sdk.device_ios),
        click_url_android: buildClickUrl(base, c.id, sdk.click_id_macro, sdk.device_android),
        postback_url:      buildPostbackUrl(sdk.click_id_macro),
      };
    }
    return {
      ...sdk,
      click_url:    buildClickUrl(base, c.id, sdk.click_id_macro, sdk.device_ios),
      postback_url: buildPostbackUrl(sdk.click_id_macro),
    };
  });

  // Partnership platform detection and config
  const platform = detectPlatform(c.destination_url);
  const destUrl = c.destination_url || '';
  const subParam = platform ? platform.sub_param : 'subId1';

  const destinationWithMacro = destUrl
    ? injectSubParam(destUrl, subParam)
    : `YOUR_PARTNERSHIP_LINK?${subParam}={click_id}`;

  // Partnership postbacks use click_id= (our nanoid) — the platform returns it via their sub_param macro
  const secStr = postbackToken ? `&security_token=${postbackToken}` : '';
  const macro  = platform ? platform.postback_macro : '{click_id}';

  const partnershipConfig = {
    platform: platform
      ? { key: platform.key, name: platform.name, color: platform.color }
      : null,
    detected: !!platform,
    sub_param: subParam,
    postback_macro: macro,
    destination_url_with_macro: destinationWithMacro,
    postback_to_us:       `${BASE}/pb?click_id=${macro}&event=install${secStr}`,
    event_postback_to_us: `${BASE}/pb?click_id=${macro}&event={event_name}${secStr}`,
    dashboard_hint: platform ? platform.dashboard_hint : '',
    dest_hint:      platform ? platform.dest_hint : '',
  };

  res.json({
    campaign: { id: c.id, name: c.name, token: c.campaign_token, destination_url: c.destination_url, status: c.status },
    sdk_links: sdkLinks,
    partnership_config: partnershipConfig,
    postback_token: postbackToken,
    base_url: BASE,
  });
});

// GET /api/impact/sdk-definitions — static SDK list
router.get('/sdk-definitions', (req, res) => {
  res.json(SDK_INVENTORIES.map(s => ({ key: s.key, name: s.name, color: s.color })));
});

// GET /api/impact/platform-definitions — static partnership platform list
router.get('/platform-definitions', (req, res) => {
  res.json(PARTNERSHIP_PLATFORMS.map(p => ({ key: p.key, name: p.name, color: p.color, sub_param: p.sub_param })));
});

module.exports = router;
