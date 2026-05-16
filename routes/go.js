const express = require('express');
const db = require('../db/init');
const router = express.Router();

function classifyDevice(ua) {
  if (!ua) return 'web';
  if (/iPhone|iPad|iPod|iOS/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'web';
}

router.get('/:slug', (req, res) => {
  const ol = db.prepare(
    "SELECT * FROM onelinks WHERE slug = ? AND status = 'active'"
  ).get(req.params.slug);
  if (!ol) return res.status(404).send('Link not found or no longer active.');

  // Expiry check (null = no expiry).
  if (ol.expires_at && ol.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(410).send('This link has expired.');
  }

  const ua = req.headers['user-agent'] || '';
  const device = classifyDevice(ua);

  let dest;
  if (device === 'ios')          dest = ol.ios_deep_link || ol.ios_store_url || ol.web_fallback_url;
  else if (device === 'android') dest = ol.android_deep_link || ol.android_store_url || ol.web_fallback_url;
  else                           dest = ol.web_fallback_url || ol.android_store_url || ol.ios_store_url;

  if (!dest) return res.status(404).send('No destination configured for this device.');

  try {
    db.prepare('UPDATE onelinks SET total_clicks = total_clicks + 1 WHERE id = ?').run(ol.id);
  } catch {}

  res.redirect(302, dest);
});

module.exports = router;
