/**
 * Datascape-style custom report builder.
 *
 * POST /api/preview/datascape/query  — assemble + run a report
 * GET  /api/preview/datascape/schema — list available dimensions/metrics
 * GET  /api/preview/datascape/saved  — saved views per user
 * POST /api/preview/datascape/saved  — save a view
 * DELETE /api/preview/datascape/saved/:id
 *
 * SAFETY: dimension and metric names are STRICTLY whitelisted. The user-supplied
 * payload only chooses keys from these whitelists; the actual SQL fragments are
 * pulled from server-side definitions. Date filters and string filters are
 * parameterised. No user input ever reaches a raw SQL string.
 */

const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── Whitelisted dimensions ──────────────────────────────────────────────────
const DIMENSIONS = {
  date: {
    label: 'Date',
    select: 'ds.date',
    group: 'ds.date',
    order: 'ds.date',
  },
  campaign: {
    label: 'Campaign',
    select: "COALESCE(c.name, '(none)') AS campaign",
    group: 'ds.campaign_id, c.name',
    order: 'c.name',
    joins: ['LEFT JOIN campaigns c ON c.id = ds.campaign_id'],
  },
  publisher: {
    label: 'Publisher',
    select: "COALESCE(p.name, '(direct)') AS publisher",
    group: 'ds.publisher_id, p.name',
    order: 'p.name',
    joins: ['LEFT JOIN publishers p ON p.id = ds.publisher_id'],
  },
  advertiser: {
    label: 'Advertiser',
    select: "COALESCE(adv.name, '(none)') AS advertiser",
    group: 'c.advertiser_id, adv.name',
    order: 'adv.name',
    joins: [
      'LEFT JOIN campaigns c ON c.id = ds.campaign_id',
      'LEFT JOIN users adv ON adv.id = c.advertiser_id',
    ],
  },
  app: {
    label: 'App',
    select: "COALESCE(a.name, '(web)') AS app",
    group: 'ds.app_id, a.name',
    order: 'a.name',
    joins: ['LEFT JOIN apps a ON a.id = ds.app_id'],
  },
  vertical: {
    label: 'Vertical',
    select: "COALESCE(NULLIF(c.vertical,''), '(uncategorized)') AS vertical",
    group: 'c.vertical',
    order: 'c.vertical',
    joins: ['LEFT JOIN campaigns c ON c.id = ds.campaign_id'],
  },
};

// ── Whitelisted metrics ─────────────────────────────────────────────────────
const METRICS = {
  impressions:    { label: 'Impressions',     select: 'COALESCE(SUM(ds.impressions),0) AS impressions',     type: 'int' },
  clicks:         { label: 'Clicks',          select: 'COALESCE(SUM(ds.clicks),0) AS clicks',               type: 'int' },
  installs:       { label: 'Installs',        select: 'COALESCE(SUM(ds.installs),0) AS installs',           type: 'int' },
  leads:          { label: 'Leads',           select: 'COALESCE(SUM(ds.leads),0) AS leads',                 type: 'int' },
  conversions:    { label: 'Conversions',     select: 'COALESCE(SUM(ds.conversions),0) AS conversions',     type: 'int' },
  re_engagements: { label: 'Re-engagements',  select: 'COALESCE(SUM(ds.re_engagements),0) AS re_engagements', type: 'int' },
  revenue:        { label: 'Revenue ($)',     select: 'ROUND(COALESCE(SUM(ds.revenue),0),2) AS revenue',    type: 'money' },
  ctr:            { label: 'CTR %',           select: "CASE WHEN SUM(ds.impressions) > 0 THEN ROUND(100.0 * SUM(ds.clicks) / SUM(ds.impressions), 2) ELSE 0 END AS ctr", type: 'pct' },
  cvr:            { label: 'CVR % (Click → Install)', select: "CASE WHEN SUM(ds.clicks) > 0 THEN ROUND(100.0 * SUM(ds.installs) / SUM(ds.clicks), 2) ELSE 0 END AS cvr", type: 'pct' },
  arpu:           { label: 'ARPU ($)',        select: "CASE WHEN SUM(ds.installs) > 0 THEN ROUND(SUM(ds.revenue) / SUM(ds.installs), 2) ELSE 0 END AS arpu", type: 'money' },
  epc:            { label: 'EPC ($)',         select: "CASE WHEN SUM(ds.clicks) > 0 THEN ROUND(SUM(ds.revenue) / SUM(ds.clicks), 4) ELSE 0 END AS epc", type: 'money' },
  ecpm:           { label: 'eCPM ($)',        select: "CASE WHEN SUM(ds.impressions) > 0 THEN ROUND(1000.0 * SUM(ds.revenue) / SUM(ds.impressions), 2) ELSE 0 END AS ecpm", type: 'money' },
};

router.get('/datascape/schema', (req, res) => {
  res.json({
    dimensions: Object.entries(DIMENSIONS).map(([id, d]) => ({ id, label: d.label })),
    metrics: Object.entries(METRICS).map(([id, m]) => ({ id, label: m.label, type: m.type })),
  });
});

router.post('/datascape/query', (req, res, next) => {
  try {
    const {
      dimensions = [], metrics = [],
      from, to, campaign_id, publisher_id, advertiser_id,
      limit = 200, sort, sort_dir = 'desc',
    } = req.body || {};

    // Validate dimensions
    const validDims = dimensions.filter(d => DIMENSIONS[d]);
    if (validDims.length === 0) return res.status(400).json({ error: 'At least one dimension required.' });

    // Validate metrics (default to clicks+installs+revenue if none picked)
    const validMets = (metrics.length ? metrics : ['clicks', 'installs', 'revenue']).filter(m => METRICS[m]);
    if (validMets.length === 0) return res.status(400).json({ error: 'At least one metric required.' });

    // SELECT clause
    const dimSelects = validDims.map(d => DIMENSIONS[d].select);
    const metSelects = validMets.map(m => METRICS[m].select);
    const selectClause = [...dimSelects, ...metSelects].join(',\n  ');

    // JOIN clause (dedup)
    const joins = new Set();
    for (const d of validDims) {
      for (const j of (DIMENSIONS[d].joins || [])) joins.add(j);
    }
    // advertiser_id filter needs the campaigns join
    if (advertiser_id) joins.add('LEFT JOIN campaigns c ON c.id = ds.campaign_id');
    const joinClause = Array.from(joins).join('\n  ');

    // WHERE clause
    const where = [];
    const params = [];

    // Role-scoped data access — admin sees all, advertiser sees their own,
    // publisher sees their own publisher rows.
    if (req.user.role === 'advertiser') {
      where.push('ds.user_id = ?'); params.push(req.user.id);
    } else if (req.user.role === 'publisher') {
      where.push('ds.publisher_id IN (SELECT id FROM publishers WHERE publisher_user_id = ? OR user_id = ?)');
      params.push(req.user.id, req.user.id);
    } // admin + account_manager: full scope (no filter)

    if (from) { where.push('ds.date >= ?'); params.push(from); }
    if (to)   { where.push('ds.date <= ?'); params.push(to); }
    if (campaign_id)   { where.push('ds.campaign_id = ?'); params.push(campaign_id); }
    if (publisher_id)  { where.push('ds.publisher_id = ?'); params.push(publisher_id); }
    if (advertiser_id) { where.push('c.advertiser_id = ?'); params.push(advertiser_id); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // GROUP BY (dimensions)
    const groupClause = 'GROUP BY ' + validDims.map(d => DIMENSIONS[d].group).join(', ');

    // ORDER BY — if sort key matches a chosen metric, sort by it; else first dim
    let orderCol;
    if (sort && METRICS[sort] && validMets.includes(sort)) orderCol = sort;
    else if (sort && DIMENSIONS[sort] && validDims.includes(sort)) orderCol = sort;
    else orderCol = validMets[0] || validDims[0];
    const orderDir = String(sort_dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const orderClause = `ORDER BY ${orderCol} ${orderDir}`;

    const safeLimit = Math.max(1, Math.min(2000, parseInt(limit) || 200));

    const sql = `
      SELECT
  ${selectClause}
      FROM daily_stats ds
      ${joinClause}
      ${whereClause}
      ${groupClause}
      ${orderClause}
      LIMIT ${safeLimit}
    `;

    const rows = db.prepare(sql).all(...params);

    // Columns = chosen dimensions + chosen metrics, in order
    const columns = [
      ...validDims.map(d => ({ id: d, label: DIMENSIONS[d].label, kind: 'dim' })),
      ...validMets.map(m => ({ id: m, label: METRICS[m].label, kind: 'metric', type: METRICS[m].type })),
    ];

    res.json({
      rows,
      columns,
      total_rows: rows.length,
      // include the assembled SQL for transparency / debugging (handy in preview)
      meta: { sql: sql.trim(), params_count: params.length },
    });
  } catch (err) { next(err); }
});

// ── Saved views ─────────────────────────────────────────────────────────────
// Lazy-create the table on first POST (kept inside this route to keep the
// feature self-contained while in preview).
function ensureSavedViewsTable() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS datascape_views (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      config       TEXT    NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `).run();
}
ensureSavedViewsTable();

router.get('/datascape/saved', (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, config, created_at FROM datascape_views WHERE user_id = ? ORDER BY created_at DESC`
  ).all(req.user.id);
  res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config) })));
});

router.post('/datascape/saved', (req, res, next) => {
  try {
    const { name, config } = req.body || {};
    if (!name || !config) return res.status(400).json({ error: 'name + config required' });
    const r = db.prepare(
      `INSERT INTO datascape_views (user_id, name, config) VALUES (?,?,?)`
    ).run(req.user.id, name, JSON.stringify(config));
    res.status(201).json({ id: r.lastInsertRowid, name, config });
  } catch (err) { next(err); }
});

router.delete('/datascape/saved/:id', (req, res, next) => {
  try {
    db.prepare(
      `DELETE FROM datascape_views WHERE id = ? AND user_id = ?`
    ).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
