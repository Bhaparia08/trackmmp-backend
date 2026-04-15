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

// GET /api/am/me — AM profile + stats summary
router.get('/me', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advertisers = db.prepare("SELECT COUNT(*) as n FROM users WHERE account_manager_id = ? AND role = 'advertiser'").get(am.id).n;
  const publishers  = db.prepare("SELECT COUNT(*) as n FROM users WHERE account_manager_id = ? AND role = 'publisher'").get(am.id).n;

  // Get campaigns linked to assigned advertisers
  const advIds = db.prepare("SELECT id FROM users WHERE account_manager_id = ? AND role = 'advertiser'").all(am.id).map(u => u.id);
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

  const advertisers = db.prepare(`
    SELECT u.id, u.email, u.name, u.company_name, u.status, u.plan, u.created_at,
           (SELECT COUNT(*) FROM campaigns c WHERE c.advertiser_id = u.id) as campaign_count,
           (SELECT COUNT(*) FROM clicks cl WHERE cl.user_id = u.id) as click_count
    FROM users u
    WHERE u.account_manager_id = ? AND u.role = 'advertiser'
    ORDER BY u.name ASC
  `).all(am.id);

  res.json(advertisers);
});

// GET /api/am/publishers — publishers assigned to this AM
router.get('/publishers', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const publishers = db.prepare(`
    SELECT u.id, u.email, u.name, u.company_name, u.status, u.created_at,
           p.pub_token, p.id as publisher_id,
           (SELECT COUNT(*) FROM clicks cl WHERE cl.publisher_id = p.id) as click_count,
           (SELECT COUNT(*) FROM postbacks pb WHERE pb.campaign_id IN (SELECT id FROM campaigns WHERE user_id = u.id) AND pb.status = 'attributed') as conversion_count
    FROM users u
    LEFT JOIN publishers p ON p.publisher_user_id = u.id
    WHERE u.account_manager_id = ? AND u.role = 'publisher'
    ORDER BY u.name ASC
  `).all(am.id);

  res.json(publishers);
});

// GET /api/am/campaigns — campaigns for assigned advertisers
router.get('/campaigns', requireAM, (req, res) => {
  const am = getAMRecord(req.user.id);
  if (!am) return res.status(404).json({ error: 'Account manager profile not found' });

  const advIds = db.prepare("SELECT id FROM users WHERE account_manager_id = ? AND role = 'advertiser'").all(am.id).map(u => u.id);
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

  const advIds = db.prepare("SELECT id FROM users WHERE account_manager_id = ? AND role = 'advertiser'").all(am.id).map(u => u.id);
  const pubIds = db.prepare("SELECT id FROM users WHERE account_manager_id = ? AND role = 'publisher'").all(am.id).map(u => u.id);

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

module.exports = router;
