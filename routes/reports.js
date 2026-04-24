const express = require('express');
const db = require('../db/init');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
// Publishers use /api/publisher/stats instead; block them here
router.use(requireRole('admin', 'advertiser', 'account_manager'));

// Helper: advertiser IDs assigned to an account manager (junction table + legacy FK)
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

/* ── Role-aware data scope ───────────────────────────────────────────────────
   admin        → sees ALL data
   advertiser   → sees only their own user_id
   account_mgr  → sees data for all their assigned advertisers' user_ids
─────────────────────────────────────────────────────────────────────────────*/
function userScope(user, alias = '') {
  const col = alias ? `${alias}.user_id` : 'user_id';
  if (user.role === 'admin') return { clause: '1=1', params: [] };
  if (user.role === 'account_manager') {
    const advIds = getAMAdvertiserIds(user.id);
    if (advIds.length === 0) return { clause: '1=0', params: [] };
    const ph = advIds.map(() => '?').join(',');
    return { clause: `${col} IN (${ph})`, params: advIds };
  }
  return { clause: `${col} = ?`, params: [user.id] };
}

// Admin/AM: filter by a specific advertiser
function advertiserFilter(advertiser_id, alias = '') {
  if (!advertiser_id) return null;
  const col = alias ? `${alias}.campaign_id` : 'campaign_id';
  return { clause: `${col} IN (SELECT id FROM campaigns WHERE advertiser_id = ?)`, params: [advertiser_id] };
}

function dateFilter(from, to) {
  const conditions = [];
  const values = [];
  if (from) { conditions.push('date >= ?'); values.push(from); }
  if (to) { conditions.push('date <= ?'); values.push(to); }
  return { conditions, values };
}

// GET /api/reports/summary
router.get('/summary', (req, res) => {
  const { from, to, campaign_id, publisher_id, advertiser_id } = req.query;
  const { conditions, values } = dateFilter(from, to);
  const scope = userScope(req.user);
  conditions.push(scope.clause); values.push(...scope.params);
  if (campaign_id)  { conditions.push('campaign_id = ?');  values.push(campaign_id); }
  if (publisher_id) { conditions.push('publisher_id = ?'); values.push(publisher_id); }
  const af = advertiser_id && (req.user.role === 'admin' || req.user.role === 'account_manager') ? advertiserFilter(advertiser_id) : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const where = conditions.join(' AND ');
  const row = db.prepare(`SELECT
    SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(installs) AS installs,
    SUM(leads) AS leads, SUM(conversions) AS conversions,
    ROUND(SUM(revenue),2) AS revenue
    FROM daily_stats WHERE ${where}`).get(...values);

  const total_impressions = row.impressions || 0;
  const total_clicks = row.clicks || 0;
  const total_installs = row.installs || 0;
  const cr  = total_clicks > 0 ? ((total_installs / total_clicks) * 100).toFixed(2) : '0.00';
  const ctr = total_impressions > 0 ? ((total_clicks / total_impressions) * 100).toFixed(2) : '0.00';
  res.json({
    impressions: total_impressions,
    clicks: total_clicks,
    installs: total_installs,
    leads: row.leads || 0,
    conversions: row.conversions || 0,
    revenue: row.revenue || 0,
    conversion_rate: cr + '%',
    ctr: ctr + '%'
  });
});

// GET /api/reports/by-day
router.get('/by-day', (req, res) => {
  const { from, to, campaign_id, publisher_id, advertiser_id } = req.query;
  const { conditions, values } = dateFilter(from, to);
  const scope = userScope(req.user);
  conditions.push(scope.clause); values.push(...scope.params);
  if (campaign_id)  { conditions.push('campaign_id = ?');  values.push(campaign_id); }
  if (publisher_id) { conditions.push('publisher_id = ?'); values.push(publisher_id); }
  const af = advertiser_id && (req.user.role === 'admin' || req.user.role === 'account_manager') ? advertiserFilter(advertiser_id) : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const rows = db.prepare(`SELECT date, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(installs) AS installs,
    SUM(leads) AS leads, ROUND(SUM(revenue),2) AS revenue
    FROM daily_stats WHERE ${conditions.join(' AND ')}
    GROUP BY date ORDER BY date ASC`).all(...values);
  res.json(rows);
});

// GET /api/reports/by-campaign
router.get('/by-campaign', (req, res) => {
  const { from, to, advertiser_id } = req.query;
  const { conditions, values } = dateFilter(from, to);
  const scope = userScope(req.user, 'ds');
  conditions.push(scope.clause); values.push(...scope.params);
  const af = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'ds') : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const rows = db.prepare(`SELECT c.name AS campaign, c.id AS campaign_id,
    SUM(ds.clicks) AS clicks, SUM(ds.installs) AS installs,
    SUM(ds.leads) AS leads, ROUND(SUM(ds.revenue),2) AS revenue
    FROM daily_stats ds
    LEFT JOIN campaigns c ON c.id = ds.campaign_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY ds.campaign_id ORDER BY revenue DESC`).all(...values);
  res.json(rows);
});

// GET /api/reports/by-publisher
router.get('/by-publisher', (req, res) => {
  const { from, to, advertiser_id } = req.query;
  const { conditions, values } = dateFilter(from, to);
  const scope = userScope(req.user, 'ds');
  conditions.push(scope.clause); values.push(...scope.params);
  const af = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'ds') : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const rows = db.prepare(`SELECT p.name AS publisher, p.id AS publisher_id,
    SUM(ds.clicks) AS clicks, SUM(ds.installs) AS installs,
    SUM(ds.leads) AS leads, ROUND(SUM(ds.revenue),2) AS revenue
    FROM daily_stats ds
    LEFT JOIN publishers p ON p.id = ds.publisher_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY ds.publisher_id ORDER BY revenue DESC`).all(...values);
  res.json(rows);
});

// GET /api/reports/by-country
router.get('/by-country', (req, res) => {
  const { from, to, advertiser_id } = req.query;
  const scope = userScope(req.user, 'cl');
  const conditions = [scope.clause];
  const values = [...scope.params];
  if (from) { conditions.push("date(created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(created_at,'unixepoch') <= ?"); values.push(to); }
  const af = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'cl') : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const rows = db.prepare(`SELECT country, COUNT(*) AS clicks,
    SUM(CASE WHEN status='installed' THEN 1 ELSE 0 END) AS installs
    FROM clicks cl WHERE ${conditions.join(' AND ')}
    GROUP BY country ORDER BY clicks DESC LIMIT 50`).all(...values);
  res.json(rows);
});

// GET /api/reports/by-device
router.get('/by-device', (req, res) => {
  const { from, to, advertiser_id } = req.query;
  const scope = userScope(req.user, 'cl');
  const conditions = [scope.clause];
  const values = [...scope.params];
  if (from) { conditions.push("date(created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(created_at,'unixepoch') <= ?"); values.push(to); }
  const af = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'cl') : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const rows = db.prepare(`SELECT device_type, os, platform, COUNT(*) AS clicks,
    SUM(CASE WHEN status='installed' THEN 1 ELSE 0 END) AS installs
    FROM clicks cl WHERE ${conditions.join(' AND ')}
    GROUP BY device_type, os ORDER BY clicks DESC`).all(...values);
  res.json(rows);
});

// GET /api/reports/by-event
router.get('/by-event', (req, res) => {
  const { from, to, campaign_id, advertiser_id } = req.query;
  const scope = userScope(req.user);
  const conditions = [scope.clause, "status = 'attributed'"];
  const values = [...scope.params];
  if (from) { conditions.push("date(created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(created_at,'unixepoch') <= ?"); values.push(to); }
  if (campaign_id) { conditions.push('campaign_id = ?'); values.push(campaign_id); }
  const af = advertiser_id && (req.user.role === 'admin' || req.user.role === 'account_manager') ? advertiserFilter(advertiser_id) : null;
  if (af) { conditions.push(af.clause); values.push(...af.params); }

  const rows = db.prepare(`SELECT event_type, event_name, COUNT(*) AS count,
    SUM(revenue) AS revenue FROM postbacks
    WHERE ${conditions.join(' AND ')}
    GROUP BY event_type, event_name ORDER BY count DESC`).all(...values);
  res.json(rows);
});

// GET /api/reports/by-goal
router.get('/by-goal', (req, res) => {
  const { from, to, campaign_id, advertiser_id } = req.query;
  const scope = userScope(req.user, 'pb');
  const conditions = [scope.clause, "pb.status = 'attributed'"];
  const values = [...scope.params];
  if (from) { conditions.push("date(pb.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(pb.created_at,'unixepoch') <= ?"); values.push(to); }
  if (campaign_id) { conditions.push('pb.campaign_id = ?'); values.push(campaign_id); }
  const afGoal = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'pb') : null;
  if (afGoal) { conditions.push(afGoal.clause); values.push(...afGoal.params); }

  const rows = db.prepare(`
    SELECT pb.goal_name, pb.event_type, pb.event_name,
      COUNT(*) AS conversions,
      ROUND(SUM(pb.payout),2) AS payout,
      ROUND(SUM(pb.revenue),2) AS revenue
    FROM postbacks pb
    WHERE ${conditions.join(' AND ')}
    GROUP BY COALESCE(pb.goal_name, pb.event_type)
    ORDER BY conversions DESC
  `).all(...values);
  res.json(rows);
});

// GET /api/reports/by-sub
router.get('/by-sub', (req, res) => {
  const { from, to, campaign_id, advertiser_id, sub = 'af_sub1' } = req.query;
  const allowedSubs = ['af_sub1','af_sub2','af_sub3','af_sub4','af_sub5','sub6','sub7','sub8','sub9','sub10','pid'];
  const col = allowedSubs.includes(sub) ? sub : 'af_sub1';
  const scope = userScope(req.user, 'cl');
  const conditions = [scope.clause];
  const values = [...scope.params];
  if (from) { conditions.push("date(cl.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(cl.created_at,'unixepoch') <= ?"); values.push(to); }
  if (campaign_id) { conditions.push('cl.campaign_id = ?'); values.push(campaign_id); }
  const afSub = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'cl') : null;
  if (afSub) { conditions.push(afSub.clause); values.push(...afSub.params); }

  const rows = db.prepare(`
    SELECT cl.${col} AS sub_value,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      ROUND(COALESCE(SUM(pb.revenue),0),2) AS revenue
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE ${conditions.join(' AND ')}
    GROUP BY cl.${col}
    ORDER BY clicks DESC LIMIT 100
  `).all(...values);
  res.json(rows);
});

// GET /api/reports/by-os
router.get('/by-os', (req, res) => {
  const { from, to, advertiser_id } = req.query;
  const scope = userScope(req.user, 'cl');
  const conditions = [scope.clause];
  const values = [...scope.params];
  if (from) { conditions.push("date(cl.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(cl.created_at,'unixepoch') <= ?"); values.push(to); }
  const afOs = advertiser_id && req.user.role === 'admin' ? advertiserFilter(advertiser_id, 'cl') : null;
  if (afOs) { conditions.push(afOs.clause); values.push(...afOs.params); }

  const rows = db.prepare(`
    SELECT cl.os, cl.platform,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status='installed' THEN cl.id END) AS installs,
      ROUND(COALESCE(SUM(pb.revenue),0),2) AS revenue
    FROM clicks cl
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE ${conditions.join(' AND ')}
    GROUP BY cl.os ORDER BY clicks DESC
  `).all(...values);
  res.json(rows);
});

// GET /api/reports/postbacks
router.get('/postbacks', (req, res) => {
  const { campaign_id, status, event_type, from, to, page = 1, limit = 50 } = req.query;
  const scope = userScope(req.user, 'pb');
  const conditions = [scope.clause];
  const values = [...scope.params];

  if (campaign_id) { conditions.push('pb.campaign_id = ?'); values.push(campaign_id); }
  if (status)      { conditions.push('pb.status = ?'); values.push(status); }
  if (event_type)  { conditions.push('pb.event_type = ?'); values.push(event_type); }
  if (from) { conditions.push("date(pb.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)   { conditions.push("date(pb.created_at,'unixepoch') <= ?"); values.push(to); }

  const where = conditions.join(' AND ');
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const total = db.prepare(`SELECT COUNT(*) as n FROM postbacks pb WHERE ${where}`).get(...values).n;

  const rows = db.prepare(`
    SELECT pb.id, pb.click_id, pb.publisher_click_id, pb.event_type, pb.event_name,
           pb.goal_name, pb.payout, pb.revenue, pb.currency, pb.status,
           pb.blocked_reason, pb.advertising_id, pb.ip, pb.created_at,
           pb.is_view_through,
           c.name AS campaign_name, c.campaign_token
    FROM postbacks pb
    LEFT JOIN campaigns c ON c.id = pb.campaign_id
    WHERE ${where}
    ORDER BY pb.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, parseInt(limit), offset);

  const summaryScope = userScope(req.user);
  const summaryWhere = summaryScope.clause === '1=1' ? '1=1' : 'user_id = ?';
  const summaryParams = summaryScope.params;
  const summary = db.prepare(`
    SELECT status, COUNT(*) as count, COALESCE(SUM(revenue),0) as revenue
    FROM postbacks WHERE ${summaryWhere}
    GROUP BY status
  `).all(...summaryParams);

  res.json({ rows, total, page: parseInt(page), limit: parseInt(limit), summary });
});

// GET /api/reports/fraud-summary
router.get('/fraud-summary', (req, res) => {
  const scope = userScope(req.user);
  const where = scope.clause === '1=1' ? '1=1' : 'user_id = ?';
  const rows = db.prepare(`
    SELECT fraud_type, COUNT(*) as count, action
    FROM fraud_log WHERE ${where}
    GROUP BY fraud_type, action ORDER BY count DESC
  `).all(...scope.params);
  res.json(rows);
});

module.exports = router;
