/**
 * Currency Converter Utility
 * ---------------------------
 * Fetches exchange rates from a free API, caches them in SQLite (one row per
 * currency per day), and exposes helpers to convert amounts between currencies.
 *
 * Supported currencies: USD, EUR, GBP, INR, BRL, MXN, SGD, AUD, CAD
 */

const db = require('../db/init');
const fetch = require('node-fetch');

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'BRL', 'MXN', 'SGD', 'AUD', 'CAD'];
const API_URL = 'https://open.er-api.com/v6/latest/USD';

// ── Helpers ─────────────────────────────────────────────────────────────────

function todayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── refreshRates ────────────────────────────────────────────────────────────
// Fetches the latest USD-based rates from the free API and upserts them into
// the exchange_rates table.  Safe to call multiple times per day — the UNIQUE
// constraint + INSERT OR REPLACE ensures idempotency.

async function refreshRates() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`Exchange rate API returned ${res.status}`);

  const data = await res.json();
  if (data.result !== 'success') throw new Error(`Exchange rate API error: ${data['error-type'] || 'unknown'}`);

  const rates = data.rates;
  const date = todayDate();

  const upsert = db.prepare(`
    INSERT INTO exchange_rates (base_currency, target_currency, rate, date)
    VALUES ('USD', ?, ?, ?)
    ON CONFLICT(base_currency, target_currency, date)
    DO UPDATE SET rate = excluded.rate
  `);

  const insertMany = db.transaction((pairs) => {
    for (const [currency, rate] of pairs) {
      upsert.run(currency, rate, date);
    }
  });

  const pairs = SUPPORTED_CURRENCIES
    .filter(c => rates[c] !== undefined)
    .map(c => [c, rates[c]]);

  insertMany(pairs);
  console.log(`[CurrencyRefresh] stored ${pairs.length} rates for ${date}`);
}

// ── getRate ─────────────────────────────────────────────────────────────────
// Returns the conversion rate from `from` → `to`.
// Strategy:
//   1. If from === to, return 1.
//   2. Look up USD→from and USD→to in the DB (today first, then most recent).
//   3. Derive cross-rate: rate = (USD→to) / (USD→from).

function getRate(from, to) {
  from = (from || 'USD').toUpperCase();
  to   = (to   || 'USD').toUpperCase();
  if (from === to) return 1;

  const rateFrom = _latestRate(from);
  const rateTo   = _latestRate(to);

  if (rateFrom === null || rateTo === null) {
    throw new Error(`Exchange rate not available for ${from}→${to}`);
  }

  return rateTo / rateFrom;
}

// ── convert ─────────────────────────────────────────────────────────────────
function convert(amount, from, to) {
  const rate = getRate(from, to);
  return Math.round(amount * rate * 100) / 100; // 2 decimal places
}

// ── getAllRates ──────────────────────────────────────────────────────────────
// Returns today's (or most recent) rates as { USD: 1, EUR: 0.92, ... }
function getAllRates() {
  const today = todayDate();
  let rows = db.prepare(
    'SELECT target_currency, rate FROM exchange_rates WHERE base_currency = ? AND date = ?'
  ).all('USD', today);

  if (rows.length === 0) {
    // Fallback: most recent date available
    rows = db.prepare(`
      SELECT target_currency, rate FROM exchange_rates
      WHERE base_currency = 'USD' AND date = (
        SELECT MAX(date) FROM exchange_rates WHERE base_currency = 'USD'
      )
    `).all();
  }

  const rates = { USD: 1 };
  for (const r of rows) rates[r.target_currency] = r.rate;
  return rates;
}

// ── Internal: get latest USD→currency rate ──────────────────────────────────
function _latestRate(currency) {
  if (currency === 'USD') return 1;

  const today = todayDate();

  // Try today first
  let row = db.prepare(
    'SELECT rate FROM exchange_rates WHERE base_currency = ? AND target_currency = ? AND date = ?'
  ).get('USD', currency, today);

  if (row) return row.rate;

  // Fallback: most recent
  row = db.prepare(
    'SELECT rate FROM exchange_rates WHERE base_currency = ? AND target_currency = ? ORDER BY date DESC LIMIT 1'
  ).get('USD', currency);

  return row ? row.rate : null;
}

module.exports = {
  SUPPORTED_CURRENCIES,
  refreshRates,
  getRate,
  convert,
  getAllRates,
};
