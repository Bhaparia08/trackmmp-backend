/**
 * /acquisition — Trackier-compatible postback endpoint
 *
 * Accepts:
 *   click_id        {click_id}      — platform click ID
 *   security_token  <static>        — campaign security token (embedded in URL)
 *   idfa            {idfa}          — Apple IDFA
 *   gaid            {gaid}          — Google Advertising ID
 *   goal_value      {event_name}    — event name for event postbacks (omit for install)
 *   payout          {payout}        — publisher payout
 *   revenue         {revenue}       — advertiser revenue
 *   currency        {currency}      — ISO currency code
 *   sub1–sub10, creative_id, etc.   — passthrough params
 *
 * Always returns 200 OK (required by all ad networks).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { handlePostback } = require('../utils/postbackHandler');

const router = express.Router();
const acqLimiter = rateLimit({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function normalise(raw) {
  // Map Trackier-style param names → internal names
  return {
    ...raw,
    // gaid → advertising_id  (Google Advertising ID)
    advertising_id: raw.advertising_id || raw.gaid || raw.gps_adid || null,
    // goal_value → event_name  (event postback param)
    event_name: raw.goal_value || raw.event_name || null,
    // goal_value present → event type is 'custom'; otherwise default install
    event: raw.goal_value ? (raw.event || 'custom') : (raw.event || 'install'),
    // click_id can come as click_id (Trackier) or clickid (AF-style)
    click_id: raw.click_id || raw.clickid || null,
    clickid: raw.clickid || raw.click_id || null,
  };
}

router.get('/', acqLimiter, (req, res, next) => {
  try {
    handlePostback(normalise(req.query), getIp(req), req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

router.post('/', acqLimiter, express.json(), (req, res, next) => {
  try {
    handlePostback(normalise({ ...req.query, ...req.body }), getIp(req), req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

module.exports = router;
