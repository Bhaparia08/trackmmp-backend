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
  // Map all ad-network postback param aliases → internal names
  return {
    ...raw,
    // Device IDs
    advertising_id: raw.advertising_id || raw.gaid || raw.gps_adid || null,
    // Goal / event
    event_name: raw.goal_value || raw.event_name || null,
    event: raw.goal_value ? (raw.event || 'custom') : (raw.event || 'install'),
    // Primary click ID — our platform's click_id returned by any MMP:
    //   click_id       — generic / standard
    //   transaction_id — Trackier / HasOffers / generic
    //   irclickid      — Impact Radius (we inject our click_id into irclickid in the dest URL)
    //   subid          — Admitad (we inject our click_id into subid in the dest URL)
    //   aff_click_id   — HasOffers/TUNE alternative
    click_id: raw.click_id || raw.transaction_id || raw.irclickid || raw.subid || raw.aff_click_id || null,
    transaction_id: raw.transaction_id || raw.click_id || null,
    // Publisher's own click ID for secondary attribution:
    //   clickid       — standard / AppsFlyer / Adjust
    //   irclickid     — Impact Radius (secondary fallback if not used as primary)
    //   aff_sub       — HasOffers alternative click ID passthrough
    //   u1            — Rakuten LinkShare
    clickid: raw.clickid || raw.irclickid || raw.aff_click_id || raw.aff_sub || raw.u1 || null,
  };
}

// FIX #7: log when security_token is absent so admin can identify unprotected integrations
function warnIfNoToken(params) {
  if (!params.security_token && !params.click_id && !params.transaction_id) {
    console.warn('[acquisition] postback with no security_token and no click_id — likely misconfigured integration. IP:', params._ip);
  }
}

router.get('/', acqLimiter, (req, res, next) => {
  try {
    const p = normalise(req.query);
    p._ip = getIp(req);
    warnIfNoToken(p);
    handlePostback(p, getIp(req), req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

router.post('/', acqLimiter, express.json(), (req, res, next) => {
  try {
    const p = normalise({ ...req.query, ...req.body });
    p._ip = getIp(req);
    warnIfNoToken(p);
    handlePostback(p, getIp(req), req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

module.exports = router;
