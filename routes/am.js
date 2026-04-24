const express = require('express');
const db = require('../db/init');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require account_manager role (or admin)
const requireAM = requireRole('account_manager', 'admin');

// Helper: get account manager record for logged-in user
function getAMRecord(userId) {
  return db.prepare('SELECT * FROM account_managers WHERE user_id = ?').get(userId);
}

// Helper: get all user IDs assigned to an AM (uses junction table + legacy FK)
function getAMUserIds(amId, role) {
  return db.prepare(`
    SELECT DISTINCT u.id FROM users u
    WHERE u.role = ? AND (
      u.account_manager_id = ?
      OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = u.id AND uam.account_manager_id = ?)
    )
  `).all(role, amId, amId).map(u => u.id);
}

// GET /api/am/me — AM profile + stats summary
router.get('/me', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advUserIds = getAMUserIds(am.id, 'advertiser');
  const pubUserIds = getAMUserIds(am.id, 'publisher');
  const advertisers = advUserIds.length;
  const publishers  = pubUserIds.length;

  // Get campaigns linked to assigned advertisers
  const advIds = advUserIds;
  let campaigns = 0, clicks = 0, conversions = 0, revenue = 0;

  if (advIds.length > 0) {
    const placeholders = advIds.map(() => '?').join(',');
    campaigns   = db.prepare(`SELECT COUNT(*) as n FROM campaigns WHERE advertiser_id IN (${placeholders})`).get(...advIds).n;
    clicks      = db.prepare(`SELECT COUNT(*) as n FROM clicks WHERE user_id IN (${placeholders})`).get(...advIds).n;
    conversions = db.prepare(`SELECT COUNT(*) as n FROM postbacks WHERE user_id IN (${placeholders}) AND status = 'attributed'`).get(...advIds).n;
    revenue     = db.prepare(`SELECT COALESCE(SUM(revenue),0) as r FROM postbacks WHERE user_id IN (${placeholders})`).get(...advIds).r;
  }

  res.json({ am, stats: { advertisers, publishers, campaigns, clicks, conversions, revenue } });
});

// GET /api/am/advertisers — advertisers assigned to this AM
router.get('/advertisers', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advIds = getAMUserIds(am.id, 'advertiser');
  if (advIds.length === 0) return res.json([]);
  const ph = advIds.map(() => '?').join(',');
  const advertisers = db.prepare(`
    SELECT u.id, u.email, u.name, u.company_name, u.status, u.plan, u.created_at, u.account_manager_id,
           (SELECT COUNT(*) FROM campaigns c WHERE c.advertiser_id = u.id) as campaign_count,
           (SELECT COUNT(*) FROM clicks cl WHERE cl.user_id = u.id) as click_count
    FROM users u
    WHERE u.id IN (${ph}) AND u.role = 'advertiser'
    ORDER BY u.name ASC
  `).all(...advIds);

  // Attach full AM list from junction table
  const amRows = db.prepare(`
    SELECT uam.user_id, am2.id AS am_id, am2.name, am2.email
    FROM user_account_managers uam JOIN account_managers am2 ON am2.id = uam.account_manager_id
    WHERE uam.user_id IN (${ph})
  `).all(...advIds);
  const amMap = {};
  for (const r of amRows) {
    if (!amMap[r.user_id]) amMap[r.user_id] = [];
    amMap[r.user_id].push({ id: r.am_id, name: r.name, email: r.email });
  }
  res.json(advertisers.map(a => ({ ...a, assigned_ams: amMap[a.id] || [] })));
});

// GET /api/am/publishers — publishers assigned to this AM
router.get('/publishers', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const pubIds = getAMUserIds(am.id, 'publisher');
  if (pubIds.length === 0) return res.json([]);
  const ph2 = pubIds.map(() => '?').join(',');
  const publishers = db.prepare(`
    SELECT u.id, u.email, u.name, u.company_name, u.status, u.created_at,
           p.pub_token, p.id as publisher_id,
           (SELECT COUNT(*) FROM clicks cl WHERE cl.publisher_id = p.id) as click_count,
           (SELECT COUNT(*) FROM postbacks pb WHERE pb.campaign_id IN (SELECT id FROM campaigns WHERE user_id = u.id) AND pb.status = 'attributed') as conversion_count
    FROM users u
    LEFT JOIN publishers p ON p.publisher_user_id = u.id
    WHERE u.id IN (${ph2}) AND u.role = 'publisher'
    ORDER BY u.name ASC
  `).all(...pubIds);

  res.json(publishers);
});

// GET /api/am/campaigns — campaigns for assigned advertisers
router.get('/campaigns', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advIds = getAMUserIds(am.id, 'advertiser');
  if (advIds.length === 0) return res.json([]);

  const placeholders = advIds.map(() => '?').join(',');
  const campaigns = db.prepare(`
    SELECT c.id, c.name, c.status, c.payout, c.payout_type, c.created_at,
           u.name as advertiser_name, u.company_name as advertiser_company,
           (SELECT COUNT(*) FROM clicks cl WHERE cl.campaign_id = c.id) as clicks,
           (SELECT COUNT(*) FROM postbacks pb WHERE pb.campaign_id = c.id AND pb.status = 'attributed') as conversions,
           (SELECT COALESCE(SUM(revenue),0) FROM postbacks pb WHERE pb.campaign_id = c.id) as revenue
    FROM campaigns c
    JOIN users u ON u.id = c.advertiser_id
    WHERE c.advertiser_id IN (${placeholders})
    ORDER BY c.created_at DESC
  `).all(...advIds);

  res.json(campaigns);
});

// GET /api/am/dashboard — combined KPIs for AM's accounts
router.get('/dashboard', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advIds = getAMUserIds(am.id, 'advertiser');
  const pubIds = getAMUserIds(am.id, 'publisher');

  let stats = { advertisers: advIds.length, publishers: pubIds.length, campaigns: 0, clicks: 0, conversions: 0, revenue: 0 };
  let recentPostbacks = [];

  if (advIds.length > 0) {
    const ph = advIds.map(() => '?').join(',');
    stats.campaigns   = db.prepare(`SELECT COUNT(*) as n FROM campaigns WHERE advertiser_id IN (${ph})`).get(...advIds).n;
    stats.clicks      = db.prepare(`SELECT COUNT(*) as n FROM clicks WHERE user_id IN (${ph})`).get(...advIds).n;
    stats.conversions = db.prepare(`SELECT COUNT(*) as n FROM postbacks WHERE user_id IN (${ph}) AND status = 'attributed'`).get(...advIds).n;
    stats.revenue     = db.prepare(`SELECT COALESCE(SUM(revenue),0) as r FROM postbacks WHERE user_id IN (${ph})`).get(...advIds).r;

    recentPostbacks = db.prepare(`
      SELECT pb.id, pb.event_type, pb.event_name, pb.payout, pb.revenue, pb.status, pb.created_at,
             c.name as campaign_name, pb.click_id
      FROM postbacks pb
      LEFT JOIN campaigns c ON c.id = pb.campaign_id
      WHERE pb.user_id IN (${ph})
      ORDER BY pb.created_at DESC LIMIT 20
    `).all(...advIds);
  }

  res.json({ am, stats, recentPostbacks });
});

// PUT /api/am/users/:id — edit an assigned advertiser or publisher
router.put('/users/:id', requireAM, async (req, res, next) => {
  try {
    const am = getAMRecord(req.user.id);
    if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

    // Only allow editing users assigned to this AM
    const user = db.prepare(`
      SELECT * FROM users WHERE id = ? AND role IN ('advertiser','publisher')
      AND (account_manager_id = ? OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = id AND uam.account_manager_id = ?))
    `).get(req.params.id, am.id, am.id);
    if (!user) return res.status(403).json({ error: 'User not found or not assigned to you' });

    const { name, company_name, status, password } = req.body;

    if (password) {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(password, 12);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
    }
    db.prepare(`UPDATE users SET
      name = COALESCE(?, name),
      company_name = COALESCE(?, company_name),
      status = COALESCE(?, status)
      WHERE id = ?`
    ).run(name || null, company_name || null, status || null, user.id);

    const updated = db.prepare('SELECT id, email, name, company_name, role, status, created_at FROM users WHERE id = ?').get(user.id);
    res.json(updated);
  } catch (err) { next(err); }
});

// GET /api/am/users/:id/integration — integration details for an assigned advertiser/publisher
router.get('/users/:id/integration', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const user = db.prepare(`
    SELECT * FROM users WHERE id = ? AND role IN ('advertiser','publisher')
    AND (account_manager_id = ? OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = id AND uam.account_manager_id = ?))
  `).get(req.params.id, am.id, am.id);
  if (!user) return res.status(403).json({ error: 'User not found or not assigned to you' });

  const base = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

  // For publishers — get their publisher record and global postback URL
  const publisher = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(user.id);

  // For advertisers — get their campaigns with tracking URLs
  const campaigns = db.prepare(`
    SELECT id, name, campaign_token, destination_url, postback_url, status, payout, payout_type, preview_url
    FROM campaigns WHERE advertiser_id = ? ORDER BY created_at DESC
  `).all(user.id);

  const campaignsWithUrls = campaigns.map(c => ({
    ...c,
    tracking_url: `${base}/track/click/${c.campaign_token}`,
    postback_pixel_url: `${base}/pixel.gif?cid={click_id}&event=install&payout={payout}`,
  }));

  res.json({
    user: { id: user.id, name: user.name, email: user.email, company_name: user.company_name, role: user.role, status: user.status },
    postback_token: user.postback_token,
    acquisition_postback: {
      install: `${base}/acquisition?click_id={click_id}&security_token=${user.postback_token}&idfa={idfa}&gaid={gaid}`,
      event: `${base}/acquisition?click_id={click_id}&security_token=${user.postback_token}&idfa={idfa}&gaid={gaid}&goal_value={event_name}`,
    },
    publisher: publisher ? {
      pub_token: publisher.pub_token,
      global_postback_url: publisher.global_postback_url || '',
      tracking_link_example: `${base}/track/click/{campaign_token}?pid=${publisher.pub_token}&clickid={your_click_id}`,
    } : null,
    campaigns: campaignsWithUrls,
  });
});

// POST /api/am/advertisers — create advertiser and auto-assign to this AM
router.post('/advertisers', requireAM, async (req, res, next) => {
  try {
    const am = getAMRecord(req.user.id);
    if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

    const { name, email, password, company_name } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(password, 12);
    const postback_token = require('crypto').randomBytes(16).toString('hex');

    const result = db.prepare(
      `INSERT INTO users (email, password, name, company_name, role, status, account_manager_id, postback_token)
       VALUES (?, ?, ?, ?, 'advertiser', 'active', ?, ?)`
    ).run(email, hash, name, company_name || null, am.id, postback_token);

    const user = db.prepare(`
      SELECT u.id, u.email, u.name, u.company_name, u.role, u.status, u.created_at, u.account_manager_id,
             am2.name AS account_manager_name, am2.email AS account_manager_email
      FROM users u LEFT JOIN account_managers am2 ON am2.id = u.account_manager_id
      WHERE u.id = ?`).get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PUT /api/am/advertisers/:id — edit/suspend assigned advertiser
router.put('/advertisers/:id', requireAM, async (req, res, next) => {
  try {
    const am = getAMRecord(req.user.id);
    if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

    const user = db.prepare(`
      SELECT * FROM users WHERE id = ? AND role = 'advertiser'
      AND (account_manager_id = ? OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = id AND uam.account_manager_id = ?))
    `).get(req.params.id, am.id, am.id);
    if (!user) return res.status(404).json({ error: 'Advertiser not found or not assigned to you' });

    const { name, company_name, status, password } = req.body;

    if (password) {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(password, 12);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
    }

    const setClauses = []; const setValues = [];
    if ('name'         in req.body) { setClauses.push('name = ?');         setValues.push(name); }
    if ('company_name' in req.body) { setClauses.push('company_name = ?'); setValues.push(company_name || null); }
    if ('status'       in req.body) { setClauses.push('status = ?');       setValues.push(status || 'active'); }
    if (setClauses.length > 0)
      db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...setValues, user.id);

    const updated = db.prepare(`
      SELECT u.id, u.email, u.name, u.company_name, u.role, u.status, u.created_at, u.account_manager_id,
             am2.name AS account_manager_name, am2.email AS account_manager_email
      FROM users u LEFT JOIN account_managers am2 ON am2.id = u.account_manager_id
      WHERE u.id = ?`).get(user.id);
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/am/publishers — create publisher user + entity, auto-assign to this AM
router.post('/publishers', requireAM, async (req, res, next) => {
  try {
    const am = getAMRecord(req.user.id);
    if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

    const { name, email, password, company_name, notes } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const bcrypt  = require('bcrypt');
    const crypto  = require('crypto');
    const hash    = await bcrypt.hash(password, 12);
    const postback_token = crypto.randomBytes(16).toString('hex');
    const pub_token      = crypto.randomBytes(5).toString('hex');

    const userRes = db.prepare(
      `INSERT INTO users (email, password, name, company_name, role, status, account_manager_id, postback_token)
       VALUES (?, ?, ?, ?, 'publisher', 'active', ?, ?)`
    ).run(email, hash, name, company_name || null, am.id, postback_token);

    const nextSeq = (db.prepare('SELECT MAX(seq_num) as m FROM publishers').get().m || 0) + 1;
    db.prepare(
      `INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token, status, notes, seq_num)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(req.user.id, userRes.lastInsertRowid, name, email, pub_token, notes || '', nextSeq);

    const user = db.prepare('SELECT id, email, name, company_name, role, status, created_at FROM users WHERE id = ?').get(userRes.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// GET /api/am/publisher-manager — publisher signups + campaign access requests for AM's accounts
router.get('/publisher-manager', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const pubUserIds = getAMUserIds(am.id, 'publisher');
  const publishers = pubUserIds.length === 0 ? [] : db.prepare(`
    SELECT u.id, u.seq_num, u.email, u.name, u.status, u.created_at, p.pub_token
    FROM users u
    LEFT JOIN publishers p ON p.publisher_user_id = u.id
    WHERE u.id IN (${pubUserIds.map(() => '?').join(',')}) AND u.role = 'publisher'
    ORDER BY u.created_at DESC
  `).all(...pubUserIds);

  const advIds = getAMUserIds(am.id, 'advertiser');
  let camReqs = [];
  if (advIds.length > 0) {
    const ph = advIds.map(() => '?').join(',');
    camReqs = db.prepare(`
      SELECT ca.id, ca.status, ca.created_at,
             u.name AS publisher_name, p.pub_token,
             c.name AS campaign_name, c.id AS campaign_id
      FROM campaign_access_requests ca
      JOIN publishers p ON p.id = ca.publisher_id
      JOIN users u ON u.id = p.publisher_user_id
      JOIN campaigns c ON c.id = ca.campaign_id
      WHERE c.advertiser_id IN (${ph})
      ORDER BY ca.created_at DESC
    `).all(...advIds);
  }

  res.json({ publishers, camReqs });
});

// GET /api/am/clicks — paginated clicks scoped to AM's advertisers' campaigns
router.get('/clicks', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advIds = getAMUserIds(am.id, 'advertiser');
  if (advIds.length === 0) return res.json({ data: [], total: 0, page: 1, limit: 50 });

  const { from, to, campaign_id, publisher_id, status, page = 1, limit = 50 } = req.query;
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 50), 500);
  const offset    = (Math.max(1, parseInt(page) || 1) - 1) * safeLimit;
  const ph        = advIds.map(() => '?').join(',');
  const conditions = [`cl.user_id IN (${ph})`];
  const values     = [...advIds];

  if (from)         { conditions.push("date(cl.created_at,'unixepoch') >= ?"); values.push(from); }
  if (to)           { conditions.push("date(cl.created_at,'unixepoch') <= ?"); values.push(to); }
  if (campaign_id)  { conditions.push('cl.campaign_id = ?');  values.push(campaign_id); }
  if (publisher_id) { conditions.push('cl.publisher_id = ?'); values.push(publisher_id); }
  if (status)       { conditions.push('cl.status = ?');       values.push(status); }

  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) as n FROM clicks cl WHERE ${where}`).get(...values).n;
  const data  = db.prepare(`
    SELECT cl.id, cl.click_id, cl.status, cl.country, cl.device_type, cl.os, cl.ip, cl.created_at,
           c.name AS campaign_name, p.name AS publisher_name
    FROM clicks cl
    LEFT JOIN campaigns c ON c.id = cl.campaign_id
    LEFT JOIN publishers p ON p.id = cl.publisher_id
    WHERE ${where} ORDER BY cl.created_at DESC LIMIT ? OFFSET ?
  `).all(...values, safeLimit, offset);

  res.json({ data, total, page: parseInt(page), limit: safeLimit });
});

// PUT /api/am/publishers/:id/postback — update global postback URL for an assigned publisher
router.put('/publishers/:id/postback', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const pub = db.prepare(`
    SELECT p.* FROM publishers p
    JOIN users u ON u.id = p.publisher_user_id
    WHERE p.id = ? AND (
      u.account_manager_id = ?
      OR EXISTS (SELECT 1 FROM user_account_managers uam WHERE uam.user_id = u.id AND uam.account_manager_id = ?)
    )
  `).get(req.params.id, am.id, am.id);
  if (!pub) return res.status(403).json({ error: 'Publisher not found or not assigned to you' });

  const { global_postback_url } = req.body;
  db.prepare('UPDATE publishers SET global_postback_url = ? WHERE id = ?').run(global_postback_url || '', pub.id);
  res.json({ success: true });
});

module.exports = router;
