const express = require('express');
const db = require('../db/init');
const { nanoid16 } = require('../utils/clickId');
const { parseDevice } = require('../utils/deviceParser');
const { lookupCountry } = require('../utils/geoip');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });

// GET /track/click/:campaign_token
router.get('/click/:campaign_token', clickLimiter, async (req, res, next) => {
  try {
    const campaign = db.prepare(
      "SELECT * FROM campaigns WHERE campaign_token = ? AND status = 'active'"
    ).get(req.params.campaign_token);

    if (!campaign) return res.status(404).send('Campaign not found or inactive');

    const q = req.query;
    const ua = req.headers['user-agent'] || '';
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const country = await lookupCountry(ip);
    const { device_type, os, browser, platform } = parseDevice(ua);
    const language = req.headers['accept-language']?.split(',')[0] || '';

    // Resolve publisher by pub_token (pid param)
    let publisher_id = null;
    if (q.pid) {
      const pub = db.prepare('SELECT id FROM publishers WHERE pub_token = ? AND user_id = ?')
        .get(q.pid, campaign.user_id);
      if (pub) publisher_id = pub.id;
    }

    const click_id = nanoid16();
    const publisher_click_id = q.clickid || q.click_id || null;

    db.prepare(`INSERT INTO clicks
      (click_id, campaign_id, publisher_id, user_id, pid, af_c_id, af_siteid,
       af_sub1, af_sub2, af_sub3, af_sub4, af_sub5, publisher_click_id,
       ip, user_agent, country, language, device_type, os, browser, advertising_id, platform, referrer)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(click_id, campaign.id, publisher_id, campaign.user_id,
           q.pid||null, q.af_c_id||null, q.af_siteid||null,
           q.af_sub1||null, q.af_sub2||null, q.af_sub3||null, q.af_sub4||null, q.af_sub5||null,
           publisher_click_id, ip, ua, country, language, device_type, os, browser,
           q.advertising_id||null, platform, req.headers.referer||null);

    // Upsert daily clicks
    db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, clicks)
      VALUES (?,?,?,?,date('now'),1)
      ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
      DO UPDATE SET clicks = clicks + 1`)
      .run(campaign.user_id, campaign.app_id||0, campaign.id, publisher_id||0);

    res.cookie('_cid', click_id, { maxAge: 86400000, httpOnly: true, sameSite: 'Lax' });

    const dest = campaign.destination_url || '/';
    const separator = dest.includes('?') ? '&' : '?';
    return res.redirect(302, `${dest}${separator}click_id=${click_id}`);
  } catch (err) { next(err); }
});

module.exports = router;
