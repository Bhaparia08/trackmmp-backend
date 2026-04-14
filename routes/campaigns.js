const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid12 } = require('../utils/clickId');

const router = express.Router();
router.use(requireAuth);

// Helper: build campaign WHERE clause based on role
function campaignFilter(user) {
  if (user.role === 'admin') return { clause: 'c.user_id = ?', params: [user.id] };
  if (user.role === 'advertiser') return { clause: 'c.advertiser_id = ?', params: [user.id] };
  return { clause: '1=0', params: [] }; // publishers use /api/publisher routes
}

router.get('/', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const rows = db.prepare(`
    SELECT c.*,
      COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id), 0) AS total_clicks,
      COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id AND status = 'installed'), 0) AS total_installs,
      COALESCE((SELECT SUM(revenue) FROM postbacks WHERE campaign_id = c.id AND status = 'attributed'), 0) AS total_revenue
    FROM campaigns c WHERE ${clause} ORDER BY c.created_at DESC
  `).all(...params);
  res.json(rows);
});

router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { name, advertiser_name, advertiser_id, app_id, payout = 0, payout_type = 'cpi',
            destination_url = '', postback_url = '', cap_daily = 0, cap_total = 0,
            allowed_countries = '', click_lookback_days = 7, is_retargeting = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const result = db.prepare(`
      INSERT INTO campaigns (user_id, advertiser_id, app_id, name, advertiser_name, campaign_token,
        payout, payout_type, destination_url, postback_url, cap_daily, cap_total,
        allowed_countries, click_lookback_days, is_retargeting)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, advertiser_id||null, app_id||null, name, advertiser_name||null, nanoid12(),
           payout, payout_type, destination_url, postback_url, cap_daily, cap_total,
           allowed_countries, click_lookback_days, is_retargeting ? 1 : 0);

    res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const { clause, params } = campaignFilter(req.user);
  const c = db.prepare(`SELECT * FROM campaigns c WHERE c.id = ? AND (${clause})`).get(req.params.id, ...params);
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

  res.json({ ...c, stats });
});

router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });

    const { name, advertiser_name, advertiser_id, payout, payout_type, destination_url, postback_url,
            status, cap_daily, cap_total, allowed_countries, click_lookback_days, is_retargeting } = req.body;

    db.prepare(`UPDATE campaigns SET
      name=COALESCE(?,name), advertiser_name=COALESCE(?,advertiser_name),
      advertiser_id=COALESCE(?,advertiser_id),
      payout=COALESCE(?,payout), payout_type=COALESCE(?,payout_type),
      destination_url=COALESCE(?,destination_url), postback_url=COALESCE(?,postback_url),
      status=COALESCE(?,status), cap_daily=COALESCE(?,cap_daily), cap_total=COALESCE(?,cap_total),
      allowed_countries=COALESCE(?,allowed_countries), click_lookback_days=COALESCE(?,click_lookback_days),
      is_retargeting=COALESCE(?,is_retargeting), updated_at=unixepoch()
      WHERE id=?`)
      .run(name||null, advertiser_name||null, advertiser_id??null, payout??null, payout_type||null,
           destination_url||null, postback_url||null, status||null,
           cap_daily??null, cap_total??null, allowed_countries||null,
           click_lookback_days??null, is_retargeting!=null?+is_retargeting:null, c.id);

    res.json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(c.id));
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
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

  const base = process.env.TRACKING_DOMAIN || 'http://localhost:3001';
  const afUrl = `${base}/track/click/${c.campaign_token}?pid={publisher_id}&c=${encodeURIComponent(c.name)}&af_c_id=${c.id}&af_siteid={site_id}&af_sub1={sub1}&af_sub2={sub2}&af_sub3={sub3}&af_sub4={sub4}&af_sub5={sub5}&clickid={publisher_click_id}&af_click_lookback=${c.click_lookback_days}d`;
  const adjustUrl = `${base}/track/click/${c.campaign_token}?campaign=${encodeURIComponent(c.name)}&adgroup={adgroup}&creative={creative}&label={label}&clickid={publisher_click_id}`;

  const macroLegend = [
    { macro: '{publisher_id}',       description: 'AF: publisher/media source ID (pid param)' },
    { macro: '{site_id}',            description: 'AF: publisher site or placement ID (af_siteid)' },
    { macro: '{sub1}–{sub5}',        description: 'AF: optional passthrough sub-parameters' },
    { macro: '{publisher_click_id}', description: 'Both: publisher\'s own click ID — returned in postback' },
    { macro: '{adgroup}',            description: 'Adjust: ad group name' },
    { macro: '{creative}',           description: 'Adjust: creative name' },
    { macro: '{label}',              description: 'Adjust: custom label data' },
  ];

  res.json({ tracking_url: afUrl, adjust_tracking_url: adjustUrl, macro_legend: macroLegend });
});

module.exports = router;
