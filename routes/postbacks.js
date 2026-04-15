const express = require('express');
const rateLimit = require('express-rate-limit');
const { handlePostback } = require('../utils/postbackHandler');

const router = express.Router();
const pbLimiter = rateLimit({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

router.get('/', pbLimiter, (req, res, next) => {
  try {
    handlePostback(req.query, getIp(req), req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

router.post('/', pbLimiter, express.json(), (req, res, next) => {
  try {
    handlePostback({ ...req.query, ...req.body }, getIp(req), req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

module.exports = router;
