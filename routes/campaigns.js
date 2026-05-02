const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid12, nanoid16 } = require('../utils/clickId');
const { customAlphabet } = require('nanoid');
const nanoid20hex = customAlphabet('0123456789abcdef', 20);

const router = express.Router();
router.use(requireAuth);

// Helper: advertiser IDs assigned to an account manager (uses junction table + legacy FK)
function getAMAdvertiserIds(userId) {
  const am = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(userId);
  if (!am) return [];
  return db.prepare(`
    SELECT DISTINCT u.id FROM users u
    WHERE u.role = 'advertiser' AND (
      u.account_manager_id = ?
      OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = u.id AND uam.account_manager_id = ?)
    )
  `).all(am.id, am.id).map(u => u.id);
}

// Helper: build campaign WHERE clause based on role
function campaignFilter(user) {
  if (user.role === 'admin') return { clause: '1=1', params: [] };
  if (user.role === 'account_manager') {
    const advIds = getAMAdvertiserIds(user.id);
    if (advIds.length === 0) return { clause: '1=0', params: [] };
    const ph = advIds.map(() => '?').join(',');
    return { clause: `c.advertiser_id IN (${ph})`, params: advIds };
  }
  if (user.role === 'advertiser') return { clause: 'c.advertiser_id = ?', params: [user.id] };
  return { clause: '1=0', params: [] }; // publishers use /api/publisher routes
}

router.get('/', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const { include_archived, advertiser_id } = req.query;
  const archivedClause = include_archived === '1' ? '' : " AND c.status != 'archived'";
  const advClause = advertiser_id ? ' AND c.advertiser_id = ?' : '';
  const advParams = advertiser_id ? [Number(advertiser_id)] : [];
  const rows = db.prepare(`
    SELECT c.*,
      COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id), 0) AS total_clicks,
      COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id AND status = 'installed'), 0) AS total_installs,
      COALESCE((SELECT SUM(revenue) FROM postbacks WHERE campaign_id = c.id AND status = 'attributed'), 0) AS total_revenue,
      COALESCE(u.name, NULLIF(c.advertiser_name,'')) AS advertiser_display,
      u.email AS advertiser_email,
      COALESCE((SELECT SUM(installs) FROM daily_stats WHERE campaign_id=c.id AND date=date('now','utc')),0) AS cap_used_today
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.advertiser_id
    WHERE ${clause}${archivedClause}${advClause} ORDER BY c.created_at DESC
  `).all(...params, ...advParams);
  // compute EPC and CR for each row
  const enriched = rows.map(r => ({
    ...r,
    epc: r.total_clicks > 0 ? +(r.total_revenue / r.total_clicks).toFixed(4) : 0,
    cr:  r.total_clicks > 0 ? +((r.total_installs / r.total_clicks) * 100).toFixed(2) : 0,
  }));
  res.json(enriched);
});

// Helper: upsert approved access records for a list of publisher IDs
function upsertApprovedPublishers(campaignId, publisherIds, userId) {
  if (!Array.isArray(publisherIds) || publisherIds.length === 0) return;
  const upsert = db.prepare(`
    INSERT INTO campaign_access_requests (campaign_id, publisher_id, user_id, status, reviewed_by, reviewed_at)
    VALUES (?, ?, ?, 'approved', ?, unixepoch())
    ON CONFLICT(campaign_id, publisher_id) DO UPDATE SET
      status = 'approved', reviewed_by = excluded.reviewed_by, reviewed_at = unixepoch()
  `);
  for (const pubId of publisherIds) upsert.run(campaignId, pubId, userId, userId);
}

router.post('/', (req, res, next) => {
  try {
    if (req.user.role === 'account_manager') {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (!advIds.includes(Number(req.body.advertiser_id))) {
        return res.status(403).json({ error: 'Advertiser not assigned to you' });
      }
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin or Account Manager only' });
    }

    const { name, advertiser_name, advertiser_id, app_id, payout = 0, payout_type = 'cpi',
            publisher_payout = 0, publisher_payout_type = 'cpi',
            destination_url = '', preview_url = '', postback_url = '', cap_daily = 0, cap_total = 0,
            allowed_countries = '', click_lookback_days = 7, is_retargeting = 0,
            visibility = 'open', approved_publishers = [], tags = '',
            geo_fallback_url = '',
            start_date = null, end_date = null, description = '',
            channel = 'all', allowed_devices = 'all',
            cap_monthly = 0, cap_redirect_url = '', conversion_hold_days = 0, featured = 0,
            url_masking = 0, referrer_cloaking = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // FIX #11 + #13: transaction for atomic seq_num; validate URL scheme
    if (destination_url && !/^https?:\/\//i.test(destination_url)) {
      return res.status(400).json({ error: 'destination_url must start with http:// or https://' });
    }
    if (postback_url && !/^https?:\/\//i.test(postback_url)) {
      return res.status(400).json({ error: 'postback_url must start with http:// or https://' });
    }

    const insertCampaign = db.transaction(() => {
    const nextSeq = db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM campaigns').get().n;
    const result = db.prepare(`
      INSERT INTO campaigns (user_id, advertiser_id, app_id, name, advertiser_name, campaign_token,
        security_token, payout, payout_type, publisher_payout, publisher_payout_type,
        destination_url, preview_url, postback_url, cap_daily, cap_total,
        allowed_countries, click_lookback_days, is_retargeting, visibility, tags, geo_fallback_url,
        start_date, end_date, description, channel, allowed_devices,
        cap_monthly, cap_redirect_url, conversion_hold_days, featured, url_masking, referrer_cloaking, seq_num)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, advertiser_id||null, app_id||null, name, advertiser_name||null, nanoid12(),
           nanoid20hex(),
           payout, payout_type, publisher_payout, publisher_payout_type,
           destination_url, preview_url, postback_url, cap_daily, cap_total,
           allowed_countries, click_lookback_days, is_retargeting ? 1 : 0, visibility, tags||'',
           geo_fallback_url||'',
           start_date||null, end_date||null, description||'',
           channel||'all', allowed_devices||'all',
           cap_monthly||0, cap_redirect_url||'', conversion_hold_days||0, featured ? 1 : 0,
           url_masking ? 1 : 0, referrer_cloaking ? 1 : 0,
           nextSeq);

      return result.lastInsertRowid;
    });
    const campaignId = insertCampaign();
    upsertApprovedPublishers(campaignId, approved_publishers, req.user.id);

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    const approvedPubs = db.prepare(
      "SELECT publisher_id FROM campaign_access_requests WHERE campaign_id = ? AND status = 'approved'"
    ).all(campaignId).map(r => r.publisher_id);
    res.status(201).json({ ...campaign, approved_publishers: approvedPubs });
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const c = db.prepare(`
    SELECT c.*,
      COALESCE(u.name, NULLIF(c.advertiser_name,'')) AS advertiser_display,
      u.email AS advertiser_email,
      u.company_name AS advertiser_company
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.advertiser_id
    WHERE c.id = ? AND (${clause})
  `).get(req.params.id, ...params);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT cl.id) AS total_clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS total_installs,
      COUNT(DISTINCT CASE WHEN cl.status='converted' THEN cl.id END) AS total_leads,
      COALESCE(SUM(pb.revenue),0) AS total_revenue
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE cl.campaign_id = ?
  `).get(req.params.id);

  const approvedPubs = db.prepare(
    "SELECT publisher_id FROM campaign_access_requests WHERE campaign_id = ? AND status = 'approved'"
  ).all(req.params.id).map(r => r.publisher_id);

  res.json({ ...c, stats, approved_publishers: approvedPubs });
});

router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'account_manager') {
      return res.status(403).json({ error: 'Admin or Account Manager only' });
    }
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (req.user.role === 'account_manager') {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (!advIds.includes(c.advertiser_id)) {
        return res.status(403).json({ error: 'Campaign not assigned to your advertisers' });
      }
    }

    const { name, advertiser_name, advertiser_id, payout, payout_type,
            publisher_payout, publisher_payout_type,
            destination_url, preview_url, postback_url,
            status, cap_daily, cap_total, allowed_countries, click_lookback_days,
            is_retargeting, visibility, approved_publishers, tags, geo_fallback_url,
            start_date, end_date, description, channel, allowed_devices,
            cap_monthly, cap_redirect_url, conversion_hold_days, featured,
            url_masking, referrer_cloaking } = req.body;

    db.prepare(`UPDATE campaigns SET
      name=COALESCE(?,name), advertiser_name=COALESCE(?,advertiser_name),
      advertiser_id=COALESCE(?,advertiser_id),
      payout=COALESCE(?,payout), payout_type=COALESCE(?,payout_type),
      publisher_payout=COALESCE(?,publisher_payout), publisher_payout_type=COALESCE(?,publisher_payout_type),
      destination_url=COALESCE(?,destination_url), preview_url=COALESCE(?,preview_url), postback_url=COALESCE(?,postback_url),
      status=COALESCE(?,status), cap_daily=COALESCE(?,cap_daily), cap_total=COALESCE(?,cap_total),
      allowed_countries=?, click_lookback_days=COALESCE(?,click_lookback_days),
      is_retargeting=COALESCE(?,is_retargeting), visibility=COALESCE(?,visibility),
      tags=COALESCE(?,tags), geo_fallback_url=?,
      start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date),
      description=COALESCE(?,description), channel=COALESCE(?,channel),
      allowed_devices=COALESCE(?,allowed_devices),
      cap_monthly=COALESCE(?,cap_monthly), cap_redirect_url=COALESCE(?,cap_redirect_url),
      conversion_hold_days=COALESCE(?,conversion_hold_days), featured=COALESCE(?,featured),
      url_masking=COALESCE(?,url_masking), referrer_cloaking=COALESCE(?,referrer_cloaking),
      updated_at=unixepoch()
      WHERE id=?`)
      .run(name||null, advertiser_name||null, advertiser_id??null, payout??null, payout_type||null,
           publisher_payout??null, publisher_payout_type||null,
           destination_url||null, preview_url||null, postback_url||null, status||null,
           cap_daily??null, cap_total??null,
           allowed_countries !== undefined ? allowed_countries : c.allowed_countries,
           click_lookback_days??null, is_retargeting!=null?+is_retargeting:null,
           visibility||null, tags!=null?tags:null, geo_fallback_url!=null?geo_fallback_url:c.geo_fallback_url,
           start_date!=null?start_date:null, end_date!=null?end_date:null,
           description!=null?description:null, channel||null, allowed_devices||null,
           cap_monthly??null, cap_redirect_url!=null?cap_redirect_url:null,
           conversion_hold_days??null, featured!=null?+featured:null,
           url_masking!=null?+url_masking:null, referrer_cloaking!=null?+referrer_cloaking:null,
           c.id);

    if (Array.isArray(approved_publishers)) {
      upsertApprovedPublishers(c.id, approved_publishers, req.user.id);
    }

    const approvedPubs = db.prepare(
      "SELECT publisher_id FROM campaign_access_requests WHERE campaign_id = ? AND status = 'approved'"
    ).all(c.id).map(r => r.publisher_id);

    res.json({ ...db.prepare('SELECT * FROM campaigns WHERE id = ?').get(c.id), approved_publishers: approvedPubs });
  } catch (err) { next(err); }
});

// POST /api/campaigns/:id/clone — create a manual copy of a campaign
router.post('/:id/clone', (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'account_manager') {
      return res.status(403).json({ error: 'Admin or Account Manager only' });
    }
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (req.user.role === 'account_manager') {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (!advIds.includes(c.advertiser_id)) {
        return res.status(403).json({ error: 'Campaign not assigned to your advertisers' });
      }
    }

    const cloneId = db.transaction(() => {
      const nextSeq = db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM campaigns').get().n;
      // Determine a unique name
      let cloneName = c.name + ' (Copy)';
      let suffix = 2;
      while (db.prepare('SELECT id FROM campaigns WHERE name = ?').get(cloneName)) {
        cloneName = c.name + ` (Copy ${suffix++})`;
      }
      const result = db.prepare(`
        INSERT INTO campaigns (
          user_id, advertiser_id, app_id, name, advertiser_name, campaign_token,
          security_token, payout, payout_type, publisher_payout, publisher_payout_type,
          destination_url, preview_url, postback_url, cap_daily, cap_total,
          allowed_countries, click_lookback_days, is_retargeting, visibility, tags,
          geo_fallback_url, start_date, end_date, description, channel, allowed_devices,
          cap_monthly, cap_redirect_url, conversion_hold_days, featured,
          status, seq_num,
          source_credential_id, external_offer_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          'active', ?,
          NULL, NULL
        )
      `).run(
        req.user.id, c.advertiser_id, c.app_id, cloneName, c.advertiser_name, nanoid12(),
        nanoid20hex(), c.payout, c.payout_type, c.publisher_payout, c.publisher_payout_type,
        c.destination_url, c.preview_url, c.postback_url, c.cap_daily, c.cap_total,
        c.allowed_countries, c.click_lookback_days, c.is_retargeting, c.visibility, c.tags || '',
        c.geo_fallback_url || '', c.start_date, c.end_date, c.description || '',
        c.channel || 'all', c.allowed_devices || 'all',
        c.cap_monthly || 0, c.cap_redirect_url || '', c.conversion_hold_days || 0, c.featured || 0,
        nextSeq,
      );
      return result.lastInsertRowid;
    })();

    const cloned = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(cloneId);
    res.status(201).json(cloned);
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'account_manager') {
      return res.status(403).json({ error: 'Admin or Account Manager only' });
    }
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (req.user.role === 'account_manager') {
      const advIds = getAMAdvertiserIds(req.user.id);
      if (!advIds.includes(c.advertiser_id)) {
        return res.status(403).json({ error: 'Campaign not assigned to your advertisers' });
      }
    }
    db.prepare("UPDATE campaigns SET status='archived', updated_at=unixepoch() WHERE id=?").run(c.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/campaigns/:id/tracking-url
router.get('/:id/tracking-url', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const c = db.prepare(`SELECT * FROM campaigns c WHERE c.id = ? AND (${clause})`).get(req.params.id, ...params);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  const base = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

  const urls = {
    test:      `${base}/track/click/${c.campaign_token}?pid=test&af_c_id=${c.id}&security_token=${c.security_token}&clickid=test_click_001&advertising_id=00000000-0000-0000-0000-000000000000&af_sub1=test`,
    standard:  `${base}/track/click/${c.campaign_token}?pid={publisher_id}&af_c_id=${c.id}&af_siteid={site_id}&af_sub1={sub1}&af_sub2={sub2}&af_sub3={sub3}&af_sub4={sub4}&af_sub5={sub5}&clickid={publisher_click_id}&advertising_id={gaid}`,
    adjust:    `${base}/track/click/${c.campaign_token}?pid={publisher_id}&af_c_id=${c.id}&adgroup={adgroup}&creative={creative}&label={label}&gps_adid={gps_adid}&idfa={idfa}&clickid={publisher_click_id}&af_sub1={sub1}&af_sub2={sub2}`,
    branch:    `${base}/track/click/${c.campaign_token}?pid={publisher_id}&af_c_id=${c.id}&~channel={channel}&~campaign=${encodeURIComponent(c.name)}&~feature=paid_advertising&clickid={publisher_click_id}&advertising_id={advertising_id}&af_sub1={sub1}`,
    impact:    `${base}/track/click/${c.campaign_token}?pid={publisher_id}&af_c_id=${c.id}&irclickid={irclickid}&mediapartnerid={media_partner_id}&clickid={irclickid}&af_sub1={sub1}&advertising_id={advertising_id}`,
    rakuten:   `${base}/track/click/${c.campaign_token}?pid={publisher_id}&af_c_id=${c.id}&mid={mid}&u1={u1}&u2={u2}&u3={u3}&clickid={u1}&advertising_id={advertising_id}`,
    affiliate: `${base}/track/click/${c.campaign_token}?pid={publisher_id}&af_c_id=${c.id}&aff_click_id={aff_click_id}&aff_sub={aff_sub}&aff_sub2={aff_sub2}&advertising_id={advertising_id}`,
    impression: `${base}/track/imp/${c.campaign_token}?pid={publisher_id}&clickid={publisher_click_id}&advertising_id={gaid}`,
  };

  const postback_macros = [
    { macro: '{click_id}',           desc: 'Publisher\'s click ID (sent in clickid= param)' },
    { macro: '{our_click_id}',       desc: 'Platform-generated click ID' },
    { macro: '{advertising_id}',     desc: 'GAID (Android) or IDFA (iOS)' },
    { macro: '{idfa}',               desc: 'Apple IDFA' },
    { macro: '{gps_adid}',           desc: 'Google Play Services Advertising ID' },
    { macro: '{payout}',             desc: 'Payout amount for this conversion' },
    { macro: '{revenue}',            desc: 'Revenue amount' },
    { macro: '{goal_name}',          desc: 'Matched goal name (install, purchase, etc.)' },
    { macro: '{event_name}',         desc: 'In-app event name' },
    { macro: '{country_code}',       desc: 'ISO 2-letter country code' },
    { macro: '{platform}',           desc: 'ios | android | web' },
    { macro: '{os}',                 desc: 'Operating system name' },
    { macro: '{install_unix_ts}',    desc: 'Install timestamp (Unix)' },
    { macro: '{sub1}–{sub10}',       desc: 'Passthrough sub-parameters' },
    { macro: '{creative_id}',        desc: 'Creative identifier' },
    { macro: '{campaign_id}',         desc: 'Campaign ID' },
    { macro: '{site_id}',             desc: 'Site / placement ID' },
    { macro: '{irclickid}',          desc: 'Impact Radius click ID' },
    { macro: '{mid}',                desc: 'Rakuten merchant ID' },
    { macro: '{channel}',            desc: 'Branch channel' },
    { macro: '{ip}',                 desc: 'User IP address' },
  ];

  // Get the account owner's postback_token
  const owner = db.prepare('SELECT postback_token FROM users WHERE id = ?').get(c.user_id);
  const postbackToken = owner?.postback_token || '';

  // Single acquisition postback URLs (account-level token, works for ALL campaigns)
  const acquisition = {
    install: `${base}/acquisition?click_id={click_id}&security_token=${postbackToken}&idfa={idfa}&gaid={gaid}`,
    event:   `${base}/acquisition?click_id={click_id}&security_token=${postbackToken}&idfa={idfa}&gaid={gaid}&goal_value={event_name}`,
  };

  res.json({ urls, acquisition, postback_macros, campaign: { id: c.id, name: c.name, token: c.campaign_token }, postback_token: postbackToken });
});

module.exports = router;
