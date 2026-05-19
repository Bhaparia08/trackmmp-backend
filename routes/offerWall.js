const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/offer-wall — list public campaigns (no auth required)
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const {
      vertical,
      geo,
      payout_type,
      min_payout,
      sort = 'featured',
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // Build WHERE clauses
    const conditions = [
      "COALESCE(c.visibility, 'open') = 'open'",
      "c.status = 'active'",
    ];
    const params = [];

    if (vertical) {
      conditions.push("LOWER(c.vertical) = LOWER(?)");
      params.push(vertical);
    }

    if (geo) {
      // allowed_countries is a comma-separated string; match if it contains the code
      conditions.push("(c.allowed_countries = '' OR c.allowed_countries LIKE '%' || ? || '%')");
      params.push(geo.toUpperCase());
    }

    if (payout_type) {
      conditions.push("LOWER(COALESCE(c.publisher_payout_type, c.payout_type)) = LOWER(?)");
      params.push(payout_type);
    }

    if (min_payout) {
      const minVal = parseFloat(min_payout);
      if (!isNaN(minVal)) {
        conditions.push("COALESCE(c.publisher_payout, 0) >= ?");
        params.push(minVal);
      }
    }

    if (search) {
      conditions.push("c.name LIKE '%' || ? || '%'");
      params.push(search);
    }

    const whereClause = conditions.join(' AND ');

    // Sort
    let orderClause;
    switch (sort) {
      case 'payout_desc':
        orderClause = 'COALESCE(c.publisher_payout, 0) DESC';
        break;
      case 'payout_asc':
        orderClause = 'COALESCE(c.publisher_payout, 0) ASC';
        break;
      case 'newest':
        orderClause = 'c.created_at DESC';
        break;
      case 'featured':
      default:
        orderClause = 'COALESCE(c.featured, 0) DESC, c.created_at DESC';
        break;
    }

    // Count total
    const countRow = db.prepare(
      `SELECT COUNT(*) AS total FROM campaigns c WHERE ${whereClause}`
    ).get(...params);
    const total = countRow?.total || 0;

    // Main query — only expose publisher-safe fields
    const rows = db.prepare(`
      SELECT
        c.id,
        c.name,
        COALESCE(c.description, '')                       AS description,
        COALESCE(c.publisher_payout, 0)                   AS publisher_payout,
        COALESCE(c.publisher_payout_type, c.payout_type)  AS publisher_payout_type,
        COALESCE(c.allowed_countries, '')                  AS allowed_countries,
        COALESCE(c.vertical, '')                           AS vertical,
        COALESCE(c.tags, '')                               AS tags,
        COALESCE(c.featured, 0)                            AS featured,
        COALESCE(c.preview_url, '')                        AS preview_url,
        COALESCE((
          SELECT COUNT(DISTINCT cl.publisher_id)
          FROM clicks cl
          WHERE cl.campaign_id = c.id
        ), 0) AS active_publishers,
        COALESCE((
          SELECT SUM(ds.clicks) FROM daily_stats ds WHERE ds.campaign_id = c.id
        ), 0) AS total_clicks,
        COALESCE((
          SELECT SUM(ds.installs) FROM daily_stats ds WHERE ds.campaign_id = c.id
        ), 0) AS total_installs
      FROM campaigns c
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    res.json({
      campaigns: rows,
      page: pageNum,
      limit: limitNum,
      total,
      total_pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error('[OfferWall] list error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/offer-wall/:id — single campaign detail (no auth required)
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;

    const campaign = db.prepare(`
      SELECT
        c.id,
        c.name,
        COALESCE(c.description, '')                       AS description,
        COALESCE(c.publisher_payout, 0)                   AS publisher_payout,
        COALESCE(c.publisher_payout_type, c.payout_type)  AS publisher_payout_type,
        COALESCE(c.allowed_countries, '')                  AS allowed_countries,
        COALESCE(c.vertical, '')                           AS vertical,
        COALESCE(c.tags, '')                               AS tags,
        COALESCE(c.featured, 0)                            AS featured,
        COALESCE(c.preview_url, '')                        AS preview_url,
        COALESCE((
          SELECT COUNT(DISTINCT cl.publisher_id)
          FROM clicks cl
          WHERE cl.campaign_id = c.id
        ), 0) AS active_publishers,
        COALESCE((
          SELECT SUM(ds.clicks) FROM daily_stats ds WHERE ds.campaign_id = c.id
        ), 0) AS total_clicks,
        COALESCE((
          SELECT SUM(ds.installs) FROM daily_stats ds WHERE ds.campaign_id = c.id
        ), 0) AS total_installs
      FROM campaigns c
      WHERE c.id = ?
        AND COALESCE(c.visibility, 'open') = 'open'
        AND c.status = 'active'
    `).get(id);

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Fetch goals (publisher-safe fields only)
    const goals = db.prepare(`
      SELECT id, name, event_name, payout, payout_type, is_default, status
      FROM campaign_goals
      WHERE campaign_id = ? AND status = 'active'
      ORDER BY is_default DESC, id ASC
    `).all(id);

    res.json({ ...campaign, goals });
  } catch (err) {
    console.error('[OfferWall] detail error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/offer-wall/:id/apply — authenticated publisher applies to campaign
// ---------------------------------------------------------------------------
router.post('/:id/apply', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'publisher') {
      return res.status(403).json({ error: 'Only publishers can apply to campaigns' });
    }

    const campaignId = req.params.id;

    // Verify campaign exists, is active and open
    const campaign = db.prepare(`
      SELECT id FROM campaigns
      WHERE id = ? AND status = 'active' AND COALESCE(visibility, 'open') = 'open'
    `).get(campaignId);

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Get publisher record
    const pub = db.prepare(
      'SELECT id FROM publishers WHERE publisher_user_id = ?'
    ).get(req.user.id);

    if (!pub) return res.status(400).json({ error: 'Publisher profile not found' });

    // Check for existing request
    const existing = db.prepare(
      'SELECT id, status FROM campaign_access_requests WHERE campaign_id = ? AND publisher_id = ?'
    ).get(campaignId, pub.id);

    if (existing) {
      return res.json({ applied: true, status: existing.status, message: 'Already applied' });
    }

    // Create access request
    db.prepare(`
      INSERT INTO campaign_access_requests (campaign_id, publisher_id, user_id, status)
      VALUES (?, ?, ?, 'pending')
    `).run(campaignId, pub.id, req.user.id);

    res.json({ applied: true, status: 'pending' });
  } catch (err) {
    console.error('[OfferWall] apply error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
