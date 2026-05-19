const express = require('express');
const db = require('../db/init');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Auth: admin, account_manager, publisher
router.use(requireRole('admin', 'account_manager', 'publisher'));

const VALID_REPORT_TYPES = ['summary', 'by-day', 'by-campaign', 'by-publisher', 'by-country'];
const VALID_FREQUENCIES = ['daily', 'weekly', 'monthly'];
const VALID_FORMATS = ['csv'];

// ── Helpers ──────────────────────────────────────────────────────────────────

// Publishers can only see/modify their own schedules
function ownershipClause(user) {
  return { clause: 'user_id = ?', params: [user.id] };
}

// Calculate next_run_at from frequency (next midnight UTC + offset)
function calcNextRun(frequency) {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  if (frequency === 'daily') return Math.floor(tomorrow.getTime() / 1000);
  if (frequency === 'weekly') {
    // Next Monday at midnight UTC
    const day = tomorrow.getUTCDay();
    const daysUntilMonday = day === 0 ? 1 : (8 - day);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + daysUntilMonday);
    return Math.floor(tomorrow.getTime() / 1000);
  }
  // monthly: first of next month
  const firstOfNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.floor(firstOfNext.getTime() / 1000);
}

// ── Report data generation (reuses report query logic) ──────────────────────

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

function userScope(user, alias = '') {
  const col = alias ? `${alias}.user_id` : 'user_id';
  if (user.role === 'admin') return { clause: '1=1', params: [] };
  if (user.role === 'account_manager') {
    const advIds = getAMAdvertiserIds(user.id);
    if (advIds.length === 0) return { clause: '1=0', params: [] };
    const ph = advIds.map(() => '?').join(',');
    return { clause: `${col} IN (${ph})`, params: advIds };
  }
  // publisher: scope to publisher_id linked to their user
  if (user.role === 'publisher') {
    return { clause: `publisher_id IN (SELECT id FROM publishers WHERE publisher_user_id = ? OR user_id = ?)`, params: [user.id, user.id] };
  }
  return { clause: `${col} = ?`, params: [user.id] };
}

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

// Resolve date range from filters (supports absolute from/to or relative offsets)
function resolveDates(filters) {
  let from = filters.from || null;
  let to = filters.to || null;

  // If no explicit dates, use offsets relative to today (e.g. from_days_ago: 7)
  if (!from && filters.from_days_ago) {
    const d = new Date();
    d.setDate(d.getDate() - Number(filters.from_days_ago));
    from = d.toISOString().slice(0, 10);
  }
  if (!to && filters.to_days_ago !== undefined) {
    const d = new Date();
    d.setDate(d.getDate() - Number(filters.to_days_ago));
    to = d.toISOString().slice(0, 10);
  } else if (!to) {
    to = new Date().toISOString().slice(0, 10); // default to today
  }

  return { from, to };
}

function generateReportData(reportType, user, filters) {
  const { from, to } = resolveDates(filters);
  const campaign_id = filters.campaign_id || null;
  const publisher_id = filters.publisher_id || null;
  const advertiser_id = filters.advertiser_id || null;

  switch (reportType) {
    case 'summary': {
      const { conditions, values } = dateFilter(from, to);
      const scope = userScope(user);
      conditions.push(scope.clause); values.push(...scope.params);
      if (campaign_id) { conditions.push('campaign_id = ?'); values.push(campaign_id); }
      if (publisher_id) { conditions.push('publisher_id = ?'); values.push(publisher_id); }
      const af = advertiser_id && (user.role === 'admin' || user.role === 'account_manager') ? advertiserFilter(advertiser_id) : null;
      if (af) { conditions.push(af.clause); values.push(...af.params); }

      const where = conditions.join(' AND ');
      const row = db.prepare(`SELECT
        SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(installs) AS installs,
        SUM(leads) AS leads, SUM(conversions) AS conversions, SUM(re_engagements) AS re_engagements,
        ROUND(SUM(revenue),2) AS revenue
        FROM daily_stats WHERE ${where}`).get(...values);

      const impressions = row.impressions || 0;
      const clicks = row.clicks || 0;
      const installs = row.installs || 0;
      const cr = clicks > 0 ? ((installs / clicks) * 100).toFixed(2) : '0.00';
      const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : '0.00';
      return [{
        impressions, clicks, installs,
        leads: row.leads || 0,
        conversions: row.conversions || 0,
        re_engagements: row.re_engagements || 0,
        revenue: row.revenue || 0,
        conversion_rate: cr + '%',
        ctr: ctr + '%'
      }];
    }

    case 'by-day': {
      const { conditions, values } = dateFilter(from, to);
      const scope = userScope(user);
      conditions.push(scope.clause); values.push(...scope.params);
      if (campaign_id) { conditions.push('campaign_id = ?'); values.push(campaign_id); }
      if (publisher_id) { conditions.push('publisher_id = ?'); values.push(publisher_id); }
      const af = advertiser_id && (user.role === 'admin' || user.role === 'account_manager') ? advertiserFilter(advertiser_id) : null;
      if (af) { conditions.push(af.clause); values.push(...af.params); }

      return db.prepare(`
        SELECT ds.date,
          COALESCE(adv.name, adv.email, '—') AS advertiser,
          SUM(ds.impressions) AS impressions, SUM(ds.clicks) AS clicks,
          SUM(ds.installs) AS installs, SUM(ds.leads) AS leads,
          SUM(ds.re_engagements) AS re_engagements,
          ROUND(SUM(ds.revenue),2) AS revenue
        FROM daily_stats ds
        LEFT JOIN campaigns c ON c.id = ds.campaign_id
        LEFT JOIN users adv ON adv.id = c.advertiser_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY ds.date, c.advertiser_id ORDER BY ds.date ASC
      `).all(...values);
    }

    case 'by-campaign': {
      const { conditions, values } = dateFilter(from, to);
      const scope = userScope(user, 'ds');
      conditions.push(scope.clause); values.push(...scope.params);
      const af = advertiser_id && user.role === 'admin' ? advertiserFilter(advertiser_id, 'ds') : null;
      if (af) { conditions.push(af.clause); values.push(...af.params); }

      return db.prepare(`
        SELECT c.name AS campaign, c.id AS campaign_id,
          COALESCE(adv.name, adv.email, '—') AS advertiser,
          SUM(ds.clicks) AS clicks, SUM(ds.installs) AS installs,
          SUM(ds.leads) AS leads, SUM(ds.re_engagements) AS re_engagements,
          ROUND(SUM(ds.revenue),2) AS revenue
        FROM daily_stats ds
        LEFT JOIN campaigns c ON c.id = ds.campaign_id
        LEFT JOIN users adv ON adv.id = c.advertiser_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY ds.campaign_id ORDER BY revenue DESC
      `).all(...values);
    }

    case 'by-publisher': {
      const { conditions, values } = dateFilter(from, to);
      const scope = userScope(user, 'ds');
      conditions.push(scope.clause); values.push(...scope.params);
      const af = advertiser_id && user.role === 'admin' ? advertiserFilter(advertiser_id, 'ds') : null;
      if (af) { conditions.push(af.clause); values.push(...af.params); }

      return db.prepare(`SELECT p.name AS publisher, p.id AS publisher_id,
        SUM(ds.clicks) AS clicks, SUM(ds.installs) AS installs,
        SUM(ds.leads) AS leads, ROUND(SUM(ds.revenue),2) AS revenue
        FROM daily_stats ds
        LEFT JOIN publishers p ON p.id = ds.publisher_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY ds.publisher_id ORDER BY revenue DESC`).all(...values);
    }

    case 'by-country': {
      const scope = userScope(user, 'cl');
      const conditions = [scope.clause];
      const values = [...scope.params];
      if (from) { conditions.push("date(created_at,'unixepoch') >= ?"); values.push(from); }
      if (to) { conditions.push("date(created_at,'unixepoch') <= ?"); values.push(to); }
      const af = advertiser_id && user.role === 'admin' ? advertiserFilter(advertiser_id, 'cl') : null;
      if (af) { conditions.push(af.clause); values.push(...af.params); }

      return db.prepare(`SELECT country, COUNT(*) AS clicks,
        SUM(CASE WHEN status='installed' THEN 1 ELSE 0 END) AS installs
        FROM clicks cl WHERE ${conditions.join(' AND ')}
        GROUP BY country ORDER BY clicks DESC LIMIT 50`).all(...values);
    }

    default:
      return [];
  }
}

// Convert array of objects to CSV string
function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const vals = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      const str = String(v);
      // Escape fields containing commas, quotes, or newlines
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    });
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

// ── CRUD Routes ──────────────────────────────────────────────────────────────

// GET /api/scheduled-reports — list user's scheduled reports
router.get('/', (req, res) => {
  const { clause, params } = ownershipClause(req.user);
  const rows = db.prepare(`SELECT * FROM scheduled_reports WHERE ${clause} ORDER BY created_at DESC`).all(...params);
  res.json(rows);
});

// POST /api/scheduled-reports — create a schedule
router.post('/', (req, res) => {
  const { name, report_type, frequency, filters, recipients, format } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (report_type && !VALID_REPORT_TYPES.includes(report_type)) {
    return res.status(400).json({ error: `Invalid report_type. Valid: ${VALID_REPORT_TYPES.join(', ')}` });
  }
  if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: `Invalid frequency. Valid: ${VALID_FREQUENCIES.join(', ')}` });
  }
  if (format && !VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Invalid format. Valid: ${VALID_FORMATS.join(', ')}` });
  }

  // Validate filters is valid JSON if provided as string
  let filtersStr = '{}';
  if (filters) {
    if (typeof filters === 'string') {
      try { JSON.parse(filters); filtersStr = filters; } catch { return res.status(400).json({ error: 'filters must be valid JSON' }); }
    } else {
      filtersStr = JSON.stringify(filters);
    }
  }

  const freq = frequency || 'daily';
  const nextRun = calcNextRun(freq);

  const result = db.prepare(`
    INSERT INTO scheduled_reports (user_id, name, report_type, frequency, filters, recipients, format, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    name.trim(),
    report_type || 'summary',
    freq,
    filtersStr,
    (recipients || '').trim(),
    format || 'csv',
    nextRun
  );

  const row = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// PUT /api/scheduled-reports/:id — update a schedule
router.put('/:id', (req, res) => {
  const schedule = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (schedule.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { name, report_type, frequency, filters, recipients, format, enabled } = req.body;

  if (report_type && !VALID_REPORT_TYPES.includes(report_type)) {
    return res.status(400).json({ error: `Invalid report_type. Valid: ${VALID_REPORT_TYPES.join(', ')}` });
  }
  if (frequency && !VALID_FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ error: `Invalid frequency. Valid: ${VALID_FREQUENCIES.join(', ')}` });
  }
  if (format && !VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: `Invalid format. Valid: ${VALID_FORMATS.join(', ')}` });
  }

  let filtersStr = schedule.filters;
  if (filters !== undefined) {
    if (typeof filters === 'string') {
      try { JSON.parse(filters); filtersStr = filters; } catch { return res.status(400).json({ error: 'filters must be valid JSON' }); }
    } else {
      filtersStr = JSON.stringify(filters);
    }
  }

  const newFreq = frequency || schedule.frequency;
  const nextRun = (frequency && frequency !== schedule.frequency) ? calcNextRun(newFreq) : schedule.next_run_at;

  db.prepare(`
    UPDATE scheduled_reports SET
      name = ?, report_type = ?, frequency = ?, filters = ?, recipients = ?,
      format = ?, enabled = ?, next_run_at = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(
    (name || schedule.name).trim(),
    report_type || schedule.report_type,
    newFreq,
    filtersStr,
    recipients !== undefined ? recipients.trim() : schedule.recipients,
    format || schedule.format,
    enabled !== undefined ? (enabled ? 1 : 0) : schedule.enabled,
    nextRun,
    schedule.id
  );

  const updated = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(schedule.id);
  res.json(updated);
});

// DELETE /api/scheduled-reports/:id — delete a schedule
router.delete('/:id', (req, res) => {
  const schedule = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (schedule.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.prepare('DELETE FROM scheduled_reports WHERE id = ?').run(schedule.id);
  res.json({ success: true });
});

// POST /api/scheduled-reports/:id/run-now — manually trigger a report
router.post('/:id/run-now', (req, res) => {
  const schedule = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (schedule.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  let filters = {};
  try { filters = JSON.parse(schedule.filters); } catch { /* use defaults */ }

  const rows = generateReportData(schedule.report_type, req.user, filters);
  const csv = toCsv(rows);

  // Update last_sent_at
  db.prepare('UPDATE scheduled_reports SET last_sent_at = unixepoch() WHERE id = ?').run(schedule.id);

  res.json({
    csv,
    rows: rows.length,
    generated_at: Math.floor(Date.now() / 1000)
  });
});

module.exports = router;
