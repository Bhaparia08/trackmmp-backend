/**
 * SKAdNetwork (SKAN) Postback Receiver
 * Accepts Apple SKAN 3 and SKAN 4 postbacks from ad networks.
 *
 * SKAN 3: POST /skan/postback (Apple spec)
 * SKAN 4: POST /skan/postback (same endpoint, version differentiated by payload)
 *
 * Also provides a query API for admin reporting.
 */

const express = require('express');
const db = require('../db/init');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Inbound SKAN postbacks (public — Apple posts directly) ─────────────────
router.post('/postback', (req, res) => {
  try {
    const body = req.body || {};
    const ip   = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

    // Required SKAN fields
    const {
      'app-id': appId,
      'transaction-id': transactionId,
      version = '3',
      'source-app-id': sourceAppId,
      'source-identifier': sourceIdentifier,
      'conversion-value': conversionValue,
      'fidelity-type': fidelityType,
      'redownload': redownload,
      'did-win': didWin = true,
      'source-domain': sourceDomain,
      'attribution-signature': attributionSignature,
      'postback-sequence-index': postbackSequenceIndex = 0,
      // SKAN 4 coarse value
      'coarse-conversion-value': coarseValue,
    } = body;

    if (!appId || !transactionId) {
      // Return 200 per Apple spec — never return 4xx or Apple won't retry
      return res.status(200).send('OK');
    }

    // Find campaign by app bundle ID
    let campaignId = null;
    try {
      const app = db.prepare("SELECT id, user_id FROM apps WHERE bundle_id = ? LIMIT 1").get(appId);
      if (app) {
        const camp = db.prepare(
          "SELECT id FROM campaigns WHERE app_id = ? AND skan_enabled = 1 AND status = 'active' LIMIT 1"
        ).get(app.id);
        if (camp) campaignId = camp.id;
      }
    } catch {}

    // Determine fine value (SKAN 3: conversion_value 0-63, SKAN 4: separate fine/coarse)
    const fineValue   = conversionValue != null ? +conversionValue : null;
    const versionStr  = version ? String(version) : '3';
    const isV4        = parseFloat(versionStr) >= 4.0;

    db.prepare(`
      INSERT OR IGNORE INTO skan_postbacks (
        campaign_id, app_id, transaction_id, version,
        source_app_id, source_identifier,
        conversion_value, fine_value, coarse_value,
        redownload, did_win, source_domain,
        attribution_signature, postback_sequence_index,
        ip, raw_payload, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'received')
    `).run(
      campaignId, appId, transactionId, versionStr,
      sourceAppId || null, sourceIdentifier || null,
      fineValue, fineValue, coarseValue || null,
      redownload ? 1 : 0, didWin ? 1 : 0, sourceDomain || null,
      attributionSignature || null, +postbackSequenceIndex,
      ip, JSON.stringify(body)
    );

    // Update daily stats if we matched a campaign
    if (campaignId) {
      try {
        const camp = db.prepare('SELECT user_id, app_id FROM campaigns WHERE id = ?').get(campaignId);
        if (camp && didWin) {
          db.prepare(`
            INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, installs)
            VALUES (?,?,?,0,date('now'),1)
            ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
            DO UPDATE SET installs = installs + 1
          `).run(camp.user_id, camp.app_id || 0, campaignId);
        }
      } catch {}
    }

    // Always return 200 to Apple per SKAN spec
    res.status(200).send('OK');
  } catch (err) {
    console.error('[SKAN] postback error:', err.message);
    res.status(200).send('OK'); // Must always 200
  }
});

// ── SKAN Reporting (authenticated) ────────────────────────────────────────

// GET /skan/postbacks — list received SKAN postbacks (admin/AM only)
router.get('/postbacks', requireAuth, requireRole('admin', 'account_manager'), (req, res) => {
  const { campaign_id, from, to, limit = 50, offset = 0 } = req.query;

  const conditions = ['1=1'];
  const values = [];

  if (campaign_id) { conditions.push('s.campaign_id = ?'); values.push(campaign_id); }
  if (from) { conditions.push("date(datetime(s.created_at,'unixepoch')) >= ?"); values.push(from); }
  if (to)   { conditions.push("date(datetime(s.created_at,'unixepoch')) <= ?"); values.push(to); }

  const where = conditions.join(' AND ');

  const rows = db.prepare(`
    SELECT s.*, c.name AS campaign_name
    FROM skan_postbacks s
    LEFT JOIN campaigns c ON c.id = s.campaign_id
    WHERE ${where}
    ORDER BY s.created_at DESC LIMIT ? OFFSET ?
  `).all(...values, +limit, +offset);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM skan_postbacks s WHERE ${where}`).get(...values).n;

  // Conversion value distribution summary
  const dist = db.prepare(`
    SELECT conversion_value, COUNT(*) AS n
    FROM skan_postbacks s
    WHERE ${where} AND conversion_value IS NOT NULL
    GROUP BY conversion_value ORDER BY conversion_value ASC
  `).all(...values);

  res.json({ postbacks: rows, total, conversion_distribution: dist });
});

// GET /skan/summary — aggregated stats
router.get('/summary', requireAuth, requireRole('admin', 'account_manager'), (req, res) => {
  const { campaign_id } = req.query;
  const campFilter = campaign_id ? 'WHERE campaign_id = ?' : '';
  const campParam  = campaign_id ? [campaign_id] : [];

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN did_win = 1 THEN 1 END) AS won,
      COUNT(CASE WHEN redownload = 1 THEN 1 END) AS redownloads,
      COUNT(DISTINCT app_id) AS unique_apps,
      AVG(CASE WHEN conversion_value IS NOT NULL THEN conversion_value END) AS avg_conversion_value,
      COUNT(CASE WHEN version LIKE '4%' THEN 1 END) AS skan4_count
    FROM skan_postbacks ${campFilter}
  `).get(...campParam);

  res.json(stats);
});

module.exports = router;
