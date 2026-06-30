const express = require('express');
const rateLimit = require('express-rate-limit');
const { handlePostback } = require('../utils/postbackHandler');
const { safeJsonParser } = require('../utils/safeJsonParser');

const router = express.Router();
const pbLimiter = rateLimit({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// MMP postback receivers must always return 200, regardless of internal errors.
// AppsFlyer/Adjust/etc. retry on non-2xx with exponential backoff for hours,
// which causes duplicate attribution noise and silent backlog growth. We catch
// any throw from handlePostback, log it for ops, and still acknowledge 200.
function safeHandle(params, ip, io) {
  try {
    handlePostback(params, ip, io);
  } catch (err) {
    console.error('[pb] handlePostback failed:', err && err.stack ? err.stack : err);
  }
}

router.get('/', pbLimiter, (req, res) => {
  safeHandle(req.query, getIp(req), req.app.get('io'));
  res.status(200).send('OK');
});

// safeJsonParser (not express.json directly) so a malformed JSON body cannot
// short-circuit to Express's default 400 — upstream networks retry on non-2xx.
router.post('/', pbLimiter, safeJsonParser(), (req, res) => {
  safeHandle({ ...req.query, ...req.body }, getIp(req), req.app.get('io'));
  res.status(200).send('OK');
});

module.exports = router;
