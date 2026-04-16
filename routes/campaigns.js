const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid12, nanoid16 } = require('../utils/clickId');
const { customAlphabet } = require('nanoid');
const nanoid20hex = customAlphabet('0123456789abcdef', 20);

const router = express.Router();
router.use(requireAuth);

// Helper: build campaign WHERE clause based on role
function campaignFilter(user) {
  if (user.role === 'admin') return { clause: '1=1', params: [] }; // admin sees all campaigns
  if (user.role === 'account_manager') return { clause: '1=1', params: [] }; // AM sees all campaigns
  if (user.role === 'advertiser') return { clause: 'c.advertiser_id = ?', params: [user.id] };
  return { clause: '1=0', params: [] }; // publishers use /api/publisher routes
}

router.get('/', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const { include_archived } = req.query;
  const archivedClause = include_archived === '1' ? '' : " AND c.status != 'archived'";
  const rows = db.prepare(`
    SELECT c.*,
      COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id), 0) AS total_clicks,
      COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id AND status = 'installed'), 0) AS total_installs,
      COALESCE((SELECT SUM(revenue) FROM postbacks WHERE campaign_id = c.id AND status = 'attributed'), 0) AS total_revenue,
      COALESCE(u.name, NULLIF(c.advertiser_name,'')) AS advertiser_display,
      u.email AS advertiser_email
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.advertiser_id
    WHERE ${clause}${archivedClause} ORDER BY c.created_at DESC
  `).all(...params);
  res.json(rows);
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { name, advertiser_name, advertiser_id, app_id, payout = 0, payout_type = 'cpi',
            publisher_payout = 0, publisher_payout_type = 'cpi',
            destination_url = '', preview_url = '', postback_url = '', cap_daily = 0, cap_total = 0,
            allowed_countries = '', click_lookback_days = 7, is_retargeting = 0,
            visibility = 'open', approved_publishers = [], tags = '',
            geo_fallback_url = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = db.prepare(`
      INSERT INTO campaigns (user_id, advertiser_id, app_id, name, advertiser_name, campaign_token,
        security_token, payout, payout_type, publisher_payout, publisher_payout_type,
        destination_url, preview_url, postback_url, cap_daily, cap_total,
        allowed_countries, click_lookback_days, is_retargeting, visibility, tags, geo_fallback_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, advertiser_id||null, app_id||null, name, advertiser_name||null, nanoid12(),
           nanoid20hex(),
           payout, payout_type, publisher_payout, publisher_payout_type,
           destination_url, preview_url, postback_url, cap_daily, cap_total,
           allowed_countries, click_lookback_days, is_retargeting ? 1 : 0, visibility, tags||'',
           geo_fallback_url||'');

    const campaignId = result.lastInsertRowid;
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
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });

    const { name, advertiser_name, advertiser_id, payout, payout_type,
            publisher_payout, publisher_payout_type,
            destination_url, preview_url, postback_url,
            status, cap_daily, cap_total, allowed_countries, click_lookback_days,
            is_retargeting, visibility, approved_publishers, tags, geo_fallback_url } = req.body;

    db.prepare(`UPDATE campaigns SET
      name=COALESCE(?,name), advertiser_name=COALESCE(?,advertiser_name),
      advertiser_id=COALESCE(?,advertiser_id),
      payout=COALESCE(?,payout), payout_type=COALESCE(?,payout_type),
      publisher_payout=COALESCE(?,publisher_payout), publisher_payout_type=COALESCE(?,publisher_payout_type),
      destination_url=COALESCE(?,destination_url), preview_url=COALESCE(?,preview_url), postback_url=COALESCE(?,postback_url),
      status=COALESCE(?,status), cap_daily=COALESCE(?,cap_daily), cap_total=COALESCE(?,cap_total),
      allowed_countries=?, click_lookback_days=COALESCE(?,click_lookback_days),
      is_retargeting=COALESCE(?,is_retargeting), visibility=COALESCE(?,visibility),
      tags=COALESCE(?,tags), geo_fallback_url=?, updated_at=unixepoch()
      WHERE id=?`)
      .run(name||null, advertiser_name||null, advertiser_id??null, payout??null, payout_type||null,
           publisher_payout??null, publisher_payout_type||null,
           destination_url||null, preview_url||null, postback_url||null, status||null,
           cap_daily??null, cap_total??null,
           allowed_countries !== undefined ? allowed_countries : c.allowed_countries,
           click_lookback_days??null, is_retargeting!=null?+is_retargeting:null,
           visibility||null, tags!=null?tags:null, geo_fallback_url||'', c.id);

    if (Array.isArray(approved_publishers)) {
      upsertApprovedPublishers(c.id, approved_publishers, req.user.id);
    }

    const approvedPubs = db.prepare(
      "SELECT publisher_id FROM campaign_access_requests WHERE campaign_id = ? AND status = 'approved'"
    ).all(c.id).map(r => r.publisher_id);

    res.json({ ...db.prepare('SELECT * FROM campaigns WHERE id = ?').get(c.id), approved_publishers: approvedPubs });
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
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
    branch:    `${base}/track/click/${c.campaign_token}?~channel={channel}&~campaign=${encodeURIComponent(c.name)}&~feature=paid_advertising&clickid={publisher_click_id}&advertising_id={advertising_id}&af_sub1={sub1}`,
    impact:    `${base}/track/click/${c.campaign_token}?irclickid={irclickid}&mediapartnerid={media_partner_id}&clickid={irclickid}&af_sub1={sub1}&advertising_id={advertising_id}`,
    rakuten:   `${base}/track/click/${c.campaign_token}?mid={mid}&u1={u1}&u2={u2}&u3={u3}&clickid={u1}&advertising_id={advertising_id}`,
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
