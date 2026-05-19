/**
 * Currency API Routes — /api/currency
 * -------------------------------------
 * GET  /rates           — list today's exchange rates (all supported currencies)
 * GET  /convert         — convert an amount between two currencies
 * POST /refresh         — admin only: manually refresh rates from the free API
 * GET  /user-preference — get authenticated user's preferred currency
 * PUT  /user-preference — set authenticated user's preferred currency
 */

const { Router } = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  SUPPORTED_CURRENCIES,
  refreshRates,
  convert,
  getAllRates,
} = require('../utils/currencyConverter');

const router = Router();

// ── GET /rates ──────────────────────────────────────────────────────────────
router.get('/rates', requireAuth, (req, res) => {
  try {
    const rates = getAllRates();
    res.json({ base: 'USD', rates, supported: SUPPORTED_CURRENCIES });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /convert?amount=100&from=USD&to=INR ─────────────────────────────────
router.get('/convert', requireAuth, (req, res) => {
  try {
    const amount = parseFloat(req.query.amount);
    const from   = (req.query.from || 'USD').toUpperCase();
    const to     = (req.query.to   || 'USD').toUpperCase();

    if (isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });
    if (!SUPPORTED_CURRENCIES.includes(from)) return res.status(400).json({ error: `Unsupported currency: ${from}` });
    if (!SUPPORTED_CURRENCIES.includes(to))   return res.status(400).json({ error: `Unsupported currency: ${to}` });

    const converted = convert(amount, from, to);
    res.json({ amount, from, to, converted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /refresh — admin only ──────────────────────────────────────────────
router.post('/refresh', requireRole('admin'), async (req, res) => {
  try {
    await refreshRates();
    const rates = getAllRates();
    res.json({ message: 'Exchange rates refreshed', rates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /user-preference ────────────────────────────────────────────────────
router.get('/user-preference', requireAuth, (req, res) => {
  try {
    const row = db.prepare('SELECT preferred_currency FROM users WHERE id = ?').get(req.user.id);
    res.json({ preferred_currency: (row && row.preferred_currency) || 'USD' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /user-preference ────────────────────────────────────────────────────
router.put('/user-preference', requireAuth, (req, res) => {
  try {
    const currency = (req.body.currency || '').toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return res.status(400).json({ error: `Unsupported currency: ${currency}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}` });
    }
    db.prepare('UPDATE users SET preferred_currency = ? WHERE id = ?').run(currency, req.user.id);
    res.json({ preferred_currency: currency });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
