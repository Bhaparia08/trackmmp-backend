const express = require('express');
const db = require('../db/init');

const router = express.Router();

// POST /api/s2s/event
// Auth: authentication: {s2s_token} header (AF convention)
router.post('/event', (req, res, next) => {
  try {
    const token = req.headers['authentication'];
    if (!token) return res.status(401).json({ error: 'authentication header required' });

    const app = db.prepare('SELECT * FROM apps WHERE s2s_token = ? AND status = ?').get(token, 'active');
    if (!app) return res.status(401).json({ error: 'Invalid S2S token' });

    const {
      appsflyer_id, advertising_id, customer_user_id, app_version_name,
      eventName, eventValue, eventTime, ip: eventIp, bundleIdentifier
    } = req.body;

    if (!eventName) return res.status(400).json({ error: 'eventName is required' });

    const ip = eventIp || (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    db.prepare(`INSERT INTO s2s_events
      (app_id, user_id, appsflyer_id, advertising_id, customer_user_id,
       app_version_name, event_name, event_value, event_time, ip, bundle_identifier)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(app.id, app.user_id, appsflyer_id||null, advertising_id||null,
           customer_user_id||null, app_version_name||null, eventName,
           eventValue ? JSON.stringify(eventValue) : null,
           eventTime ? Math.floor(new Date(eventTime)/1000) : Math.floor(Date.now()/1000),
           ip, bundleIdentifier||null);

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
