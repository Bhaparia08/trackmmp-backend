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
const { lookupCountry } = require('../utils/geoip');
const { parseDevice }   = require('../utils/deviceParser');
const serveCache        = require('../utils/serveCache');

const router = express.Router();

// Rate limit: 300 req/min per key
router.use(rateLimit({ windowMs: 60_000, max: 300, keyGenerator: (req) => req.headers['x-api-key'] || req.query.api_key || req.ip }));
router.use(requireApiKey);

const TRACKING_BASE = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

// ─── GET /api/v1/campaigns ───────────────────────────────────────────────────
router.get('/campaigns', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE id = ?').get(req.publisherId);
  if (!pub) return res.json({ data: [] });

  const { tags } = req.query;

  // Build campaign list: exclude private campaigns; for approval_required, only show if publisher is approved
  const conditions = [
    "c.status = 'active'",
    "COALESCE(c.visibility, 'open') != 'private'",
    `(COALESCE(c.visibility, 'open') != 'approval_required'
      OR EXISTS (SELECT 1 FROM campaign_access_requests r WHERE r.campaign_id = c.id AND r.publisher_id = ? AND r.status = 'approved'))`,
  ];
  const params = [req.publisherId];

  if (tags) {
    // Filter by tag — support comma-separated multi-tag (any match)
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      const tagConditions = tagList.map(() => "INSTR(',' || LOWER(c.tags) || ',', ',' || LOWER(?) || ',') > 0");
      conditions.push(`(${tagConditions.join(' OR ')})`);
      params.push(...tagList);
    }
  }

  const campaigns = db.prepare(`
    SELECT c.id, c.name, c.advertiser_name, c.campaign_token,
           COALESCE(c.publisher_payout, 0) AS payout,
           COALESCE(c.publisher_payout_type, c.payout_type) AS payout_type,
           c.allowed_countries, c.click_lookback_days, c.cap_daily, c.cap_total, c.status,
           COALESCE(c.visibility, 'open') AS visibility,
           COALESCE(c.tags, '') AS tags,
           a.name AS app_name, a.platform AS app_platform, a.bundle_id
    FROM campaigns c
    LEFT JOIN apps a ON a.id = c.app_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY c.created_at DESC
  `).all(...params);

  // Attach publisher-specific tracking URL and goals to each campaign
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

// ─── GET /api/v1/offers/:id ──────────────────────────────────────────────────
router.get('/offers/:id', (req, res) => {
  const pub = db.prepare('SELECT * FROM publishers WHERE id = ?').get(req.publisherId);
  if (!pub) return res.status(404).json({ error: 'Publisher not found' });

  const c = db.prepare(`
    SELECT c.id, c.name, c.advertiser_name, c.campaign_token,
           COALESCE(c.publisher_payout, 0) AS payout,
           COALESCE(c.publisher_payout_type, c.payout_type) AS payout_type,
           c.allowed_countries, c.click_lookback_days, c.cap_daily, c.cap_total, c.status,
           COALESCE(c.visibility, 'open') AS visibility,
           COALESCE(c.tags, '') AS tags,
           c.preview_url,
           a.name AS app_name, a.platform AS app_platform, a.bundle_id
    FROM campaigns c
    LEFT JOIN apps a ON a.id = c.app_id
    WHERE c.id = ? AND c.status = 'active'
      AND COALESCE(c.visibility, 'open') != 'private'
  `).get(req.params.id);

  if (!c) return res.status(404).json({ error: 'Offer not found' });

  // Enforce approval_required access
  if (c.visibility === 'approval_required') {
    const access = db.prepare(
      "SELECT status FROM campaign_access_requests WHERE campaign_id = ? AND publisher_id = ?"
    ).get(c.id, req.publisherId);
    if (!access || access.status !== 'approved') {
      return res.status(403).json({ error: 'Access pending approval', access_status: access?.status || 'not_requested' });
    }
  }

  const goals = db.prepare(`
    SELECT id, name, event_name, payout, payout_type, revenue
    FROM campaign_goals WHERE campaign_id = ? AND status = 'active'
  `).all(c.id);

  res.json({
    ...c,
    tracking_url: `${TRACKING_BASE}/track/click/${c.campaign_token}?pid=${pub.pub_token}&clickid={your_click_id}&af_sub1={sub1}&af_sub2={sub2}&af_sub3={sub3}`,
    postback_url: `${TRACKING_BASE}/acquisition?click_id={your_click_id}&security_token={advertiser_security_token}&gaid={gaid}&idfa={idfa}`,
    goals,
    publisher: { id: pub.id, name: pub.name, pub_token: pub.pub_token },
  });
});

// ─── GET /api/v1/placements ──────────────────────────────────────────────────
// Lists active placements visible to this api key's publisher. Used by the
// WordPress plugin's settings page to populate a "test connection" dropdown
// and validate slugs before the editor types them into shortcodes.
router.get('/placements', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.slug, p.name, p.placement_type, p.format, p.max_offers,
           i.id AS inventory_id, i.name AS inventory_name,
           i.vertical AS inventory_vertical, i.geo AS inventory_geo, i.type AS inventory_type
    FROM placements p
    JOIN owned_inventory i ON i.id = p.inventory_id
    WHERE p.status = 'active' AND i.status = 'active' AND i.publisher_id = ?
    ORDER BY i.name ASC, p.slug ASC
  `).all(req.publisherId);
  res.json({ placements: rows });
});

// ─── GET /api/v1/serve ───────────────────────────────────────────────────────
// Returns approved campaigns for a placement, filtered by visitor context.
// Used by the WordPress plugin and other publisher integrations.
//
// Query params:
//   placement_slug | placement_id  (one required)
//   country  — ISO-3166 alpha-2 (optional; falls back to GeoIP from request IP)
//   device   — 'mobile' | 'tablet' | 'desktop' (optional; falls back to UA parse)
//   os       — 'android' | 'ios' | 'windows' | 'macos' | 'linux' (optional)
//   limit    — override placement.max_offers (capped at 50)
//   nocache  — '1' to bypass the cache (debugging only)
router.get('/serve', async (req, res, next) => {
  try {
    const pubId = req.publisherId;
    const { placement_slug, placement_id, limit, nocache } = req.query;

    if (!placement_slug && !placement_id) {
      return res.status(400).json({ error: 'placement_slug or placement_id is required' });
    }

    // Resolve placement → must belong to inventory under this api-key's publisher.
    const placement = placement_id
      ? db.prepare(`
          SELECT p.*, i.id AS inv_id, i.name AS inv_name, i.vertical AS inv_vertical,
                 i.geo AS inv_geo, i.publisher_id AS inv_publisher_id
          FROM placements p
          JOIN owned_inventory i ON i.id = p.inventory_id
          WHERE p.id = ? AND p.status = 'active' AND i.status = 'active' AND i.publisher_id = ?
        `).get(Number(placement_id), pubId)
      : db.prepare(`
          SELECT p.*, i.id AS inv_id, i.name AS inv_name, i.vertical AS inv_vertical,
                 i.geo AS inv_geo, i.publisher_id AS inv_publisher_id
          FROM placements p
          JOIN owned_inventory i ON i.id = p.inventory_id
          WHERE p.slug = ? AND p.status = 'active' AND i.status = 'active' AND i.publisher_id = ?
        `).get(placement_slug, pubId);

    if (!placement) {
      return res.status(404).json({ error: 'Placement not found or not authorized for this api key' });
    }

    // Resolve visitor context — explicit query params first, then fall back to req.
    let country = (req.query.country || '').toUpperCase().trim();
    if (!country) {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      country = ((await lookupCountry(ip)) || '').toUpperCase();
    }

    let device = (req.query.device || '').toLowerCase().trim();
    let os     = (req.query.os || '').toLowerCase().trim();
    if (!device || !os) {
      const ua = req.headers['user-agent'] || '';
      const parsed = parseDevice(ua);
      if (!device) device = (parsed.device_type || '').toLowerCase();
      if (!os)     os     = (parsed.os || '').toLowerCase();
    }

    const cacheKey = `serve:${placement.id}:${country}:${device}:${os}`;
    if (nocache !== '1') {
      const cached = serveCache.get(cacheKey);
      if (cached) {
        return res.json({ ...cached, cached: true, cache_key: cacheKey });
      }
    }

    // Approved campaigns for this inventory. LEFT JOIN to the highest-weight
    // active creative per campaign so the response carries rich offer data
    // (logo, headline, bonus, rating, terms, CTA copy) when available.
    const offers = db.prepare(`
      SELECT c.id, c.name, c.advertiser_name, c.campaign_token, c.payout, c.payout_type,
             c.vertical, c.tags, c.allowed_countries, c.allowed_devices, c.preview_url,
             c.destination_url,
             cia.priority, cia.weight,
             cre.logo_url, cre.hero_image_url, cre.brand_name, cre.headline,
             cre.subheadline, cre.bonus_amount, cre.bonus_label, cre.terms_short,
             cre.cta_text, cre.rating, cre.rating_count, cre.badge_text, cre.badge_color
      FROM campaign_inventory_approvals cia
      JOIN campaigns c ON c.id = cia.campaign_id
      LEFT JOIN campaign_creatives cre ON cre.id = (
        SELECT id FROM campaign_creatives
        WHERE campaign_id = c.id AND status = 'active'
        ORDER BY weight DESC, id ASC LIMIT 1
      )
      WHERE cia.inventory_id = ?
        AND cia.status = 'approved'
        AND c.status   = 'active'
        AND COALESCE(c.visibility, 'open') != 'private'
    `).all(placement.inv_id);

    // Country/device filter
    const filtered = offers.filter((o) => {
      if (country && o.allowed_countries && o.allowed_countries.trim() !== '') {
        const allowed = o.allowed_countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(country)) return false;
      }
      if (device && o.allowed_devices && o.allowed_devices.trim() !== '' && o.allowed_devices.toLowerCase() !== 'all') {
        const allowed = o.allowed_devices.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(device)) return false;
      }
      return true;
    });

    // Sort: priority DESC, then weighted random within priority tier.
    // Weighted random within tier — pick by cumulative weight.
    const byPriority = new Map();
    for (const o of filtered) {
      const key = o.priority || 0;
      if (!byPriority.has(key)) byPriority.set(key, []);
      byPriority.get(key).push(o);
    }
    const sortedPriorities = [...byPriority.keys()].sort((a, b) => b - a);
    const ordered = [];
    for (const pr of sortedPriorities) {
      const group = byPriority.get(pr);
      // Weighted-random shuffle within tier
      while (group.length > 0) {
        const totalWeight = group.reduce((s, o) => s + (o.weight || 1), 0);
        let r = Math.random() * totalWeight;
        let pickIdx = group.length - 1;
        for (let i = 0; i < group.length; i++) {
          r -= (group[i].weight || 1);
          if (r <= 0) { pickIdx = i; break; }
        }
        ordered.push(group.splice(pickIdx, 1)[0]);
      }
    }

    const maxN  = Math.min(50, Number(limit) || placement.max_offers || 1);
    const top   = ordered.slice(0, maxN);
    const pub   = db.prepare('SELECT pub_token FROM publishers WHERE id = ?').get(pubId);
    const TRACKING_BASE = process.env.TRACKING_DOMAIN || 'https://track.apogeemobi.com';

    const offersOut = top.map((o) => ({
      campaign_id:     o.id,
      name:            o.name,
      advertiser_name: o.advertiser_name,
      vertical:        o.vertical,
      tags:            o.tags,
      payout:          o.payout,
      payout_type:     o.payout_type,
      preview_url:     o.preview_url,
      // Creative fields — null when no creative is configured. The WP plugin
      // falls back to the bare campaign name + payout in that case.
      creative: o.brand_name || o.headline || o.logo_url ? {
        brand_name:     o.brand_name,
        headline:       o.headline,
        subheadline:    o.subheadline,
        logo_url:       o.logo_url,
        hero_image_url: o.hero_image_url,
        bonus_amount:   o.bonus_amount,
        bonus_label:    o.bonus_label,
        terms_short:    o.terms_short,
        cta_text:       o.cta_text || 'Get Offer',
        rating:         o.rating,
        rating_count:   o.rating_count,
        badge_text:     o.badge_text,
        badge_color:    o.badge_color,
      } : null,
      tracking_url: `${TRACKING_BASE}/track/click/${o.campaign_token}` +
        `?pid=${pub.pub_token}&inv=${placement.inv_id}&pl=${placement.id}&clickid={your_click_id}`,
    }));

    const response = {
      placement: {
        id:    placement.id,
        slug:  placement.slug,
        type:  placement.placement_type,
        format:placement.format,
      },
      inventory: {
        id:       placement.inv_id,
        name:     placement.inv_name,
        vertical: placement.inv_vertical,
        geo:      placement.inv_geo,
      },
      visitor: { country, device, os },
      offers:  offersOut,
      ttl:     60,
      cached:  false,
    };

    if (nocache !== '1') serveCache.set(cacheKey, response, 60_000);
    res.json(response);
  } catch (err) { next(err); }
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
