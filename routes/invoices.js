const express  = require('express');
const PDFDoc   = require('pdfkit');
const db       = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const jwt    = require('jsonwebtoken');
const router = express.Router();

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
  if (invStatus === 'paid')    return 'received';
  if (invStatus === 'overdue') return 'pending';
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

// ── GET /api/invoices/historical — admin-only historical records list ─────────
router.get('/historical', requireRole('admin'), (req, res) => {
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

// ── PUT /api/invoices/historical/:id — update status/notes ───────────────────
router.put('/historical/:id', requireRole('admin'), (req, res) => {
  const { status, notes } = req.body;
  const row = db.prepare('SELECT * FROM historical_invoices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE historical_invoices SET status = COALESCE(?,status), notes = COALESCE(?,notes) WHERE id = ?')
    .run(status || null, notes != null ? notes : null, row.id);
  res.json(db.prepare('SELECT * FROM historical_invoices WHERE id = ?').get(row.id));
});

// ── GET /api/invoices — list ──────────────────────────────────────────────────
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'account_manager';
  const { status, advertiser_id, from, to } = req.query;

  const conditions = [];
  const values     = [];

  if (!isAdmin) {
    // Advertiser only sees their own invoices
    conditions.push('i.advertiser_id = ?');
    values.push(req.user.id);
  } else if (advertiser_id) {
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
router.get('/:id', (req, res) => {
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

  const isAdmin = req.user.role === 'admin' || req.user.role === 'account_manager';
  if (!isAdmin && inv.advertiser_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });

  res.json({ ...inv, line_items: JSON.parse(inv.line_items || '[]') });
});

// ── POST /api/invoices — create ───────────────────────────────────────────────
router.post('/', requireRole('admin', 'account_manager'), (req, res, next) => {
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
router.put('/:id', requireRole('admin', 'account_manager'), (req, res, next) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

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

// ── PDF generator (called by the pre-auth route above) ───────────────────────
function _generatePDF(req, res, next) {
  try {
    const inv = db.prepare(`
      SELECT i.*, u.name AS advertiser_name, u.email AS advertiser_email,
             u.legal_name, u.legal_address, u.legal_country, u.tax_id, u.company_reg_no
      FROM invoices i
      LEFT JOIN users u ON u.id = i.advertiser_id
      WHERE i.id = ?
    `).get(req.params.id);

    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const isAdmin = req.user.role === 'admin' || req.user.role === 'account_manager';
    if (!isAdmin && inv.advertiser_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const entity   = ENTITIES[inv.entity] || ENTITIES.sg;
    const bank     = pickBank(inv.entity, inv.legal_country);
    const items    = JSON.parse(inv.line_items || '[]');
    const isUS     = (inv.legal_country || '').toLowerCase().includes('us') ||
                     (inv.legal_country || '').toLowerCase() === 'united states' ||
                     (inv.legal_country || '').toLowerCase() === 'usa';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);

    const doc = new PDFDoc({ size: 'A4', margin: 50 });
    doc.pipe(res);

    const W    = 595 - 100; // usable width
    const ACCENT  = '#1a1a2e';
    const MUTED   = '#666666';
    const BORDER  = '#e2e8f0';
    const GREEN   = '#10b981';

    // ── Header bar ────────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 80).fill(ACCENT);
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold')
       .text(entity.name, 50, 24, { width: 350 });
    doc.fontSize(9).font('Helvetica').fillColor('#a0aec0')
       .text('TAX INVOICE', 50, 48);

    // Invoice number top right
    doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
       .text(inv.invoice_number, 395, 28, { width: 150, align: 'right' });
    doc.fontSize(8).font('Helvetica').fillColor('#a0aec0')
       .text(`Issued: ${inv.issue_date}   Due: ${inv.due_date}`, 395, 46, { width: 150, align: 'right' });

    doc.fillColor('#000000');
    let y = 105;

    // ── FROM / TO columns ─────────────────────────────────────────────────────
    // FROM
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
       .text('FROM', 50, y, { width: 220 });
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
       .text('BILL TO', 310, y, { width: 235 });
    y += 14;

    doc.fontSize(10).font('Helvetica-Bold').fillColor(ACCENT)
       .text(entity.name, 50, y, { width: 220 });
    const billTo = inv.legal_name || inv.advertiser_name || '—';
    doc.fontSize(10).font('Helvetica-Bold').fillColor(ACCENT)
       .text(billTo, 310, y, { width: 235 });
    y += 15;

    doc.fontSize(8.5).font('Helvetica').fillColor('#333333')
       .text(entity.address, 50, y, { width: 220 });
    const billAddr = inv.legal_address || inv.advertiser_email || '';
    doc.fontSize(8.5).font('Helvetica').fillColor('#333333')
       .text(billAddr, 310, y, { width: 235 });

    const fromLines = entity.address.split('\n').length;
    y += fromLines * 13 + 5;

    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text(entity.uen, 50, y, { width: 220 });
    if (inv.legal_country) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text(`Country: ${inv.legal_country}`, 310, y, { width: 235 });
    }
    y += 13;

    if (entity.pan) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text(entity.pan, 50, y, { width: 220 });
      y += 13;
    }

    if (entity.gst) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text(entity.gst, 50, y, { width: 220 });
      y += 13;
    }

    if (inv.tax_id) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text(`Tax ID: ${inv.tax_id}`, 310, y - 13, { width: 235 });
    }
    if (inv.company_reg_no) {
      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text(`Reg No: ${inv.company_reg_no}`, 310, y, { width: 235 });
      y += 13;
    }

    y += 20;

    // ── Divider ───────────────────────────────────────────────────────────────
    doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(BORDER).stroke();
    y += 18;

    // ── Line items table ──────────────────────────────────────────────────────
    // Header
    doc.rect(50, y, W, 22).fill('#f8fafc');
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
    doc.text('#',           55,  y + 7, { width: 20 });
    doc.text('DESCRIPTION', 80,  y + 7, { width: 250 });
    doc.text('QTY',         340, y + 7, { width: 50,  align: 'right' });
    doc.text('UNIT PRICE',  395, y + 7, { width: 75,  align: 'right' });
    doc.text('AMOUNT',      475, y + 7, { width: 70,  align: 'right' });
    y += 22;

    // Rows
    items.forEach((item, i) => {
      const rowH = 24;
      if (i % 2 === 0) doc.rect(50, y, W, rowH).fill('#fafafa');
      doc.fontSize(9).font('Helvetica').fillColor('#1a202c');
      doc.text(String(i + 1),                 55,  y + 7, { width: 20 });
      doc.text(item.description || '—',       80,  y + 7, { width: 250 });
      doc.text(String(item.quantity || 1),    340, y + 7, { width: 50,  align: 'right' });
      const up = item.unit_price != null ? item.unit_price : (item.amount / (item.quantity || 1));
      doc.text(`$${Number(up).toFixed(2)}`,   395, y + 7, { width: 75,  align: 'right' });
      doc.text(`$${Number(item.amount).toFixed(2)}`, 475, y + 7, { width: 70, align: 'right' });
      y += rowH;
    });

    doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor(BORDER).stroke();
    y += 16;

    // ── Totals ────────────────────────────────────────────────────────────────
    const totalsX = 370;
    const totalsW = 175;

    function totalRow(label, value, bold = false, color = '#1a202c') {
      doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(MUTED)
         .text(label, totalsX, y, { width: 90 });
      doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color)
         .text(value, totalsX + 95, y, { width: 80, align: 'right' });
      y += 16;
    }

    totalRow('Subtotal (USD)', `$${Number(inv.subtotal).toFixed(2)}`);
    if (inv.tax_rate > 0) {
      totalRow(`Tax (${inv.tax_rate}%)`, `$${Number(inv.tax_amount).toFixed(2)}`);
    }

    y += 4;
    doc.rect(totalsX - 5, y - 6, totalsW + 10, 28).fill(ACCENT);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#ffffff')
       .text('TOTAL DUE', totalsX, y + 2, { width: 90 });
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#ffffff')
       .text(`USD $${Number(inv.total).toFixed(2)}`, totalsX + 95, y + 2, { width: 80, align: 'right' });
    y += 36;

    // Status badge
    if (inv.status === 'paid') {
      doc.rect(50, y - 30, 70, 22).fill('#d1fae5');
      doc.fontSize(10).font('Helvetica-Bold').fillColor(GREEN)
         .text('✓ PAID', 55, y - 24, { width: 60 });
    }

    y += 20;

    // ── Payment Details ────────────────────────────────────────────────────────
    if (bank) {
      doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor(BORDER).stroke();
      y += 16;

      doc.fontSize(9).font('Helvetica-Bold').fillColor(ACCENT)
         .text('PAYMENT DETAILS', 50, y);
      y += 14;

      doc.fontSize(8).font('Helvetica').fillColor(MUTED)
         .text(`Please remit payment via ${bank.label}:`, 50, y);
      y += 14;

      const bankLines = [
        ['Account Holder', bank.holder],
        ...(bank.account ? [['Account Number',   bank.account]] : []),
        ...(bank.iban    ? [['IBAN',             bank.iban]]    : []),
        ...(bank.ifsc    ? [['IFSC Code',        bank.ifsc]]    : []),
        ...(bank.swift   ? [['SWIFT/BIC',        bank.swift]]   : []),
        ...(bank.routing ? [['ACH Routing No.',  bank.routing]] : []),
        ['Bank',            bank.bank],
        ['Bank Address',    bank.bankAddress],
      ];

      bankLines.forEach(([label, value]) => {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#4a5568')
           .text(`${label}:`, 50, y, { width: 130 });
        doc.fontSize(8).font('Helvetica').fillColor('#1a202c')
           .text(value, 185, y, { width: 360 });
        y += 13;
      });

      if (isUS && inv.entity === 'sg') {
        y += 5;
        doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
           .text('Funds are received by The Currency Cloud Inc. on behalf of Appreach Global PTE. LTD.', 50, y, { width: W });
        y += 11;
      }
    }

    // ── Notes ──────────────────────────────────────────────────────────────────
    if (inv.notes) {
      y += 10;
      doc.moveTo(50, y).lineTo(545, y).lineWidth(0.5).strokeColor(BORDER).stroke();
      y += 14;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', 50, y);
      y += 12;
      doc.fontSize(8.5).font('Helvetica').fillColor('#4a5568').text(inv.notes, 50, y, { width: W });
    }

    // ── Footer ─────────────────────────────────────────────────────────────────
    const pageH = doc.page.height;
    doc.moveTo(50, pageH - 60).lineTo(545, pageH - 60).lineWidth(0.5).strokeColor(BORDER).stroke();
    if (inv.entity === 'in') {
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(MUTED)
         .text('This is an electronically generated invoice and does not require a physical signature.',
           50, pageH - 50, { width: W, align: 'center' });
    }
    doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
       .text(
         `${entity.name}  •  ${entity.uen}${entity.gst ? '  •  ' + entity.gst : ''}  •  Invoice ${inv.invoice_number}`,
         50, pageH - 38, { width: W, align: 'center' }
       );

    doc.end();
  } catch (err) { next(err); }
}

module.exports = router;
