/**
 * Adjust-compatible S2S endpoints.
 *
 * These endpoints mirror Adjust's own API format so apps already
 * integrated with Adjust can point their S2S calls at TrackMMP
 * by simply changing the base URL.
 *
 * Adjust S2S Event:  POST/GET https://s2s.adjust.com/event
 * Adjust S2S Session: POST https://app.adjust.com/session
 *
 * Our equivalents:
 *   POST/GET /adjust/event
 *   POST     /adjust/session
 */

const express = require('express');
const db = require('../db/init');

const router = express.Router();

/**
 * Resolve app by Adjust app_token.
 * Returns the app row or null.
 */
function resolveApp(app_token) {
  if (!app_token) return null;
  return db.prepare("SELECT * FROM apps WHERE adjust_app_token = ? AND status = 'active'").get(app_token);
}

/**
 * Validate the Adjust S2S security token.
 * Adjust sends it as query param `s2s_token` or in Authorization header.
 */
function validateS2SToken(app, req) {
  if (!app.adjust_s2s_token) return true; // no token configured → open (dev mode)
  const paramToken = req.query.s2s_token || req.body?.s2s_token;
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  return paramToken === app.adjust_s2s_token || headerToken === app.adjust_s2s_token;
}

/**
 * Extract device identifiers from request params (supports both GET query and POST body).
 */
function extractDevice(params) {
  return {
    idfa:              params.idfa || null,
    idfv:              params.idfv || null,
    gps_adid:          params.gps_adid || null,
    android_id:        params.android_id || null,
    adid:              params.adid || null,
    fire_adid:         params.fire_adid || null,
    oaid:              params.oaid || null,
    web_uuid:          params.web_uuid || null,
    google_app_set_id: params.google_app_set_id || null,
    att_status:        params.att_status || null,
    os_name:           params.os_name || null,
    device_name:       params.device_name || null,
    device_type:       params.device_type || null,
    os_version:        params.os_version || null,
    ip_address:        params.ip_address || null,
    user_agent:        params.user_agent || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /adjust/event  (mirrors https://s2s.adjust.com/event)
// GET  /adjust/event
// ─────────────────────────────────────────────────────────────────────────────
async function handleEvent(req, res, next) {
  try {
    const params = { ...req.query, ...req.body };

    // s2s=1 is required by Adjust spec
    if (params.s2s !== '1') {
      return res.status(400).json({ error: 'Missing s2s=1 parameter' });
    }

    const { app_token, event_token, environment = 'production' } = params;
    if (!app_token) return res.status(400).json({ error: 'app_token is required' });
    if (!event_token) return res.status(400).json({ error: 'event_token is required' });

    const app = resolveApp(app_token);
    if (!app) return res.status(401).json({ error: 'Invalid app_token' });

    if (!validateS2SToken(app, req)) {
      return res.status(401).json({ error: 'Invalid S2S security token' });
    }

    // Resolve event name from stored event token mapping
    const eventTokenRow = db.prepare(
      'SELECT event_name FROM adjust_event_tokens WHERE app_id = ? AND event_token = ?'
    ).get(app.id, event_token);
    const eventName = eventTokenRow?.event_name || event_token;

    const device = extractDevice(params);
    const ip = device.ip_address ||
      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // Parse callback_params and partner_params
    let callbackParams = null, partnerParams = null;
    try { callbackParams = params.callback_params ? JSON.stringify(JSON.parse(decodeURIComponent(params.callback_params))) : null; } catch {}
    try { partnerParams = params.partner_params ? JSON.stringify(JSON.parse(decodeURIComponent(params.partner_params))) : null; } catch {}

    // Timestamp: prefer created_at_unix, fall back to created_at, then now
    let eventTime = Math.floor(Date.now() / 1000);
    if (params.created_at_unix) eventTime = parseInt(params.created_at_unix);
    else if (params.created_at) eventTime = Math.floor(new Date(params.created_at) / 1000);

    const eventValue = callbackParams || partnerParams || null;

    db.prepare(`INSERT INTO s2s_events
      (app_id, user_id, appsflyer_id, advertising_id, customer_user_id,
       app_version_name, event_name, event_value, event_time, ip, bundle_identifier)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        app.id, app.user_id,
        device.adid || null,
        device.gps_adid || device.idfa || device.oaid || null,
        params.external_device_id || null,
        params.app_version || null,
        eventName,
        eventValue,
        eventTime,
        ip,
        app.bundle_id
      );

    // If revenue event, emit socket notification
    if (params.revenue) {
      const io = req.app.get('io');
      if (io) {
        io.to(app.user_id.toString()).emit('postback', {
          event_type: 'purchase',
          event_name: eventName,
          payout: parseFloat(params.revenue) || 0,
          campaign_name: 'Adjust S2S',
          click_id: device.adid || device.gps_adid || '—',
          created_at: eventTime,
          status: 'attributed',
          source: 'adjust',
        });
      }
    }

    // Adjust's expected response is plain "OK"
    res.status(200).send('OK');
  } catch (err) { next(err); }
}

router.get('/event', handleEvent);
router.post('/event', express.urlencoded({ extended: false }), handleEvent);

// ─────────────────────────────────────────────────────────────────────────────
// POST /adjust/session (mirrors https://app.adjust.com/session)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/session', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const params = { ...req.query, ...req.body };
    if (params.s2s !== '1') return res.status(400).json({ error: 'Missing s2s=1 parameter' });

    const app = resolveApp(params.app_token);
    if (!app) return res.status(401).json({ error: 'Invalid app_token' });
    if (!validateS2SToken(app, req)) return res.status(401).json({ error: 'Invalid S2S security token' });

    const device = extractDevice(params);
    const ip = device.ip_address ||
      (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // Store session as an s2s_event with event_name = 'session'
    db.prepare(`INSERT INTO s2s_events
      (app_id, user_id, appsflyer_id, advertising_id, customer_user_id,
       app_version_name, event_name, event_value, event_time, ip, bundle_identifier)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        app.id, app.user_id,
        device.adid || null,
        device.gps_adid || device.idfa || null,
        params.external_device_id || null,
        params.app_version || null,
        'session',
        JSON.stringify({ os_name: device.os_name, device_type: device.device_type }),
        Math.floor(Date.now() / 1000),
        ip,
        app.bundle_id
      );

    res.status(200).send('OK');
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Adjust event token management (authenticated)
// POST /adjust/tokens         — add an event token mapping
// GET  /adjust/tokens/:app_id — list all event tokens for an app
// DELETE /adjust/tokens/:id   — remove a token mapping
// ─────────────────────────────────────────────────────────────────────────────
const { requireAuth } = require('../middleware/auth');

router.get('/tokens/:app_id', requireAuth, (req, res) => {
  const app = db.prepare('SELECT id FROM apps WHERE id = ? AND user_id = ?').get(req.params.app_id, req.user.id);
  if (!app) return res.status(404).json({ error: 'App not found' });

  const tokens = db.prepare('SELECT * FROM adjust_event_tokens WHERE app_id = ? ORDER BY event_name ASC').all(app.id);
  res.json(tokens);
});

router.post('/tokens', requireAuth, (req, res, next) => {
  try {
    const { app_id, event_name, event_token } = req.body;
    if (!app_id || !event_name || !event_token) {
      return res.status(400).json({ error: 'app_id, event_name and event_token are required' });
    }
    const app = db.prepare('SELECT id FROM apps WHERE id = ? AND user_id = ?').get(app_id, req.user.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    const result = db.prepare(
      'INSERT OR REPLACE INTO adjust_event_tokens (app_id, user_id, event_name, event_token) VALUES (?,?,?,?)'
    ).run(app.id, req.user.id, event_name, event_token);

    res.status(201).json(db.prepare('SELECT * FROM adjust_event_tokens WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) { next(err); }
});

router.delete('/tokens/:id', requireAuth, (req, res, next) => {
  try {
    const token = db.prepare('SELECT * FROM adjust_event_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!token) return res.status(404).json({ error: 'Token not found' });
    db.prepare('DELETE FROM adjust_event_tokens WHERE id = ?').run(token.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
