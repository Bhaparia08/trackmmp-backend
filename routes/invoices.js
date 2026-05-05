const express  = require('express');
const PDFDoc   = require('pdfkit');
const path     = require('path');
const db       = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const jwt    = require('jsonwebtoken');
const router = express.Router();

const LOGO_PATH = path.join(__dirname, '../public/assets/apogeemobi-logo.png');

// PDF download — registered BEFORE requireAuth so ?token= query param works in browser <a> links
router.get('/:id/pdf', (req, res, next) => {
  // Resolve user from Bearer header OR ?token= query param
  let user = null;
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  try {
    if (authHeader?.startsWith('Bearer ')) {
      user = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    } else if (queryToken) {
      user = jwt.verify(queryToken, process.env.JWT_SECRET);
    }
  } catch {}
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  _generatePDF(req, res, next);
});

router.use(requireAuth);

// ── Entity definitions ────────────────────────────────────────────────────────
const ENTITIES = {
  sg: {
    name:    'Appreach Global PTE. LTD.',
    address: '68 Circular Road, #02-01\nSingapore 049422',
    uen:     'UEN: 201805548E',
    gst:     null,
    prefix:  'APG-SG',
    banks: {
      default: {
        label:       'Bank Transfer (SWIFT)',
        holder:      'APPREACH GLOBAL PTE. LTD.',
        bank:        'The Currency Cloud Limited',
        iban:        'GB96TCCL04140419905668',
        swift:       'TCCLGB3L',
        bankAddress: '1 Sheldon Square, London, W2 6TT, United Kingdom',
      },
      us: {
        label:       'ACH Transfer (US)',
        holder:      'APPREACH GLOBAL PTE. LTD.',
        bank:        'Community Federal Savings Bank',
        account:     '8338103180',
        routing:     '026073150',
        bankAddress: '5 Penn Plaza, 14th Floor, New York, NY 10001, US',
      },
    },
  },
  in: {
    name:    'Appreach Media Private Limited',
    address: '177/17, Amritpuri B, East of Kailash\nNew Delhi – 110065',
    uen:     'CIN: U72200DL2018PTC337215',
    pan:     'PAN: AARCA1794R',
    gst:     'GST: 07AARCA1794R1ZP',
    prefix:  'APM-IN',
    banks: {
      default: {
        label:       'Bank Transfer (NEFT/RTGS/SWIFT)',
        holder:      'APPREACH MEDIA PRIVATE LIMITED',
        bank:        'Kotak Mahindra Bank',
        account:     '8112969741',
        ifsc:        'KKBK0004583',
        swift:       'KKBKINBB',
        bankAddress: 'Kotak Mahindra Bank, India',
      },
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Invoice numbers use the AM/YYYY/NNN format (continuing from historical records).
// Finds the global max across BOTH tables so numbers never clash.
function nextInvoiceNumber() {
  const year    = new Date().getFullYear();
  const pattern = `AM/${year}/%`;

  const lastInv  = db.prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1").get(pattern);
  const lastHist = db.prepare("SELECT invoice_number FROM historical_invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1").get(pattern);

  function seqOf(numStr) {
    if (!numStr) return 0;
    const parts = numStr.split('/');
    return parseInt(parts[parts.length - 1]) || 0;
  }

  const seq = Math.max(seqOf(lastInv?.invoice_number), seqOf(lastHist?.invoice_number)) + 1;
  return `AM/${year}/${String(seq).padStart(3, '0')}`;
}

// Status mapping: invoice status → historical status
function toHistStatus(invStatus) {
  if (invStatus === 'paid')      return 'received';
  if (invStatus === 'cancelled') return 'cancelled';
  if (invStatus === 'overdue')   return 'pending';
  return 'pending';
}

// Upsert a matching row in historical_invoices whenever an invoice is created/updated
function syncToHistorical(inv, advertiserName) {
  const existing = db.prepare('SELECT id FROM historical_invoices WHERE invoice_number = ?').get(inv.invoice_number);
  const histStatus = toHistStatus(inv.status);
  const payDate    = inv.status === 'paid' && inv.paid_at
    ? new Date(inv.paid_at * 1000).toISOString().slice(0, 10)
    : null;

  if (existing) {
    db.prepare(`
      UPDATE historical_invoices
      SET status = ?, payment_date = COALESCE(?, payment_date)
      WHERE invoice_number = ?
    `).run(histStatus, payDate, inv.invoice_number);
  } else {
    db.prepare(`
      INSERT INTO historical_invoices
        (invoice_number, client_name, entity, issue_date, payment_date, amount, currency, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      inv.invoice_number,
      advertiserName || '—',
      inv.entity || 'sg',
      inv.issue_date || null,
      payDate,
      Number(inv.total) || 0,
      inv.currency || 'USD',
      histStatus,
      inv.notes || ''
    );
  }
}

function pickBank(entity, advertiserCountry) {
  const e = ENTITIES[entity];
  if (!e?.banks) return null;
  const isUS = (advertiserCountry || '').toLowerCase().includes('us') ||
               (advertiserCountry || '').toLowerCase() === 'united states' ||
               (advertiserCountry || '').toLowerCase() === 'usa';
  return (isUS && e.banks.us) ? e.banks.us : (e.banks.default || null);
}

// ── GET /api/invoices/next-number — preview the next auto-generated invoice number ──
router.get('/next-number', requireRole('admin'), (req, res) => {
  res.json({ invoice_number: nextInvoiceNumber() });
});

// ── GET /api/invoices/historical — restricted to integration@apogeemobi.com only ──
router.get('/historical', requireRole('admin'), (req, res) => {
  if (req.user.email !== 'integration@apogeemobi.com')
    return res.status(403).json({ error: 'Access denied' });
  const { status, currency, from, to, search } = req.query;
  const conditions = [];
  const values = [];

  if (status)   { conditions.push('status = ?');       values.push(status); }
  if (currency) { conditions.push('currency = ?');     values.push(currency); }
  if (from)     { conditions.push('issue_date >= ?');  values.push(from); }
  if (to)       { conditions.push('issue_date <= ?');  values.push(to); }
  if (search)   {
    conditions.push('(client_name LIKE ? OR invoice_number LIKE ?)');
    values.push(`%${search}%`, `%${search}%`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT * FROM historical_invoices ${where} ORDER BY id DESC`
  ).all(...values);
  res.json(rows);
});

// ── PUT /api/invoices/historical/:id — restricted to integration@apogeemobi.com only ──
router.put('/historical/:id', requireRole('admin'), (req, res) => {
  if (req.user.email !== 'integration@apogeemobi.com')
    return res.status(403).json({ error: 'Access denied' });
  const { status, notes } = req.body;
  const row = db.prepare('SELECT * FROM historical_invoices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE historical_invoices SET status = COALESCE(?,status), notes = COALESCE(?,notes) WHERE id = ?')
    .run(status || null, notes != null ? notes : null, row.id);
  res.json(db.prepare('SELECT * FROM historical_invoices WHERE id = ?').get(row.id));
});

// ── GET /api/invoices — list ──────────────────────────────────────────────────
router.get('/', requireRole('admin'), (req, res) => {
  const { status, advertiser_id, from, to } = req.query;

  const conditions = [];
  const values     = [];

  if (advertiser_id) {
    conditions.push('i.advertiser_id = ?');
    values.push(advertiser_id);
  }

  if (status)  { conditions.push('i.status = ?'); values.push(status); }
  if (from)    { conditions.push('i.issue_date >= ?'); values.push(from); }
  if (to)      { conditions.push('i.issue_date <= ?'); values.push(to); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT i.*, u.name AS advertiser_name, u.email AS advertiser_email,
           u.legal_name, u.legal_country,
           cb.name AS created_by_name
    FROM invoices i
    LEFT JOIN users u  ON u.id = i.advertiser_id
    LEFT JOIN users cb ON cb.id = i.created_by
    ${where}
    ORDER BY i.created_at DESC
  `).all(...values);

  res.json(rows.map(r => ({ ...r, line_items: JSON.parse(r.line_items || '[]') })));
});

// ── GET /api/invoices/:id — detail ───────────────────────────────────────────
router.get('/:id', requireRole('admin'), (req, res) => {
  const inv = db.prepare(`
    SELECT i.*, u.name AS advertiser_name, u.email AS advertiser_email,
           u.legal_name, u.legal_address, u.legal_country, u.tax_id, u.company_reg_no,
           cb.name AS created_by_name
    FROM invoices i
    LEFT JOIN users u  ON u.id = i.advertiser_id
    LEFT JOIN users cb ON cb.id = i.created_by
    WHERE i.id = ?
  `).get(req.params.id);

  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  res.json({ ...inv, line_items: JSON.parse(inv.line_items || '[]') });
});

// ── POST /api/invoices — create ───────────────────────────────────────────────
router.post('/', requireRole('admin'), (req, res, next) => {
  try {
    const {
      entity = 'sg', advertiser_id, issue_date, due_date,
      line_items = [], notes = '', tax_rate = 0,
    } = req.body;

    if (!advertiser_id) return res.status(400).json({ error: 'advertiser_id required' });
    if (!issue_date)    return res.status(400).json({ error: 'issue_date required' });
    if (!due_date)      return res.status(400).json({ error: 'due_date required' });
    if (!Array.isArray(line_items) || line_items.length === 0)
      return res.status(400).json({ error: 'At least one line item required' });

    const adv = db.prepare('SELECT id, name, legal_name FROM users WHERE id = ?').get(advertiser_id);
    if (!adv) return res.status(404).json({ error: 'Advertiser not found' });

    const subtotal   = line_items.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const tax_amount = +(subtotal * (Number(tax_rate) / 100)).toFixed(2);
    const total      = +(subtotal + tax_amount).toFixed(2);

    const invoice_number = nextInvoiceNumber();

    const result = db.prepare(`
      INSERT INTO invoices
        (invoice_number, entity, advertiser_id, created_by, issue_date, due_date,
         currency, line_items, subtotal, tax_rate, tax_amount, total, notes, status)
      VALUES (?,?,?,?,?,?, 'USD',?,?,?,?,?,?,'draft')
    `).run(
      invoice_number, entity, advertiser_id, req.user.id,
      issue_date, due_date,
      JSON.stringify(line_items),
      +subtotal.toFixed(2), +Number(tax_rate).toFixed(2), tax_amount, total, notes
    );

    const created = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.lastInsertRowid);
    // Sync to historical_invoices
    try { syncToHistorical(created, adv.legal_name || adv.name); } catch {}
    res.status(201).json({ ...created, line_items: JSON.parse(created.line_items) });
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id — update ────────────────────────────────────────────
router.put('/:id', requireRole('admin'), (req, res, next) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'cancelled') return res.status(400).json({ error: 'Cancelled invoices cannot be edited' });

    const {
      entity, advertiser_id, issue_date, due_date,
      line_items, notes, tax_rate, status,
    } = req.body;

    const items    = line_items || JSON.parse(inv.line_items || '[]');
    const subtotal = items.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const rate     = tax_rate != null ? Number(tax_rate) : inv.tax_rate;
    const tax_amt  = +(subtotal * (rate / 100)).toFixed(2);
    const total    = +(subtotal + tax_amt).toFixed(2);

    const paid_at  = status === 'paid' && inv.status !== 'paid' ? Math.floor(Date.now() / 1000) : inv.paid_at;

    db.prepare(`
      UPDATE invoices SET
        entity = COALESCE(?, entity),
        advertiser_id = COALESCE(?, advertiser_id),
        issue_date = COALESCE(?, issue_date),
        due_date = COALESCE(?, due_date),
        line_items = ?, subtotal = ?, tax_rate = ?, tax_amount = ?, total = ?,
        notes = COALESCE(?, notes),
        status = COALESCE(?, status),
        paid_at = ?,
        updated_at = unixepoch()
      WHERE id = ?
    `).run(
      entity || null, advertiser_id || null, issue_date || null, due_date || null,
      JSON.stringify(items), +subtotal.toFixed(2), rate, tax_amt, total,
      notes != null ? notes : null,
      status || null, paid_at, inv.id
    );

    const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
    // Sync status/amount changes to historical_invoices
    try {
      const adv = db.prepare('SELECT name, legal_name FROM users WHERE id = ?').get(updated.advertiser_id);
      syncToHistorical(updated, adv?.legal_name || adv?.name);
    } catch {}
    res.json({ ...updated, line_items: JSON.parse(updated.line_items) });
  } catch (err) { next(err); }
});

// ── DELETE /api/invoices/:id — delete draft only ──────────────────────────────
router.delete('/:id', requireRole('admin'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'draft') return res.status(400).json({ error: 'Only draft invoices can be deleted' });
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── POST /api/invoices/:id/cancel — cancel any non-paid invoice ───────────────
// Cancelled invoices are frozen (no edits allowed) but kept in the system.
// The invoice number is permanently retired — the sequence continues from it,
// so the next new invoice gets the next sequential number (no gap reuse).
router.post('/:id/cancel', requireRole('admin'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv)                        return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status === 'paid')       return res.status(400).json({ error: 'Paid invoices cannot be cancelled' });
  if (inv.status === 'cancelled')  return res.status(400).json({ error: 'Invoice is already cancelled' });

  db.prepare(`UPDATE invoices SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?`).run(inv.id);
  const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
  // Sync cancellation to historical_invoices
  try {
    const adv = db.prepare('SELECT name, legal_name FROM users WHERE id = ?').get(updated.advertiser_id);
    syncToHistorical(updated, adv?.legal_name || adv?.name);
  } catch {}
  res.json({ ...updated, line_items: JSON.parse(updated.line_items || '[]') });
});

// ── PDF generator (called by the pre-auth route above) ───────────────────────

// Format a date string "YYYY-MM-DD" as "3rd Feb, 2026"
function fmtOrdinalDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st'
               : day === 2 || day === 22 ? 'nd'
               : day === 3 || day === 23 ? 'rd' : 'th';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${day}${suffix} ${months[d.getMonth()]}, ${d.getFullYear()}`;
}

// Format a due date as "3rd Mar 2026" (no comma after month)
function fmtOrdinalDue(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st'
               : day === 2 || day === 22 ? 'nd'
               : day === 3 || day === 23 ? 'rd' : 'th';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${day}${suffix} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Format amount with commas e.g. $6,391.80
function fmtAmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _generatePDF(req, res, next) {
  try {
    const inv = db.prepare(`
      SELECT i.*, u.name AS advertiser_name, u.email AS advertiser_email,
             u.legal_name, u.legal_address, u.legal_country, u.tax_id, u.company_reg_no,
             u.company_name AS advertiser_company
      FROM invoices i
      LEFT JOIN users u ON u.id = i.advertiser_id
      WHERE i.id = ?
    `).get(req.params.id);

    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const isAdmin = req.user.role === 'admin' || req.user.role === 'account_manager';
    if (!isAdmin && inv.advertiser_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const entity = ENTITIES[inv.entity] || ENTITIES.sg;
    const bank   = pickBank(inv.entity, inv.legal_country);
    const items  = JSON.parse(inv.line_items || '[]');

    // Advertiser display info
    const billName   = (inv.legal_name || inv.advertiser_name || '—').toUpperCase();
    const billAddr   = inv.legal_address || '';
    const custId     = inv.advertiser_company || inv.advertiser_name || '—';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);

    const doc = new PDFDoc({ size: 'A4', margins: { top: 40, bottom: 40, left: 50, right: 50 } });
    doc.pipe(res);

    const PW   = 595;          // page width
    const ML   = 50;           // margin left
    const MR   = 50;           // margin right
    const CW   = PW - ML - MR; // content width = 495
    const BLACK = '#000000';
    const GREY  = '#555555';
    const fs    = 9;           // base font size

    let y = 40;

    // ── Helper: draw a double horizontal rule (═══) ──────────────────────────
    function doubleRule(yPos) {
      doc.moveTo(ML, yPos).lineTo(PW - MR, yPos).lineWidth(0.8).strokeColor(BLACK).stroke();
      doc.moveTo(ML, yPos + 3).lineTo(PW - MR, yPos + 3).lineWidth(0.8).strokeColor(BLACK).stroke();
    }
    // ── Helper: draw a single horizontal rule (───) ──────────────────────────
    function singleRule(yPos) {
      doc.moveTo(ML, yPos).lineTo(PW - MR, yPos).lineWidth(0.5).strokeColor(BLACK).stroke();
    }

    // ══════════════════ TOP DOUBLE BORDER ═══════════════════════
    doubleRule(y);
    y += 14;

    // ── Logo ──────────────────────────────────────────────────────────────────
    const logoW = 160;
    try {
      doc.image(LOGO_PATH, (PW - logoW) / 2, y, { width: logoW });
    } catch (e) { /* logo not found — skip silently */ }
    y += 45;

    // ── Company header (centered) ─────────────────────────────────────────────
    const isSG = inv.entity !== 'in';
    doc.fontSize(12).font('Helvetica-Bold').fillColor(BLACK)
       .text(entity.name.toUpperCase(), ML, y, { width: CW, align: 'center' });
    y += 17;

    if (isSG) {
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text('68 CIRCULAR ROAD #02-01 SINGAPORE (049422)', ML, y, { width: CW, align: 'center' });
      y += 13;
      doc.text(`VAT: 201805548E`, ML, y, { width: CW, align: 'center' });
    } else {
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text('177/17, Amritpuri B, East of Kailash, New Delhi – 110065', ML, y, { width: CW, align: 'center' });
      y += 13;
      doc.text(`${entity.uen}`, ML, y, { width: CW, align: 'center' });
    }
    y += 13;
    doc.text('Email: Finance@apogeemobi.com', ML, y, { width: CW, align: 'center' });
    y += 13;
    doc.text('Website: www.apogeemobi.com', ML, y, { width: CW, align: 'center' });
    y += 14;

    // ══════════════════ BOTTOM OF HEADER DOUBLE BORDER ═══════════════════════
    doubleRule(y);
    y += 20;

    // ── Date ─────────────────────────────────────────────────────────────────
    doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
       .text(`Date: ${fmtOrdinalDate(inv.issue_date)}`, ML, y);
    y += 22;

    // ── Bill To (left) / Invoice details (right) ─────────────────────────────
    const leftW  = 270;
    const rightX = ML + leftW + 10;
    const rightW = CW - leftW - 10;

    const startY = y;

    // Left: Billed to
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
       .text('Billed to:', ML, y);
    y += 14;
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
       .text(billName, ML, y, { width: leftW });
    const nameLines = doc.heightOfString(billName, { width: leftW, fontSize: fs }) / 14;
    y += Math.ceil(nameLines) * 14;

    if (billAddr) {
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(billAddr, ML, y, { width: leftW });
      const addrLines = doc.heightOfString(billAddr, { width: leftW, fontSize: fs }) / 14;
      y += Math.ceil(addrLines) * 14;
    }

    // Right: Cust ID / Invoice no / Due Date
    const rightY = startY;
    const labelW = 85;
    const valX   = rightX + labelW;
    const valW   = rightW - labelW;

    function rightRow(label, value, rY) {
      doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
         .text(label, rightX, rY, { width: labelW });
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(value, valX, rY, { width: valW });
    }
    rightRow('Cust ID:',    custId,                         rightY);
    rightRow('Invoice no:', inv.invoice_number,             rightY + 16);
    rightRow('Due Date:',   fmtOrdinalDue(inv.due_date),    rightY + 32);

    y = Math.max(y, rightY + 50) + 16;

    // ── Items table ───────────────────────────────────────────────────────────
    singleRule(y); y += 8;

    // Table header
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
       .text('Description', ML, y, { width: CW - 90 });
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
       .text('Amount', ML + CW - 90, y, { width: 90, align: 'right' });
    y += 14;

    singleRule(y); y += 8;

    // Rows
    items.forEach(item => {
      const desc = item.description || '—';
      const amt  = fmtAmt(item.amount);
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(`  ${desc}`, ML, y, { width: CW - 90 });
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(amt, ML + CW - 90, y, { width: 90, align: 'right' });
      const h = Math.max(doc.heightOfString(desc, { width: CW - 100, fontSize: fs }), 14);
      y += h + 6;
    });

    singleRule(y); y += 8;

    // Total row
    if (inv.tax_rate > 0) {
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text('Subtotal', ML, y, { width: CW - 90 });
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(fmtAmt(inv.subtotal), ML + CW - 90, y, { width: 90, align: 'right' });
      y += 14;
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(`Tax (${inv.tax_rate}%)`, ML, y, { width: CW - 90 });
      doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
         .text(fmtAmt(inv.tax_amount), ML + CW - 90, y, { width: 90, align: 'right' });
      y += 14;
      singleRule(y); y += 8;
    }

    doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
       .text('Total', ML + CW - 90 - 60, y, { width: 60, align: 'right' });
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
       .text(fmtAmt(inv.total), ML + CW - 90, y, { width: 90, align: 'right' });
    y += 14;

    singleRule(y); y += 18;

    // Paid stamp
    if (inv.status === 'paid') {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#10b981')
         .text('[ PAID ]', ML, y, { width: CW, align: 'center' });
      y += 18;
    }

    // ── Thank you ──────────────────────────────────────────────────────────────
    doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
       .text('Thank you for your business!', ML, y);
    y += 22;

    // ── Payment method ────────────────────────────────────────────────────────
    if (bank) {
      doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
         .text('Payment method:', ML, y);
      y += 14;

      const pmLabel = 85;
      const pmValX  = ML + pmLabel + 10;
      const pmValW  = CW - pmLabel - 10;

      function pmRow(label, value) {
        doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK)
           .text(label, ML + 4, y, { width: pmLabel });
        doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
           .text(value, pmValX, y, { width: pmValW });
        y += 13;
      }

      pmRow('Account name:',    bank.holder);
      if (bank.account) pmRow('Account number/IBAN:', bank.account);
      if (bank.iban)    pmRow('Account number/IBAN:', bank.iban);
      pmRow('Bank name:',       bank.bank);
      if (bank.routing) pmRow('ACH Routing No:',  bank.routing);
      if (bank.ifsc)    pmRow('IFSC Code:',        bank.ifsc);
      if (bank.swift)   pmRow('SWIFT/BIC:',        bank.swift);
      pmRow('Branch address:',  bank.bankAddress);
      pmRow('Bank country:',    isSG ? 'United States (US)' : 'India');
      pmRow('Currency code:',   inv.currency || 'USD');
      y += 8;
    }

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (inv.notes) {
      doc.fontSize(fs).font('Helvetica-Bold').fillColor(BLACK).text('Notes:', ML, y);
      y += 13;
      doc.fontSize(fs).font('Helvetica').fillColor(GREY)
         .text(inv.notes, ML, y, { width: CW });
      y += doc.heightOfString(inv.notes, { width: CW, fontSize: fs }) + 10;
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    y += 6;
    doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
       .text('This is an electronically generated invoice, no signature is required.', ML, y, { width: CW });
    y += 22;

    doc.fontSize(fs + 1).font('Helvetica-Bold').fillColor(BLACK)
       .text('QUESTIONS?', ML, y, { width: CW, align: 'center' });
    y += 15;
    doc.fontSize(fs).font('Helvetica').fillColor(BLACK)
       .text('Please contact Mr. Lalji at finance@apogeemobi.com', ML, y, { width: CW, align: 'center' });
    y += 18;

    doubleRule(y);

    doc.end();
  } catch (err) { next(err); }
}

module.exports = router;
