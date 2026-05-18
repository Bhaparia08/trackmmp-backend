/**
 * /api/ai — AI-powered insights and suggestions
 * All routes require admin or account_manager role
 */
const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const ai = require('../utils/aiEngine');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin', 'account_manager'));

// GET /api/ai/daily-insights — AI analysis of today's performance
router.get('/daily-insights', async (req, res, next) => {
  try {
    // Gather today's data
    const kpi = db.prepare(`
      SELECT
        COALESCE(SUM(clicks),0) as clicks,
        COALESCE(SUM(installs),0) as installs,
        COALESCE(SUM(revenue),0) as revenue
      FROM daily_stats WHERE date = date('now')
    `).get();

    const yesterday = db.prepare(`
      SELECT
        COALESCE(SUM(clicks),0) as clicks,
        COALESCE(SUM(installs),0) as installs,
        COALESCE(SUM(revenue),0) as revenue
      FROM daily_stats WHERE date = date('now','-1 day')
    `).get();

    const topCampaigns = db.prepare(`
      SELECT c.name, ds.clicks, ds.installs, ds.revenue
      FROM daily_stats ds JOIN campaigns c ON c.id = ds.campaign_id
      WHERE ds.date = date('now') ORDER BY ds.revenue DESC LIMIT 5
    `).all();

    const topPublishers = db.prepare(`
      SELECT p.name, ds.clicks, ds.installs, ds.revenue
      FROM daily_stats ds JOIN publishers p ON p.id = ds.publisher_id
      WHERE ds.date = date('now') ORDER BY ds.revenue DESC LIMIT 5
    `).all();

    const recentFraud = db.prepare(`
      SELECT COUNT(*) as count FROM fraud_log
      WHERE date(created_at,'unixepoch') = date('now')
    `).get();

    const pendingApprovals = db.prepare(`
      SELECT COUNT(*) as count FROM users WHERE status = 'pending'
    `).get();

    const data = {
      today: kpi,
      yesterday,
      delta: {
        clicks_pct: yesterday.clicks > 0 ? ((kpi.clicks - yesterday.clicks) / yesterday.clicks * 100).toFixed(1) : 'N/A',
        installs_pct: yesterday.installs > 0 ? ((kpi.installs - yesterday.installs) / yesterday.installs * 100).toFixed(1) : 'N/A',
        revenue_pct: yesterday.revenue > 0 ? ((kpi.revenue - yesterday.revenue) / yesterday.revenue * 100).toFixed(1) : 'N/A',
      },
      topCampaigns,
      topPublishers,
      fraudEventsToday: recentFraud.count,
      pendingPublisherApprovals: pendingApprovals.count,
    };

    const insight = await ai.dailyInsights(data);
    res.json({ insight, data });
  } catch (err) { next(err); }
});

// POST /api/ai/fraud-analysis — explain a fraud event
router.post('/fraud-analysis', async (req, res, next) => {
  try {
    const { fraud_id } = req.body;
    if (!fraud_id) return res.status(400).json({ error: 'fraud_id required' });

    const fraud = db.prepare(`
      SELECT f.*, c.name as campaign_name
      FROM fraud_log f
      LEFT JOIN campaigns c ON c.id = f.campaign_id
      WHERE f.id = ?
    `).get(fraud_id);
    if (!fraud) return res.status(404).json({ error: 'Fraud event not found' });

    const analysis = await ai.fraudAnalysis(fraud);
    res.json({ analysis, fraud });
  } catch (err) { next(err); }
});

// POST /api/ai/review-publisher — AI review of publisher application
router.post('/review-publisher', async (req, res, next) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const user = db.prepare('SELECT id, name, email, company_name, status FROM users WHERE id = ?').get(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pub = db.prepare('SELECT * FROM publishers WHERE publisher_user_id = ?').get(user_id);

    const review = await ai.reviewPublisher({
      name: user.name,
      email: user.email,
      company: user.company_name,
      website_url: pub?.website_url || '',
      vertical: pub?.vertical || '',
      geo: pub?.geo || '',
      traffic_type: pub?.traffic_type || '',
      notes: pub?.notes || '',
    });
    res.json({ review, publisher: { ...user, website_url: pub?.website_url } });
  } catch (err) { next(err); }
});

// POST /api/ai/campaign-suggestions — AI optimization suggestions for a campaign
router.post('/campaign-suggestions', async (req, res, next) => {
  try {
    const { campaign_id } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Get performance data
    const stats7d = db.prepare(`
      SELECT date, clicks, installs, revenue
      FROM daily_stats WHERE campaign_id = ? AND date >= date('now','-7 days')
      ORDER BY date DESC
    `).all(campaign_id);

    const totalStats = db.prepare(`
      SELECT COALESCE(SUM(clicks),0) as clicks, COALESCE(SUM(installs),0) as installs,
             COALESCE(SUM(revenue),0) as revenue
      FROM daily_stats WHERE campaign_id = ?
    `).get(campaign_id);

    const topPubs = db.prepare(`
      SELECT p.name, ds.clicks, ds.installs, ds.revenue
      FROM daily_stats ds JOIN publishers p ON p.id = ds.publisher_id
      WHERE ds.campaign_id = ? ORDER BY ds.revenue DESC LIMIT 5
    `).all(campaign_id);

    const suggestions = await ai.campaignSuggestions({
      name: campaign.name,
      payout: campaign.payout,
      publisher_payout: campaign.publisher_payout,
      payout_type: campaign.payout_type,
      allowed_countries: campaign.allowed_countries,
      vertical: campaign.vertical,
      status: campaign.status,
      visibility: campaign.visibility,
      cap_daily: campaign.cap_daily,
      destination_url: campaign.destination_url,
      last7days: stats7d,
      totals: totalStats,
      topPublishers: topPubs,
      cr: totalStats.clicks > 0 ? (totalStats.installs / totalStats.clicks * 100).toFixed(1) : '0',
      epc: totalStats.clicks > 0 ? (totalStats.revenue / totalStats.clicks).toFixed(3) : '0',
    });
    res.json({ suggestions, stats: totalStats });
  } catch (err) { next(err); }
});

// POST /api/ai/explain-attribution — explain why a postback was attributed/rejected
router.post('/explain-attribution', async (req, res, next) => {
  try {
    const { postback_id } = req.body;
    if (!postback_id) return res.status(400).json({ error: 'postback_id required' });

    const pb = db.prepare(`
      SELECT pb.*, c.name as campaign_name, c.click_lookback_days
      FROM postbacks pb
      LEFT JOIN campaigns c ON c.id = pb.campaign_id
      WHERE pb.id = ?
    `).get(postback_id);
    if (!pb) return res.status(404).json({ error: 'Postback not found' });

    // Get the matching click if any
    const click = pb.click_id
      ? db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(pb.click_id)
      : null;

    const explanation = await ai.explainAttribution({
      postback: { event: pb.event_type, payout: pb.payout, status: pb.status, blocked_reason: pb.blocked_reason },
      campaign: { name: pb.campaign_name, lookback_days: pb.click_lookback_days },
      click: click ? { status: click.status, publisher_id: click.publisher_id, created_at: click.created_at, country: click.country } : 'No matching click found',
    });
    res.json({ explanation, postback: pb });
  } catch (err) { next(err); }
});

module.exports = router;
