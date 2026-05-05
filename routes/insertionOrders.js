/**
 * Insertion Orders  —  /api/insertion-orders
 *
 * Manages signed contracts between Appreach and advertisers.
 * Legal entity info captured here auto-fills invoice creation.
 */
const express = require('express');
const db      = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

// ── helpers ───────────────────────────────────────────────────────────────────

function nextIONumber() {
  const year = new Date().getFullYear();
  const pattern = `AM/IO/${year}/%`;
  const last = db.prepare(
    "SELECT io_number FROM insertion_orders WHERE io_number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(pattern);
  const seq = last
    ? (parseInt(last.io_number.split('/').pop()) || 0) + 1
    : 1;
  return `AM/IO/${year}/${String(seq).padStart(3, '0')}`;
}

function getIO(id) {
  return db.prepare(`
    SELECT io.*,
      adv.name  AS advertiser_name,
      adv.email AS advertiser_email,
      adv.legal_name    AS adv_legal_name,
      adv.legal_address AS adv_legal_address,
      adv.legal_country AS adv_legal_country,
      adv.tax_id        AS adv_tax_id,
      adv.company_reg_no AS adv_company_reg_no,
      u.name AS created_by_name
    FROM insertion_orders io
    LEFT JOIN users adv ON adv.id = io.advertiser_id
    LEFT JOIN users u   ON u.id   = io.user_id
    WHERE io.id = ?
  `).get(id);
}

// ── GET /api/insertion-orders ─────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { advertiser_id, status } = req.query;
  const conditions = [];
  const values     = [];

  if (req.user.role !== 'admin') {
    // Account managers see IOs for their advertisers only; others see nothing
    if (req.user.role !== 'account_manager') return res.json([]);
  }

  if (advertiser_id) { conditions.push('io.advertiser_id = ?'); values.push(advertiser_id); }
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      conditions.push('io.status = ?'); values.push(statuses[0]);
    } else if (statuses.length > 1) {
      conditions.push(`io.status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses);
    }
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT io.*,
      adv.name  AS advertiser_name,
      adv.email AS advertiser_email,
      u.name AS created_by_name
    FROM insertion_orders io
    LEFT JOIN users adv ON adv.id = io.advertiser_id
    LEFT JOIN users u   ON u.id   = io.user_id
    ${where}
    ORDER BY io.created_at DESC
  `).all(...values);
  res.json(rows);
});

// ── POST /api/insertion-orders ────────────────────────────────────────────────
router.post('/', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const {
      advertiser_id, campaign_name = '', io_value = 0, currency = 'USD',
      start_date, end_date, payment_terms = 'NET30', billing_cycle = 'monthly',
      legal_name = '', legal_address = '', legal_country = '', tax_id = '',
      company_reg_no = '', contact_name = '', contact_email = '', contact_phone = '',
      notes = '',
    } = req.body;

    if (!advertiser_id) return res.status(400).json({ error: 'advertiser_id is required' });

    const io_number = nextIONumber();

    // If legal fields are blank, auto-fill from advertiser's existing profile
    const adv = db.prepare('SELECT * FROM users WHERE id = ?').get(advertiser_id);
    const result = db.prepare(`
      INSERT INTO insertion_orders
        (user_id, advertiser_id, io_number, campaign_name, io_value, currency,
         start_date, end_date, payment_terms, billing_cycle,
         legal_name, legal_address, legal_country, tax_id, company_reg_no,
         contact_name, contact_email, contact_phone, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, advertiser_id, io_number, campaign_name, +io_value, currency,
      start_date || null, end_date || null, payment_terms, billing_cycle,
      legal_name  || adv?.legal_name  || '',
      legal_address  || adv?.legal_address  || '',
      legal_country  || adv?.legal_country  || '',
      tax_id      || adv?.tax_id      || '',
      company_reg_no || adv?.company_reg_no || '',
      contact_name   || adv?.name     || '',
      contact_email  || adv?.email    || '',
      contact_phone,
      notes,
    );

    res.status(201).json(getIO(result.lastInsertRowid));
  } catch (err) { next(err); }
});

// ── GET /api/insertion-orders/:id ─────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const io = getIO(req.params.id);
  if (!io) return res.status(404).json({ error: 'Insertion order not found' });
  res.json(io);
});

// ── PUT /api/insertion-orders/:id ─────────────────────────────────────────────
router.put('/:id', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const io = db.prepare('SELECT id, status FROM insertion_orders WHERE id = ?').get(req.params.id);
    if (!io) return res.status(404).json({ error: 'Insertion order not found' });

    const fields = [
      'campaign_name','io_value','currency','start_date','end_date',
      'payment_terms','billing_cycle','legal_name','legal_address',
      'legal_country','tax_id','company_reg_no','contact_name',
      'contact_email','contact_phone','notes','status',
    ];

    const updates = [];
    const values  = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(req.body[f]);
      }
    }

    // When status changes to 'signed', record signed_at and sync legal info to advertiser profile
    if (req.body.status === 'signed' && io.status !== 'signed') {
      updates.push('signed_at = unixepoch()');
      // Sync legal entity info back to advertiser's user record
      const cur = getIO(io.id);
      if (cur) {
        db.prepare(`
          UPDATE users SET
            legal_name     = COALESCE(NULLIF(?, ''), legal_name),
            legal_address  = COALESCE(NULLIF(?, ''), legal_address),
            legal_country  = COALESCE(NULLIF(?, ''), legal_country),
            tax_id         = COALESCE(NULLIF(?, ''), tax_id),
            company_reg_no = COALESCE(NULLIF(?, ''), company_reg_no)
          WHERE id = ?
        `).run(
          req.body.legal_name || cur.legal_name,
          req.body.legal_address || cur.legal_address,
          req.body.legal_country || cur.legal_country,
          req.body.tax_id || cur.tax_id,
          req.body.company_reg_no || cur.company_reg_no,
          cur.advertiser_id,
        );
      }
    }

    if (updates.length === 0) return res.json(getIO(io.id));
    updates.push('updated_at = unixepoch()');
    values.push(io.id);
    db.prepare(`UPDATE insertion_orders SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json(getIO(io.id));
  } catch (err) { next(err); }
});

// ── DELETE /api/insertion-orders/:id ──────────────────────────────────────────
router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare("UPDATE insertion_orders SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
