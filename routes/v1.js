/**
 * /api/v1  — Public REST API for publisher partners
 *
 * Authentication: x-api-key header  OR  ?api_key= query param
 *
 * Endpoints:
 *   GET /api/v1/campaigns          — approved/active campaigns
 *   GET /api/v1/clicks             — click log for this publisher
 *   GET /api/v1/postbacks          — conversion log (installs, events) with GAID/IDFA/payout
 *   GET /api/v1/stats              — aggregate performance stats
 */
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const db         = require('../db/init');
const { requireApiKey } = require('../middleware/apiKeyAuth');

const router = express.Router();

// Rate limit: 300 req/min per key
router.use(rateLimit({ windowMs: 60_000, max: 300, keyGenerator: (req) => req.headers['x-api-key'] || req.query.api_key || req.ip }));
router.use(requireApiKey);

const TRACKING_BASE = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

// ─── GET /api/v1/campaigns ───────────────────────────────────────────────────
router.get('/campaigns', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE id = ?').get(req.publisherId);
  if (!pub) return res.json({ data: [] });

  const campaigns = db.prepare(`
    SELECT c.id, c.name, c.advertiser_name, c.campaign_token, c.payout, c.payout_type,
           c.allowed_countries, c.click_lookback_days, c.cap_daily, c.cap_total, c.status,
           a.name AS app_name, a.platform AS app_platform, a.bundle_id
    FROM campaigns c
    LEFT JOIN apps a ON a.id = c.app_id
    WHERE c.status = 'active'
    ORDER BY c.created_at DESC
  `).all();

  // Attach publisher-specific tracking URL and postback instructions to each campaign
  const data = campaigns.map(c => {
    const goals = db.prepare(`
      SELECT id, name, event_name, payout, payout_type, revenue
      FROM campaign_goals WHERE campaign_id = ? AND status = 'active'
    `).all(c.id);

    return {
      ...c,
      tracking_url: `${TRACKING_BASE}/track/click/${c.campaign_token}?pid=${pub.pub_token}&clickid={your_click_id}&af_sub1={sub1}&af_sub2={sub2}&af_sub3={sub3}`,
      postback_url: `${TRACKING_BASE}/acquisition?click_id={your_click_id}&security_token={advertiser_security_token}&gaid={gaid}&idfa={idfa}`,
      goals,
    };
  });

  res.json({ data, publisher: { id: pub.id, name: pub.name, pub_token: pub.pub_token } });
});

// ─── GET /api/v1/clicks ─────────────────────────────────────────────────────
router.get('/clicks', (req, res) => {
  const { campaign_id, status, from, to, page = 1, limit = 100 } = req.query;
  const offset = (Math.max(1, +page) - 1) * Math.min(500, +limit);
  const lim    = Math.min(500, +limit);

  const conditions = ['cl.publisher_id = ?'];
  const params     = [req.publisherId];

  if (campaign_id) { conditions.push('cl.campaign_id = ?'); params.push(campaign_id); }
  if (status)      { conditions.push('cl.status = ?');      params.push(status); }
  if (from)        { conditions.push("date(cl.created_at, 'unixepoch') >= ?"); params.push(from); }
  if (to)          { conditions.push("date(cl.created_at, 'unixepoch') <= ?"); params.push(to); }

  const where = conditions.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM clicks cl WHERE ${where}`).get(...params).n;

  const rows = db.prepare(`
    SELECT cl.click_id, cl.publisher_click_id, cl.campaign_id, c.name AS campaign_name,
           cl.status, cl.country, cl.device_type, cl.os, cl.platform,
           cl.advertising_id AS gaid, cl.advertising_id, cl.idfa,
           cl.af_sub1 AS sub1, cl.af_sub2 AS sub2, cl.af_sub3 AS sub3,
           cl.af_sub4 AS sub4, cl.af_sub5 AS sub5,
           cl.sub6, cl.sub7, cl.sub8, cl.sub9, cl.sub10,
           cl.ip, cl.created_at
    FROM clicks cl
    LEFT JOIN campaigns c ON c.id = cl.campaign_id
    WHERE ${where}
    ORDER BY cl.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, offset);

  res.json({ data: rows, total, page: +page, limit: lim, pages: Math.ceil(total / lim) });
});

// ─── GET /api/v1/postbacks ───────────────────────────────────────────────────
router.get('/postbacks', (req, res) => {
  const { campaign_id, event_type, status, from, to, page = 1, limit = 100 } = req.query;
  const offset = (Math.max(1, +page) - 1) * Math.min(500, +limit);
  const lim    = Math.min(500, +limit);

  // Scope to this publisher's clicks
  const conditions = [`pb.click_id IN (SELECT click_id FROM clicks WHERE publisher_id = ?)`];
  const params     = [req.publisherId];

  if (campaign_id) { conditions.push('pb.campaign_id = ?'); params.push(campaign_id); }
  if (event_type)  { conditions.push('pb.event_type = ?');  params.push(event_type); }
  if (status)      { conditions.push('pb.status = ?');       params.push(status); }
  if (from)        { conditions.push("date(pb.created_at, 'unixepoch') >= ?"); params.push(from); }
  if (to)          { conditions.push("date(pb.created_at, 'unixepoch') <= ?"); params.push(to); }

  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM postbacks pb WHERE ${where}`).get(...params).n;

  const rows = db.prepare(`
    SELECT
      pb.id, pb.click_id, pb.publisher_click_id,
      pb.campaign_id, c.name AS campaign_name,
      pb.event_type, pb.event_name, pb.event_value,
      pb.payout, pb.revenue, pb.currency,
      pb.advertising_id AS gaid, pb.advertising_id,
      pb.idfa, pb.idfv, pb.android_id,
      pb.status, pb.blocked_reason,
      pb.goal_name, pb.install_unix_ts,
      pb.created_at
    FROM postbacks pb
    LEFT JOIN campaigns c ON c.id = pb.campaign_id
    WHERE ${where}
    ORDER BY pb.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, offset);

  res.json({ data: rows, total, page: +page, limit: lim, pages: Math.ceil(total / lim) });
});

// ─── GET /api/v1/stats ───────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const { from, to, campaign_id } = req.query;

  const clickConds = ['cl.publisher_id = ?'];
  const clickParams = [req.publisherId];
  if (campaign_id) { clickConds.push('cl.campaign_id = ?'); clickParams.push(campaign_id); }
  if (from) { clickConds.push("date(cl.created_at, 'unixepoch') >= ?"); clickParams.push(from); }
  if (to)   { clickConds.push("date(cl.created_at, 'unixepoch') <= ?"); clickParams.push(to); }

  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      COUNT(DISTINCT CASE WHEN cl.status='converted' THEN cl.id END) AS events,
      COALESCE(SUM(pb.payout), 0) AS payout
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE ${clickConds.join(' AND ')}
  `).get(...clickParams);

  // Per-campaign breakdown
  const byCampaign = db.prepare(`
    SELECT c.id, c.name, c.payout_type,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      COUNT(DISTINCT CASE WHEN cl.status='converted' THEN cl.id END) AS events,
      COALESCE(SUM(pb.payout), 0) AS payout
    FROM clicks cl
    JOIN campaigns c ON c.id = cl.campaign_id
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE ${clickConds.join(' AND ')}
    GROUP BY c.id ORDER BY clicks DESC LIMIT 50
  `).all(...clickParams);

  // Daily breakdown
  const daily = db.prepare(`
    SELECT date(cl.created_at, 'unixepoch') AS date,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      COALESCE(SUM(pb.payout), 0) AS payout
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE ${clickConds.join(' AND ')}
    GROUP BY date ORDER BY date DESC LIMIT 30
  `).all(...clickParams);

  res.json({ totals, by_campaign: byCampaign, daily });
});

module.exports = router;
