/**
 * /api/v1/links — Programmatic OneLink API (AppsFlyer OneLink API v2.0 equivalent).
 *
 * Auth: Bearer JWT (any admin) — same token used for the dashboard.
 * Rate-limited: 60 req/min per token.
 *
 * Endpoints:
 *   POST   /api/v1/links              create a OneLink, returns public_url + qr_code_data_url
 *   GET    /api/v1/links              list this user's OneLinks
 *   GET    /api/v1/links/:slug        fetch one by slug, with QR
 *   DELETE /api/v1/links/:slug        archive a OneLink
 *
 * Why separate from /api/preview/onelinks: the preview route returns admin-
 * scoped data for the dashboard UI; this is the documented programmatic
 * surface for integrations + scripts + Zapier-style automations.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { nanoid10 } = require('../utils/clickId');

const router = express.Router();
router.use(rateLimit({ windowMs: 60_000, max: 60 }));
router.use(requireAuth);

function trackingDomain(req) {
  if (process.env.TRACKING_DOMAIN) return process.env.TRACKING_DOMAIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

async function decorate(row, req) {
  if (!row) return row;
  const public_url = trackingDomain(req) + '/go/' + row.slug;
  let qr_code_data_url = null;
  try { qr_code_data_url = await QRCode.toDataURL(public_url, { width: 256, margin: 1 }); } catch {}
  return { ...row, public_url, qr_code_data_url };
}

router.post('/', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const {
      name,
      ios_store_url = '', android_store_url = '', web_fallback_url = '',
      ios_deep_link = '', android_deep_link = '',
      expiry_days,
    } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!ios_store_url && !android_store_url && !web_fallback_url) {
      return res.status(400).json({ error: 'at least one destination (iOS/Android/web) is required' });
    }
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
    res.status(201).json(await decorate(row, req));
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const rows = db.prepare(
      `SELECT * FROM onelinks WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100`
    ).all(req.user.id);
    res.json(await Promise.all(rows.map(r => decorate(r, req))));
  } catch (err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const row = db.prepare(
      `SELECT * FROM onelinks WHERE slug = ? AND user_id = ?`
    ).get(req.params.slug, req.user.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(await decorate(row, req));
  } catch (err) { next(err); }
});

router.delete('/:slug', (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const r = db.prepare(
      `UPDATE onelinks SET status = 'archived', updated_at = unixepoch() WHERE slug = ? AND user_id = ?`
    ).run(req.params.slug, req.user.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
