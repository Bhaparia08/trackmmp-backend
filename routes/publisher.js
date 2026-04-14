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

// GET /api/publisher/campaigns — active campaigns this publisher can run
router.get('/campaigns', (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.id, c.name, c.advertiser_name, c.campaign_token, c.payout, c.payout_type,
           c.destination_url, c.click_lookback_days, c.status,
           a.name AS app_name, a.platform AS app_platform
    FROM campaigns c
    LEFT JOIN apps a ON a.id = c.app_id
    WHERE c.status = 'active'
    ORDER BY c.created_at DESC
  `).all();
  res.json(campaigns);
});

// GET /api/publisher/tracking-url/:campaign_id — generate publisher-specific tracking link
router.get('/tracking-url/:campaign_id', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(req.user.id);
  if (!pub) return res.status(404).json({ error: 'Publisher profile not found' });

  const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND status = ?').get(req.params.campaign_id, 'active');
  if (!c) return res.status(404).json({ error: 'Campaign not found' });

  const base = process.env.TRACKING_DOMAIN || 'http://localhost:3001';
  const trackingUrl = `${base}/track/click/${c.campaign_token}?pid=${pub.pub_token}&clickid={your_click_id}&af_sub1={sub1}&af_sub2={sub2}`;

  const postbackUrl = `${base}/pb?clickid={your_click_id}&payout=${c.payout}&event=install`;

  res.json({
    tracking_url: trackingUrl,
    postback_url: postbackUrl,
    pub_token: pub.pub_token,
    campaign: { id: c.id, name: c.name, payout: c.payout, payout_type: c.payout_type },
    instructions: {
      step1: `Place the tracking URL in your ad creative. Replace {your_click_id} with your own unique click ID.`,
      step2: `Configure your ad network to fire the postback URL when a conversion occurs. Replace {your_click_id} with the same ID you used in step 1.`,
    }
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

module.exports = router;
