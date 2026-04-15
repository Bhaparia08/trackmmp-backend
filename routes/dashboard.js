const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const oneDayAgo  = nowSec - 86400;
  const twoDaysAgo = nowSec - 172800;

  // admin sees all data; other roles see only their own
  const isAdmin = req.user.role === 'admin';
  const userFilter = isAdmin ? '' : ' AND cl.user_id = ?';
  const userParam  = isAdmin ? [] : [req.user.id];
  const pbFilter   = isAdmin ? '' : ' AND pb.user_id = ?';
  const pbParam    = isAdmin ? [] : [req.user.id];
  const dsFilter   = isAdmin ? '' : ' AND user_id = ?';
  const dsParam    = isAdmin ? [] : [req.user.id];

  // Last 24h KPIs
  const current = db.prepare(`SELECT
    COUNT(DISTINCT cl.id) AS clicks,
    COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
    COALESCE(SUM(pb.revenue),0) AS revenue
    FROM clicks cl LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status='attributed'
    WHERE cl.created_at >= ?${userFilter}`)
    .get(oneDayAgo, ...userParam);

  // Prior 24h for delta
  const prior = db.prepare(`SELECT
    COUNT(DISTINCT cl.id) AS clicks,
    COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
    COALESCE(SUM(pb.revenue),0) AS revenue
    FROM clicks cl LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status='attributed'
    WHERE cl.created_at >= ? AND cl.created_at < ?${userFilter}`)
    .get(twoDaysAgo, oneDayAgo, ...userParam);

  const leads24h = db.prepare(`SELECT COUNT(*) AS leads FROM postbacks
    WHERE status='attributed' AND event_type='lead' AND created_at >= ?${pbFilter}`)
    .get(oneDayAgo, ...pbParam);

  // 7-day trend
  const trend = db.prepare(`SELECT date, SUM(clicks) AS clicks, SUM(installs) AS installs,
    ROUND(SUM(revenue),2) AS revenue
    FROM daily_stats WHERE date >= date('now','-6 days')${dsFilter}
    GROUP BY date ORDER BY date ASC`).all(...dsParam);

  // Recent postbacks
  const recent = db.prepare(`SELECT pb.*, c.name AS campaign_name FROM postbacks pb
    LEFT JOIN campaigns c ON c.id = pb.campaign_id
    WHERE 1=1${pbFilter} ORDER BY pb.created_at DESC LIMIT 20`).all(...pbParam);

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
