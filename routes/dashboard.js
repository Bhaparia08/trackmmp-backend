const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const uid = req.user.id;
  const nowSec = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowSec - 86400;
  const twoDaysAgo = nowSec - 172800;

  // Last 24h KPIs
  const current = db.prepare(`SELECT
    COUNT(DISTINCT cl.id) AS clicks,
    COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
    COALESCE(SUM(pb.revenue),0) AS revenue
    FROM clicks cl LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status='attributed'
    WHERE cl.user_id = ? AND cl.created_at >= ?`).get(uid, oneDayAgo);

  // Prior 24h for delta
  const prior = db.prepare(`SELECT
    COUNT(DISTINCT cl.id) AS clicks,
    COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
    COALESCE(SUM(pb.revenue),0) AS revenue
    FROM clicks cl LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status='attributed'
    WHERE cl.user_id = ? AND cl.created_at >= ? AND cl.created_at < ?`).get(uid, twoDaysAgo, oneDayAgo);

  const leads24h = db.prepare(`SELECT COUNT(*) AS leads FROM postbacks
    WHERE user_id = ? AND status='attributed' AND event_type='lead' AND created_at >= ?`).get(uid, oneDayAgo);

  // 7-day trend
  const trend = db.prepare(`SELECT date, SUM(clicks) AS clicks, SUM(installs) AS installs,
    ROUND(SUM(revenue),2) AS revenue
    FROM daily_stats WHERE user_id = ? AND date >= date('now','-6 days')
    GROUP BY date ORDER BY date ASC`).all(uid);

  // Recent postbacks
  const recent = db.prepare(`SELECT pb.*, c.name AS campaign_name FROM postbacks pb
    LEFT JOIN campaigns c ON c.id = pb.campaign_id
    WHERE pb.user_id = ? ORDER BY pb.created_at DESC LIMIT 20`).all(uid);

  function pct(a, b) {
    if (!b) return a > 0 ? 100 : 0;
    return +(((a - b) / b) * 100).toFixed(1);
  }

  res.json({
    kpi: {
      clicks: current.clicks,
      clicks_delta: pct(current.clicks, prior.clicks),
      installs: current.installs,
      installs_delta: pct(current.installs, prior.installs),
      leads: leads24h.leads,
      revenue: +current.revenue.toFixed(2),
      revenue_delta: pct(current.revenue, prior.revenue),
    },
    trend,
    recent_postbacks: recent,
  });
});

module.exports = router;
