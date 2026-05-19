const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── Helper: calculate owed amount from postbacks for a publisher in a date range ──
function calculateOwed(publisherId, periodFrom, periodTo) {
  // Sum attributed postback payouts for clicks belonging to this publisher in the date range
  const row = db.prepare(`
    SELECT COALESCE(SUM(pb.payout), 0) AS total
    FROM postbacks pb
    JOIN clicks cl ON cl.click_id = pb.click_id
    WHERE cl.publisher_id = ?
      AND pb.status = 'attributed'
      AND date(pb.created_at, 'unixepoch') >= ?
      AND date(pb.created_at, 'unixepoch') <= ?
  `).get(publisherId, periodFrom, periodTo);

  // Also check daily_stats as a fallback/supplement
  const dsRow = db.prepare(`
    SELECT COALESCE(SUM(revenue), 0) AS total
    FROM daily_stats
    WHERE publisher_id = ?
      AND date >= ?
      AND date <= ?
  `).get(publisherId, periodFrom, periodTo);

  // Use the larger of the two (postbacks are ground truth, daily_stats is aggregated)
  const postbackTotal = row?.total || 0;
  const dailyStatsTotal = dsRow?.total || 0;
  return Math.max(postbackTotal, dailyStatsTotal);
}

// ── GET /calculate — calculate owed amount for a publisher in a date range ──
router.get('/calculate', requireRole('admin', 'account_manager'), (req, res) => {
  const { publisher_id, period_from, period_to } = req.query;
  if (!publisher_id || !period_from || !period_to) {
    return res.status(400).json({ error: 'publisher_id, period_from, and period_to are required' });
  }
  const amount = calculateOwed(publisher_id, period_from, period_to);
  res.json({ publisher_id: Number(publisher_id), period_from, period_to, amount: +amount.toFixed(2) });
});

// ── GET /summary — payout summary stats ──
router.get('/summary', requireRole('admin', 'account_manager'), (req, res) => {
  const totalPending = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM publisher_payouts WHERE status = 'pending'
  `).get().total;

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const paidThisMonth = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM publisher_payouts
    WHERE status = 'paid' AND date(paid_at, 'unixepoch') >= ?
  `).get(monthStart).total;

  const paidAllTime = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM publisher_payouts WHERE status = 'paid'
  `).get().total;

  const perPublisher = db.prepare(`
    SELECT
      pp.publisher_id,
      p.name AS publisher_name,
      COALESCE(SUM(CASE WHEN pp.status = 'pending' THEN pp.amount END), 0) AS pending,
      COALESCE(SUM(CASE WHEN pp.status = 'paid'    THEN pp.amount END), 0) AS paid,
      COUNT(*) AS payout_count
    FROM publisher_payouts pp
    JOIN publishers p ON p.id = pp.publisher_id
    GROUP BY pp.publisher_id
    ORDER BY pending DESC
  `).all();

  res.json({
    total_pending: +totalPending.toFixed(2),
    paid_this_month: +paidThisMonth.toFixed(2),
    paid_all_time: +paidAllTime.toFixed(2),
    per_publisher: perPublisher,
  });
});

// ── GET / — list payouts (admin: all, filterable) ──
router.get('/', requireRole('admin', 'account_manager'), (req, res) => {
  const { publisher_id, status, from, to } = req.query;
  const conditions = [];
  const values = [];

  if (publisher_id) { conditions.push('pp.publisher_id = ?'); values.push(publisher_id); }
  if (status)       { conditions.push('pp.status = ?');       values.push(status); }
  if (from)         { conditions.push('pp.period_from >= ?'); values.push(from); }
  if (to)           { conditions.push('pp.period_to <= ?');   values.push(to); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT pp.*, p.name AS publisher_name, u.name AS created_by_name
    FROM publisher_payouts pp
    JOIN publishers p ON p.id = pp.publisher_id
    LEFT JOIN users u ON u.id = pp.user_id
    ${where}
    ORDER BY pp.created_at DESC
    LIMIT 500
  `).all(...values);

  res.json(rows);
});

// ── POST / — create payout record (admin only) ──
router.post('/', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const { publisher_id, period_from, period_to, amount, currency, payment_method, notes } = req.body;

    if (!publisher_id || !period_from || !period_to) {
      return res.status(400).json({ error: 'publisher_id, period_from, and period_to are required' });
    }

    // Verify publisher exists
    const pub = db.prepare('SELECT id FROM publishers WHERE id = ?').get(publisher_id);
    if (!pub) return res.status(404).json({ error: 'Publisher not found' });

    // Auto-calculate amount if not provided
    const finalAmount = (amount !== undefined && amount !== null && amount !== '')
      ? Number(amount)
      : calculateOwed(publisher_id, period_from, period_to);

    const result = db.prepare(`
      INSERT INTO publisher_payouts (publisher_id, user_id, period_from, period_to, amount, currency, payment_method, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publisher_id,
      req.user.id,
      period_from,
      period_to,
      +finalAmount.toFixed(2),
      currency || 'USD',
      payment_method || '',
      notes || ''
    );

    const created = db.prepare('SELECT * FROM publisher_payouts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// ── PUT /:id — update payout (change status, add payment_ref, notes) ──
router.put('/:id', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const payout = db.prepare('SELECT * FROM publisher_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    const { status, payment_ref, payment_method, notes } = req.body;

    const newStatus        = status         !== undefined ? status         : payout.status;
    const newPaymentRef    = payment_ref    !== undefined ? payment_ref    : payout.payment_ref;
    const newPaymentMethod = payment_method !== undefined ? payment_method : payout.payment_method;
    const newNotes         = notes          !== undefined ? notes          : payout.notes;

    // Set paid_at when marking as paid
    const paidAt = (newStatus === 'paid' && payout.status !== 'paid')
      ? Math.floor(Date.now() / 1000)
      : payout.paid_at;

    db.prepare(`
      UPDATE publisher_payouts
      SET status = ?, payment_ref = ?, payment_method = ?, notes = ?, paid_at = ?
      WHERE id = ?
    `).run(newStatus, newPaymentRef, newPaymentMethod, newNotes, paidAt, payout.id);

    const updated = db.prepare('SELECT * FROM publisher_payouts WHERE id = ?').get(payout.id);
    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /:id — delete payout (only if pending) ──
router.delete('/:id', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const payout = db.prepare('SELECT * FROM publisher_payouts WHERE id = ?').get(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout not found' });

    if (payout.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending payouts can be deleted' });
    }

    db.prepare('DELETE FROM publisher_payouts WHERE id = ?').run(payout.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
