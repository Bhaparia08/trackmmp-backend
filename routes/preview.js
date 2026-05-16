/**
 * /api/preview — Preview/test routes for new High Priority features
 * Not linked from main nav. Access via /preview/* routes only.
 */
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid10 } = require('../utils/clickId');

const router = express.Router();
router.use(requireAuth);

// OneLink helper: resolve the public link host. In dev the API is :3001, in
// prod it's the configured tracking domain.
function trackingDomain(req) {
  if (process.env.TRACKING_DOMAIN) return process.env.TRACKING_DOMAIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

// Generate a QR code PNG (base64 data URL) for a given URL.
async function qrPngDataUrl(url) {
  try {
    return await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 256, margin: 1 });
  } catch (err) {
    console.error('[qrcode]', err.message);
    return null;
  }
}

// Expand a OneLink row with computed public_url + optional QR PNG.
async function decorateOnelink(row, req, { withQr = false } = {}) {
  if (!row) return row;
  const public_url = trackingDomain(req) + '/go/' + row.slug;
  const result = { ...row, public_url };
  if (withQr) result.qr_code_data_url = await qrPngDataUrl(public_url);
  return result;
}

// ─────────────────────────────────────────────
// 1. COHORT RETENTION REPORT
// Returns a cohort grid: each row = install week,
// each column = Day 1 / Day 3 / Day 7 / Day 14 / Day 30
// ─────────────────────────────────────────────
router.get('/cohort', (req, res) => {
  const { campaign_id, publisher_id, from, to } = req.query;

  let where = 'pb.status = \'attributed\' AND pb.event_type = \'install\'';
  const params = [];

  if (req.user.role === 'advertiser') {
    where += ' AND c.advertiser_id = ?'; params.push(req.user.id);
  }
  if (campaign_id) { where += ' AND pb.campaign_id = ?'; params.push(campaign_id); }
  if (publisher_id) { where += ' AND cl.publisher_id = ?'; params.push(publisher_id); }
  if (from) { where += ' AND date(pb.created_at, \'unixepoch\') >= ?'; params.push(from); }
  if (to)   { where += ' AND date(pb.created_at, \'unixepoch\') <= ?'; params.push(to); }

  // Get all installs with their device ID
  const installs = db.prepare(`
    SELECT pb.advertising_id, pb.created_at AS install_ts,
           strftime('%Y-W%W', pb.created_at, 'unixepoch') AS cohort_week,
           date(pb.created_at, 'unixepoch') AS install_date,
           pb.campaign_id
    FROM postbacks pb
    JOIN campaigns c ON c.id = pb.campaign_id
    LEFT JOIN clicks cl ON cl.click_id = pb.click_id
    WHERE ${where}
    ORDER BY pb.created_at ASC
  `).all(...params);

  if (installs.length === 0) return res.json({ cohorts: [], days: [1, 3, 7, 14, 30] });

  const DAYS = [1, 3, 7, 14, 30];

  // Group by cohort_week
  const weekMap = {};
  for (const row of installs) {
    if (!weekMap[row.cohort_week]) weekMap[row.cohort_week] = { installs: [], week: row.cohort_week };
    weekMap[row.cohort_week].installs.push(row);
  }

  // For each cohort, count how many returned on day N
  const cohorts = [];
  for (const [week, data] of Object.entries(weekMap)) {
    const total = data.installs.length;
    const retention = {};

    for (const day of DAYS) {
      let retained = 0;
      for (const inst of data.installs) {
        if (!inst.advertising_id) continue;
        // Check if this device had any event on install_date + day (±1 day window)
        const windowStart = inst.install_ts + (day - 1) * 86400;
        const windowEnd   = inst.install_ts + (day + 1) * 86400;
        const returned = db.prepare(`
          SELECT 1 FROM postbacks
          WHERE advertising_id = ? AND campaign_id = ?
            AND created_at BETWEEN ? AND ?
            AND status = 'attributed'
          LIMIT 1
        `).get(inst.advertising_id, inst.campaign_id, windowStart, windowEnd);
        if (returned) retained++;
      }
      retention[`day${day}`] = total > 0 ? Math.round((retained / total) * 100) : 0;
    }

    cohorts.push({ week, total, ...retention });
  }

  cohorts.sort((a, b) => a.week.localeCompare(b.week));
  res.json({ cohorts, days: DAYS });
});

// ─────────────────────────────────────────────
// 2. CONVERSION FUNNEL
// Per campaign: clicks → installs → events (by event type)
// ─────────────────────────────────────────────
router.get('/funnel', (req, res) => {
  const { from, to, publisher_id } = req.query;

  let dateClause = '';
  const params = [];
  if (from) { dateClause += ' AND date(cl.created_at, \'unixepoch\') >= ?'; params.push(from); }
  if (to)   { dateClause += ' AND date(cl.created_at, \'unixepoch\') <= ?'; params.push(to); }

  let userClause = '';
  if (req.user.role === 'advertiser') {
    userClause = ' AND c.advertiser_id = ?'; params.push(req.user.id);
  }

  let pubClause = '';
  if (publisher_id) { pubClause = ' AND cl.publisher_id = ?'; params.push(parseInt(publisher_id)); }

  const campaigns = db.prepare(`
    SELECT c.id, c.name,
      COUNT(DISTINCT cl.id) AS clicks,
      COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
      COUNT(DISTINCT CASE WHEN cl.status = 'converted' THEN cl.id END) AS events,
      COALESCE(SUM(CASE WHEN pb.status='attributed' THEN pb.revenue END), 0) AS revenue
    FROM campaigns c
    LEFT JOIN clicks cl ON cl.campaign_id = c.id ${dateClause} ${pubClause}
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id AND pb.status = 'attributed'
    WHERE c.status != 'archived' ${userClause}
    GROUP BY c.id
    HAVING clicks > 0
    ORDER BY clicks DESC
    LIMIT 20
  `).all(...params);

  // Per-campaign top events breakdown
  const result = campaigns.map(camp => {
    const events = db.prepare(`
      SELECT pb.event_name, COUNT(*) AS count, SUM(pb.revenue) AS revenue
      FROM postbacks pb
      WHERE pb.campaign_id = ? AND pb.status = 'attributed' AND pb.event_name IS NOT NULL
      GROUP BY pb.event_name
      ORDER BY count DESC
      LIMIT 5
    `).all(camp.id);

    const cvr = camp.clicks > 0 ? ((camp.installs / camp.clicks) * 100).toFixed(1) : '0.0';
    const ecvr = camp.installs > 0 ? ((camp.events / camp.installs) * 100).toFixed(1) : '0.0';

    return { ...camp, cvr: parseFloat(cvr), ecvr: parseFloat(ecvr), top_events: events };
  });

  res.json(result);
});

// ─────────────────────────────────────────────
// 3. PUBLISHER PAYOUT REPORT
// Per publisher per period: clicks, installs, earned payout, pending
// ─────────────────────────────────────────────
router.get('/payouts', (req, res) => {
  const { from, to, publisher_id } = req.query;
  if (req.user.role !== 'admin' && req.user.role !== 'account_manager') {
    return res.status(403).json({ error: 'Admin only' });
  }

  let dateFilter = '';
  const params = [];
  if (from) { dateFilter += ' AND date(pb.created_at,\'unixepoch\') >= ?'; params.push(from); }
  if (to)   { dateFilter += ' AND date(pb.created_at,\'unixepoch\') <= ?'; params.push(to); }
  if (publisher_id) { dateFilter += ' AND cl.publisher_id = ?'; params.push(publisher_id); }

  const rows = db.prepare(`
    SELECT
      p.id AS publisher_id,
      p.name AS publisher_name,
      p.email,
      p.pub_token,
      p.status AS pub_status,
      COUNT(DISTINCT cl.id) AS total_clicks,
      COUNT(DISTINCT CASE WHEN pb.status='attributed' AND pb.event_type='install' THEN pb.id END) AS total_installs,
      COUNT(DISTINCT CASE WHEN pb.status='attributed' THEN pb.id END) AS total_conversions,
      COALESCE(SUM(CASE WHEN pb.status='attributed' THEN pb.payout END), 0) AS total_earned,
      COALESCE(SUM(CASE WHEN pb.status='attributed' AND pb.event_type='install' THEN pb.payout END), 0) AS install_payout,
      COALESCE(SUM(CASE WHEN pb.status='attributed' AND pb.event_type != 'install' THEN pb.payout END), 0) AS event_payout
    FROM publishers p
    LEFT JOIN clicks cl ON cl.publisher_id = p.id
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id ${dateFilter}
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY total_earned DESC
  `).all(...params, req.user.id);

  // Top campaign per publisher
  const result = rows.map(pub => {
    const topCampaigns = db.prepare(`
      SELECT c.name, COUNT(DISTINCT cl2.id) AS clicks,
        COALESCE(SUM(CASE WHEN pb2.status='attributed' THEN pb2.payout END),0) AS payout
      FROM clicks cl2
      JOIN campaigns c ON c.id = cl2.campaign_id
      LEFT JOIN postbacks pb2 ON pb2.click_id = cl2.click_id
      WHERE cl2.publisher_id = ?
      GROUP BY c.id ORDER BY payout DESC LIMIT 3
    `).all(pub.publisher_id);
    return { ...pub, top_campaigns: topCampaigns };
  });

  res.json(result);
});

// ─────────────────────────────────────────────
// 4. CAMPAIGN GOALS OVERVIEW
// All goals across all campaigns with performance stats
// ─────────────────────────────────────────────
router.get('/goals', (req, res) => {
  let userClause = 'cg.user_id = ?';
  const params = [req.user.id];

  const goals = db.prepare(`
    SELECT cg.*,
      c.name AS campaign_name,
      c.campaign_token,
      COUNT(DISTINCT pb.id) AS total_hits,
      COALESCE(SUM(pb.payout), 0) AS total_payout,
      COALESCE(SUM(pb.revenue), 0) AS total_revenue
    FROM campaign_goals cg
    JOIN campaigns c ON c.id = cg.campaign_id
    LEFT JOIN postbacks pb ON pb.goal_id = cg.id AND pb.status = 'attributed'
    WHERE ${userClause}
    GROUP BY cg.id
    ORDER BY c.name, cg.is_default DESC, cg.name
  `).all(...params);

  res.json(goals);
});

// POST goal
router.post('/goals', (req, res, next) => {
  try {
    const { campaign_id, name, event_name, payout = 0, revenue = 0, payout_type = 'cpi', postback_url = '', is_default = 0 } = req.body;
    if (!campaign_id || !name) return res.status(400).json({ error: 'campaign_id and name required' });
    const result = db.prepare(`
      INSERT INTO campaign_goals (campaign_id, user_id, name, event_name, payout, revenue, payout_type, postback_url, is_default, status)
      VALUES (?,?,?,?,?,?,?,?,?,\'active\')
    `).run(campaign_id, req.user.id, name, event_name||null, payout, revenue, payout_type, postback_url, is_default ? 1 : 0);
    res.status(201).json(db.prepare('SELECT * FROM campaign_goals WHERE id=?').get(result.lastInsertRowid));
  } catch(err) { next(err); }
});

// PUT goal
router.put('/goals/:id', (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM campaign_goals WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Goal not found' });
    const { name, event_name, payout, revenue, payout_type, postback_url, is_default, status } = req.body;
    db.prepare(`UPDATE campaign_goals SET
      name=COALESCE(?,name), event_name=COALESCE(?,event_name),
      payout=COALESCE(?,payout), revenue=COALESCE(?,revenue),
      payout_type=COALESCE(?,payout_type), postback_url=COALESCE(?,postback_url),
      is_default=COALESCE(?,is_default), status=COALESCE(?,status)
      WHERE id=? AND user_id=?`)
      .run(name||null, event_name||null, payout??null, revenue??null,
           payout_type||null, postback_url||null, is_default??null, status||null,
           req.params.id, req.user.id);
    res.json(db.prepare('SELECT * FROM campaign_goals WHERE id=?').get(req.params.id));
  } catch(err) { next(err); }
});

// DELETE goal
router.delete('/goals/:id', (req, res, next) => {
  try {
    db.prepare('DELETE FROM campaign_goals WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch(err) { next(err); }
});

// ─────────────────────────────────────────────
// 5. BULK ACTIONS
// Bulk update status for campaigns or publishers
// ─────────────────────────────────────────────
router.post('/bulk', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { type, ids, status } = req.body;
    if (!type || !Array.isArray(ids) || ids.length === 0 || !status) {
      return res.status(400).json({ error: 'type, ids[], status required' });
    }
    const allowed = {
      campaigns: ['active', 'paused', 'archived'],
      publishers: ['active', 'suspended'],
    };
    if (!allowed[type]) return res.status(400).json({ error: 'type must be campaigns or publishers' });
    if (!allowed[type].includes(status)) return res.status(400).json({ error: `Invalid status for ${type}` });

    const placeholders = ids.map(() => '?').join(',');
    const table = type === 'campaigns' ? 'campaigns' : 'publishers';
    const extraSet = type === 'campaigns' ? ', updated_at=unixepoch()' : '';
    const result = db.prepare(
      `UPDATE ${table} SET status=? ${extraSet} WHERE id IN (${placeholders})`
    ).run(status, ...ids.map(Number));

    res.json({ updated: result.changes, ids, status });
  } catch(err) { next(err); }
});

// GET campaigns list for bulk (with checkboxes support)
router.get('/bulk/campaigns', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT c.id, c.name, c.status, c.visibility, c.payout, c.payout_type,
      COALESCE(u.name, c.advertiser_name) AS advertiser,
      COUNT(DISTINCT cl.id) AS total_clicks,
      COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS total_installs
    FROM campaigns c
    LEFT JOIN users u ON u.id = c.advertiser_id
    LEFT JOIN clicks cl ON cl.campaign_id = c.id
    WHERE c.status != 'archived'
    GROUP BY c.id ORDER BY c.created_at DESC
  `).all();
  res.json(rows);
});

router.get('/bulk/publishers', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT p.id, p.name, p.email, p.pub_token, p.status,
      COUNT(DISTINCT cl.id) AS total_clicks,
      COALESCE(SUM(CASE WHEN pb.status='attributed' THEN pb.payout END),0) AS total_earned
    FROM publishers p
    LEFT JOIN clicks cl ON cl.publisher_id = p.id
    LEFT JOIN postbacks pb ON pb.click_id = cl.click_id
    WHERE p.user_id = ?
    GROUP BY p.id ORDER BY p.created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// ─────────────────────────────────────────────
// 6. LTV (Lifetime Value) Report
// For each install cohort (by install_date), reports cumulative ARPU at
// Day 0 / 1 / 3 / 7 / 14 / 30 / 60 / 90 post-install. An install is identified
// by (advertising_id, MIN(install postback created_at)). Revenue at day N is
// the sum of all attributed postbacks for that advertising_id created within
// N days of install (inclusive), divided by the cohort size.
// ─────────────────────────────────────────────
router.get('/ltv', (req, res) => {
  const { campaign_id, publisher_id, from, to } = req.query;
  const DAYS = [0, 1, 3, 7, 14, 30, 60, 90];

  const filters = ["pb.status = 'attributed'", "pb.advertising_id IS NOT NULL"];
  const params = [];

  if (req.user.role === 'advertiser') {
    filters.push('c.advertiser_id = ?'); params.push(req.user.id);
  }
  if (campaign_id) { filters.push('pb.campaign_id = ?'); params.push(campaign_id); }
  if (publisher_id) { filters.push('cl.publisher_id = ?'); params.push(publisher_id); }

  const where = filters.join(' AND ');

  // First-install per device (advertising_id), with cohort_date and install timestamp.
  // Apply date filter on the INSTALL date (cohort definition), not on the revenue event.
  const installFilters = [...filters, "pb.event_type = 'install'"];
  const installParams = [...params];
  if (from) { installFilters.push("date(pb.created_at, 'unixepoch') >= ?"); installParams.push(from); }
  if (to)   { installFilters.push("date(pb.created_at, 'unixepoch') <= ?"); installParams.push(to); }
  const installWhere = installFilters.join(' AND ');

  const installs = db.prepare(`
    SELECT pb.advertising_id,
           MIN(pb.created_at) AS install_ts,
           date(MIN(pb.created_at), 'unixepoch') AS install_date,
           pb.campaign_id
    FROM postbacks pb
    JOIN campaigns c ON c.id = pb.campaign_id
    LEFT JOIN clicks cl ON cl.click_id = pb.click_id
    WHERE ${installWhere}
    GROUP BY pb.advertising_id
  `).all(...installParams);

  if (installs.length === 0) {
    return res.json({ cohorts: [], days: DAYS, overall: null });
  }

  // Build advertising_id → install timestamp map; collect ids to scope the revenue query.
  const idMap = new Map();
  const idList = [];
  for (const row of installs) {
    if (!idMap.has(row.advertising_id)) {
      idMap.set(row.advertising_id, { install_ts: row.install_ts, install_date: row.install_date });
      idList.push(row.advertising_id);
    }
  }

  // Fetch all revenue events for those devices in one go (SQLite param limit ~999 per chunk).
  const revenueByDevice = new Map(); // advertising_id → [{ ts, revenue }]
  const chunkSize = 800;
  for (let i = 0; i < idList.length; i += chunkSize) {
    const chunk = idList.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const revFilters = ["pb.status = 'attributed'", `pb.advertising_id IN (${placeholders})`];
    const revParams = [...chunk];
    if (campaign_id) { revFilters.push('pb.campaign_id = ?'); revParams.push(campaign_id); }
    if (publisher_id) { revFilters.push('cl.publisher_id = ?'); revParams.push(publisher_id); }
    if (req.user.role === 'advertiser') { revFilters.push('c.advertiser_id = ?'); revParams.push(req.user.id); }

    const rows = db.prepare(`
      SELECT pb.advertising_id, pb.created_at AS ts, COALESCE(pb.revenue,0) AS revenue
      FROM postbacks pb
      JOIN campaigns c ON c.id = pb.campaign_id
      LEFT JOIN clicks cl ON cl.click_id = pb.click_id
      WHERE ${revFilters.join(' AND ')}
    `).all(...revParams);
    for (const r of rows) {
      if (!revenueByDevice.has(r.advertising_id)) revenueByDevice.set(r.advertising_id, []);
      revenueByDevice.get(r.advertising_id).push({ ts: r.ts, revenue: r.revenue });
    }
  }

  // Aggregate cumulative revenue per cohort at each milestone day.
  const cohortMap = new Map(); // install_date → { size, revenueByDay: {d: total} }
  for (const adId of idList) {
    const meta = idMap.get(adId);
    const events = revenueByDevice.get(adId) || [];
    let cohort = cohortMap.get(meta.install_date);
    if (!cohort) {
      cohort = { size: 0, revenue: Object.fromEntries(DAYS.map(d => [d, 0])) };
      cohortMap.set(meta.install_date, cohort);
    }
    cohort.size += 1;
    for (const ev of events) {
      const daysSince = Math.floor((ev.ts - meta.install_ts) / 86400);
      if (daysSince < 0) continue; // refunds/anomalies — ignore pre-install
      for (const d of DAYS) {
        if (daysSince <= d) cohort.revenue[d] += ev.revenue;
      }
    }
  }

  const cohorts = Array.from(cohortMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0])) // newest cohort first
    .slice(0, 60)
    .map(([install_date, c]) => {
      const arpu = Object.fromEntries(DAYS.map(d => [
        `arpu_d${d}`,
        c.size > 0 ? +(c.revenue[d] / c.size).toFixed(4) : 0,
      ]));
      const totalRev = Object.fromEntries(DAYS.map(d => [`rev_d${d}`, +c.revenue[d].toFixed(2)]));
      return { install_date, cohort_size: c.size, ...arpu, ...totalRev };
    });

  // Overall (all cohorts merged) — useful for the headline LTV curve.
  const totalSize = cohorts.reduce((s, c) => s + c.cohort_size, 0);
  const overall = totalSize > 0 ? {
    cohort_size: totalSize,
    days: DAYS.map(d => {
      const totalRev = cohorts.reduce((s, c) => s + (c[`rev_d${d}`] || 0), 0);
      return { day: d, arpu: +(totalRev / totalSize).toFixed(4), revenue: +totalRev.toFixed(2) };
    }),
  } : null;

  res.json({ cohorts, days: DAYS, overall });
});

// ─────────────────────────────────────────────
// 7. ONELINK WIZARD — CRUD
// Standalone unified-link generator. Public resolver lives in routes/go.js.
// ─────────────────────────────────────────────
router.get('/onelinks', async (req, res, next) => {
  try {
    const rows = db.prepare(
      `SELECT id, name, slug, ios_store_url, android_store_url, web_fallback_url,
              ios_deep_link, android_deep_link, total_clicks, status, expires_at,
              created_at, updated_at
       FROM onelinks WHERE user_id = ? ORDER BY created_at DESC`
    ).all(req.user.id);
    const withQr = req.query.with_qr === '1';
    const decorated = await Promise.all(rows.map(r => decorateOnelink(r, req, { withQr })));
    res.json(decorated);
  } catch (err) { next(err); }
});

router.post('/onelinks', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const {
      name, ios_store_url = '', android_store_url = '', web_fallback_url = '',
      ios_deep_link = '', android_deep_link = '',
      expiry_days,
    } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!ios_store_url && !android_store_url && !web_fallback_url) {
      return res.status(400).json({ error: 'at least one destination (iOS/Android/web) is required' });
    }
    // Expiry: 1–730 days (matching AppsFlyer OneLink API v2.0). null = never.
    let expires_at = null;
    if (expiry_days !== undefined && expiry_days !== null && expiry_days !== '') {
      const days = Math.max(1, Math.min(730, parseInt(expiry_days, 10) || 0));
      if (!days) return res.status(400).json({ error: 'expiry_days must be 1–730' });
      expires_at = Math.floor(Date.now() / 1000) + days * 86400;
    }
    const slug = nanoid10();
    const r = db.prepare(
      `INSERT INTO onelinks (user_id, name, slug, ios_store_url, android_store_url, web_fallback_url, ios_deep_link, android_deep_link, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, name, slug, ios_store_url, android_store_url, web_fallback_url, ios_deep_link, android_deep_link, expires_at);
    const row = db.prepare('SELECT * FROM onelinks WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json(await decorateOnelink(row, req, { withQr: true }));
  } catch (err) { next(err); }
});

router.put('/onelinks/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const ol = db.prepare('SELECT * FROM onelinks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!ol) return res.status(404).json({ error: 'Not found' });
    const f = req.body || {};
    db.prepare(
      `UPDATE onelinks SET
         name = COALESCE(?, name),
         ios_store_url = COALESCE(?, ios_store_url),
         android_store_url = COALESCE(?, android_store_url),
         web_fallback_url = COALESCE(?, web_fallback_url),
         ios_deep_link = COALESCE(?, ios_deep_link),
         android_deep_link = COALESCE(?, android_deep_link),
         status = COALESCE(?, status),
         updated_at = unixepoch()
       WHERE id = ?`
    ).run(
      f.name ?? null, f.ios_store_url ?? null, f.android_store_url ?? null,
      f.web_fallback_url ?? null, f.ios_deep_link ?? null, f.android_deep_link ?? null,
      f.status ?? null, ol.id,
    );
    res.json(db.prepare('SELECT * FROM onelinks WHERE id = ?').get(ol.id));
  } catch (err) { next(err); }
});

router.delete('/onelinks/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const ol = db.prepare('SELECT * FROM onelinks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!ol) return res.status(404).json({ error: 'Not found' });
    db.prepare("UPDATE onelinks SET status = 'archived', updated_at = unixepoch() WHERE id = ?").run(ol.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
