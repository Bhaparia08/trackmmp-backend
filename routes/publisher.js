const express = require('express');
const db = require('../db/init');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('publisher', 'admin'));

// GET /api/publisher/profile — get own publisher record
router.get('/profile', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.status(404).json({ error: 'Publisher profile not found' });
  res.json(pub);
});

// GET /api/publisher/campaigns — active campaigns this publisher can see
// NOTE: advertiser payout (c.payout) is intentionally excluded — publishers only see publisher_payout
// private campaigns are hidden; approval_required shown with access status
router.get('/campaigns', (req, res) => {
  const pub = db.prepare('SELECT id FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  const pubId = pub?.id || 0;

  const campaigns = db.prepare(`
    SELECT c.id, c.name, c.advertiser_name, c.campaign_token,
           COALESCE(c.publisher_payout, 0) AS payout,
           COALESCE(c.publisher_payout_type, c.payout_type) AS payout_type,
           c.destination_url, c.click_lookback_days, c.status,
           COALESCE(c.visibility, 'open') AS visibility,
           c.preview_url, c.allowed_countries, COALESCE(c.tags, '') AS tags,
           COALESCE(c.description, '') AS description,
           COALESCE(c.channel, 'all') AS channel,
           COALESCE(c.allowed_devices, 'all') AS allowed_devices,
           COALESCE(c.featured, 0) AS featured,
           a.name AS app_name, a.platform AS app_platform,
           r.status AS access_status,
           COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id AND publisher_id = ?), 0) AS my_clicks,
           COALESCE((SELECT COUNT(*) FROM clicks WHERE campaign_id = c.id AND publisher_id = ? AND status='installed'), 0) AS my_installs,
           COALESCE((SELECT SUM(payout) FROM postbacks pb JOIN clicks cl ON cl.click_id = pb.click_id WHERE pb.campaign_id = c.id AND cl.publisher_id = ? AND pb.status='attributed'), 0) AS my_earnings
    FROM campaigns c
    LEFT JOIN apps a ON a.id = c.app_id
    LEFT JOIN campaign_access_requests r ON r.campaign_id = c.id AND r.publisher_id = ?
    WHERE c.status = 'active'
      AND COALESCE(c.visibility, 'open') != 'private'
    ORDER BY c.featured DESC, c.created_at DESC
  `).all(pubId, pubId, pubId, pubId);

  const enriched = campaigns.map(c => ({
    ...c,
    epc: c.my_clicks > 0 ? +(c.my_earnings / c.my_clicks).toFixed(4) : 0,
    cr:  c.my_clicks > 0 ? +((c.my_installs / c.my_clicks) * 100).toFixed(2) : 0,
  }));
  res.json(enriched);
});

// GET /api/publisher/tracking-url/:campaign_id — generate publisher-specific tracking link
router.get('/tracking-url/:campaign_id', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.status(404).json({ error: 'Publisher profile not found' });

  const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND status = ?').get(req.params.campaign_id, 'active');
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  // Visibility check
  const visibility = c.visibility || 'open';
  if (visibility === 'private') return res.status(403).json({ error: 'Campaign is private' });
  if (visibility === 'approval_required') {
    const access = db.prepare(
      "SELECT status FROM campaign_access_requests WHERE campaign_id = ? AND publisher_id = ?"
    ).get(c.id, pub.id);
    if (!access || access.status !== 'approved') {
      return res.status(403).json({ error: 'Access pending approval', access_status: access?.status || 'not_requested' });
    }
  }

  // Use configured domain, or derive from request host, fallback to production domain
  const base = process.env.TRACKING_DOMAIN
    || (req.hostname !== 'localhost' ? `${req.protocol}://${req.get('host')}` : null)
    || 'https://track.apogeemobi.com';

  // Publisher's PID is pre-filled. {CLICK_ID} is their ad network's click ID macro
  // placeholder — they replace it with the actual macro their network provides.
  const trackingUrl = `${base}/track/click/${c.campaign_token}`
    + `?pid=${pub.pub_token}`
    + `&clickid={CLICK_ID}`
    + `&sub1={SUB1}`
    + `&sub2={SUB2}`
    + `&sub3={SUB3}`;

  const pubPayout = c.publisher_payout ?? 0;
  const postbackUrl = `${base}/pb`
    + `?clickid={CLICK_ID}`
    + `&payout=${pubPayout}`
    + `&event=install`;

  res.json({
    tracking_url:  trackingUrl,
    postback_url:  postbackUrl,
    pub_token:     pub.pub_token,
    base_domain:   base,
    // Only expose publisher_payout to the publisher — never the advertiser's payout
    campaign: { id: c.id, name: c.name, payout: pubPayout, payout_type: c.publisher_payout_type || c.payout_type },
  });
});

// GET /api/publisher/stats — publisher's own performance stats
router.get('/stats', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.status(200).json({ clicks: 0, installs: 0, revenue: 0, campaigns: [] });

  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      COUNT(DISTINCT CASE WHEN cl.status='converted' THEN cl.id END) AS leads,
      COALESCE(SUM(pb.payout),0) AS revenue
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE cl.publisher_id = ?
  `).get(pub.id);

  const byCampaign = db.prepare(`
    SELECT c.name AS campaign_name, c.payout_type,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      COALESCE(SUM(pb.payout),0) AS revenue
    FROM clicks cl
    JOIN campaigns c ON c.id = cl.campaign_id
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE cl.publisher_id = ?
    GROUP BY c.id
    ORDER BY clicks DESC
    LIMIT 20
  `).all(pub.id);

  res.json({ ...totals, campaigns: byCampaign });
});

// GET /api/publisher/stats/by-day — time-series clicks/installs/revenue for publisher
router.get('/stats/by-day', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.json([]);
  const { from, to, campaign_id } = req.query;
  const conditions = ['cl.publisher_id = ?'];
  const values = [pub.id];
  if (from) { conditions.push("date(cl.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(cl.created_at,'unixepoch') <= ?"); values.push(to); }
  if (campaign_id) { conditions.push('cl.campaign_id = ?'); values.push(campaign_id); }
  const rows = db.prepare(`
    SELECT date(cl.created_at,'unixepoch') AS date,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      ROUND(COALESCE(SUM(pb.payout),0),2) AS revenue
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE ${conditions.join(' AND ')}
    GROUP BY date(cl.created_at,'unixepoch')
    ORDER BY date ASC
  `).all(...values);
  res.json(rows);
});

// GET /api/publisher/postbacks — recent postbacks for this publisher
router.get('/postbacks', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.json([]);

  const rows = db.prepare(`
    SELECT pb.*, c.name AS campaign_name
    FROM postbacks pb
    LEFT JOIN campaigns c ON c.id = pb.campaign_id
    WHERE pb.click_id IN (
      SELECT click_id FROM clicks WHERE publisher_id = ?
    )
    ORDER BY pb.created_at DESC LIMIT 100
  `).all(pub.id);
  res.json(rows);
});

// GET /api/publisher/settings — get publisher postback settings
router.get('/settings', (req, res) => {
  const pub = db.prepare('SELECT id, name, email, pub_token, global_postback_url FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.status(404).json({ error: 'Publisher profile not found' });
  res.json(pub);
});

// PUT /api/publisher/settings — save publisher postback settings
router.put('/settings', (req, res) => {
  const pub = db.prepare('SELECT id FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.status(404).json({ error: 'Publisher profile not found' });
  const { global_postback_url } = req.body;
  db.prepare('UPDATE publishers SET global_postback_url = ? WHERE id = ?')
    .run(global_postback_url || '', pub.id);
  res.json({ ok: true, global_postback_url: global_postback_url || '' });
});

module.exports = router;
