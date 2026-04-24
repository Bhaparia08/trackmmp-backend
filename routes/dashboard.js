const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const oneDayAgo  = nowSec - 86400;
  const twoDaysAgo = nowSec - 172800;

  // admin sees all data; AM sees assigned advertisers; others see own
  const isAdmin = req.user.role === 'admin';
  const isAM    = req.user.role === 'account_manager';

  let userFilter, userParam, pbFilter, pbParam, dsFilter, dsParam;

  if (isAdmin) {
    userFilter = ''; userParam = [];
    pbFilter   = ''; pbParam   = [];
    dsFilter   = ''; dsParam   = [];
  } else if (isAM) {
    const amRec  = db.prepare('SELECT id FROM account_managers WHERE user_id = ?').get(req.user.id);
    const advIds = amRec
      ? db.prepare("SELECT id FROM users WHERE account_manager_id = ? AND role = 'advertiser'").all(amRec.id).map(u => u.id)
      : [];
    if (advIds.length > 0) {
      const ph = advIds.map(() => '?').join(',');
      userFilter = ` AND cl.user_id IN (${ph})`; userParam = advIds;
      pbFilter   = ` AND pb.user_id IN (${ph})`; pbParam   = advIds;
      dsFilter   = ` AND user_id IN (${ph})`;    dsParam   = advIds;
    } else {
      userFilter = ' AND 1=0'; userParam = [];
      pbFilter   = ' AND 1=0'; pbParam   = [];
      dsFilter   = ' AND 1=0'; dsParam   = [];
    }
  } else {
    userFilter = ' AND cl.user_id = ?'; userParam = [req.user.id];
    pbFilter   = ' AND pb.user_id = ?'; pbParam   = [req.user.id];
    dsFilter   = ' AND user_id = ?';    dsParam   = [req.user.id];
  }

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

  const leads24h = db.prepare(`SELECT COUNT(*) AS leads FROM postbacks pb
    WHERE pb.status='attributed' AND pb.event_type='lead' AND pb.created_at >= ?${pbFilter}`)
    .get(oneDayAgo, ...pbParam);

  // Impressions last 24h
  const impressions24h = db.prepare(`SELECT COALESCE(SUM(impressions),0) AS impressions
    FROM daily_stats WHERE date = date('now','utc')${dsFilter}`).get(...dsParam);

  // 7-day trend
  const trend = db.prepare(`SELECT date, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(installs) AS installs,
    ROUND(SUM(revenue),2) AS revenue
    FROM daily_stats WHERE date >= date('now','-6 days')${dsFilter}
    GROUP BY date ORDER BY date ASC`).all(...dsParam);

  // Recent postbacks
  const recent = db.prepare(`SELECT pb.*, c.name AS campaign_name FROM postbacks pb
    LEFT JOIN campaigns c ON c.id = pb.campaign_id
    WHERE 1=1${pbFilter} ORDER BY pb.created_at DESC LIMIT 20`).all(...pbParam);

  // Top 5 campaigns (by clicks last 7 days)
  const topCampaigns = db.prepare(`
    SELECT c.id, c.name, c.status,
      COALESCE(SUM(ds.clicks),0) AS clicks,
      COALESCE(SUM(ds.installs),0) AS installs,
      ROUND(COALESCE(SUM(ds.revenue),0),2) AS revenue,
      CASE WHEN SUM(ds.clicks)>0 THEN ROUND(CAST(SUM(ds.installs) AS REAL)/SUM(ds.clicks)*100,1) ELSE 0 END AS cr
    FROM campaigns c
    LEFT JOIN daily_stats ds ON ds.campaign_id = c.id AND ds.date >= date('now','-6 days')
    WHERE c.status != 'archived'${dsFilter.replace(/user_id/g, 'ds.user_id')}
    GROUP BY c.id ORDER BY clicks DESC LIMIT 5
  `).all(...dsParam);

  // Top 5 publishers (by clicks last 7 days)
  const topPublishers = db.prepare(`
    SELECT p.id, p.name, p.pub_token,
      COALESCE(SUM(ds.clicks),0) AS clicks,
      COALESCE(SUM(ds.installs),0) AS installs,
      ROUND(COALESCE(SUM(ds.revenue),0),2) AS revenue
    FROM publishers p
    LEFT JOIN daily_stats ds ON ds.publisher_id = p.id AND ds.date >= date('now','-6 days')
    WHERE p.status != 'deleted'${dsFilter.replace(/user_id/g, 'ds.user_id')}
    GROUP BY p.id ORDER BY clicks DESC LIMIT 5
  `).all(...dsParam);

  // Pending publisher signup approvals count
  const pendingPublishers = isAdmin
    ? db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='publisher' AND status='pending'").get().n
    : 0;

  // Pending campaign access requests count
  const pendingAccess = db.prepare(`
    SELECT COUNT(*) AS n FROM campaign_access_requests r
    JOIN campaigns c ON c.id = r.campaign_id
    WHERE r.status='pending'${isAdmin ? '' : dsFilter.replace(/user_id/g, 'c.user_id')}
  `).get(...(isAdmin ? [] : dsParam)).n;

  // Campaigns nearing their daily cap (>=80% used today)
  const capsNearing = isAdmin ? db.prepare(`
    SELECT c.id, c.name, c.cap_daily,
      COALESCE(SUM(ds.installs),0) AS used_today
    FROM campaigns c
    LEFT JOIN daily_stats ds ON ds.campaign_id=c.id AND ds.date=date('now','utc')
    WHERE c.cap_daily > 0 AND c.status='active'
    GROUP BY c.id
    HAVING used_today >= c.cap_daily*0.8
    LIMIT 5
  `).all() : [];

  function pct(a, b) {
    if (!b) return a > 0 ? 100 : 0;
    return +(((a - b) / b) * 100).toFixed(1);
  }

  res.json({
    kpi: {
      impressions: impressions24h.impressions,
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
    top_campaigns: topCampaigns,
    top_publishers: topPublishers,
    pending_publishers: pendingPublishers,
    pending_access: pendingAccess,
    caps_nearing: capsNearing,
  });
});

module.exports = router;
