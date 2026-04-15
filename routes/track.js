const express = require('express');
const db = require('../db/init');
const { nanoid16 } = require('../utils/clickId');
const { parseDevice } = require('../utils/deviceParser');
const { lookupCountry } = require('../utils/geoip');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const clickLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const impLimiter   = rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false });

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

    // Resolve publisher
    let publisher_id = null;
    if (q.pid) {
      const pub = db.prepare('SELECT id FROM publishers WHERE pub_token = ? AND user_id = ?')
        .get(q.pid, campaign.user_id);
      if (pub) publisher_id = pub.id;
    }

    // Support all major click ID param names
    const publisher_click_id = q.clickid || q.click_id || q.irclickid || q.aff_click_id || null;

    // Support Adjust's gps_adid, idfa, adid
    const advertising_id = q.advertising_id || q.gps_adid || q.idfa || q.adid || null;

    const click_id = nanoid16();

    db.prepare(`INSERT INTO clicks
      (click_id, campaign_id, publisher_id, user_id,
       pid, af_c_id, af_siteid,
       af_sub1, af_sub2, af_sub3, af_sub4, af_sub5,
       sub6, sub7, sub8, sub9, sub10,
       publisher_click_id, ip, user_agent, country, language,
       device_type, os, browser, advertising_id, platform, referrer,
       creative_id, ad_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(click_id, campaign.id, publisher_id, campaign.user_id,
           q.pid||null, q.af_c_id||null, q.af_siteid||null,
           q.af_sub1||q.sub1||null, q.af_sub2||q.sub2||null,
           q.af_sub3||q.sub3||null, q.af_sub4||q.sub4||null, q.af_sub5||q.sub5||null,
           q.sub6||null, q.sub7||null, q.sub8||null, q.sub9||null, q.sub10||null,
           publisher_click_id, ip, ua, country, language,
           device_type, os, browser, advertising_id, platform,
           req.headers.referer||null,
           q.creative_id||q.creative||null, q.ad_id||null);

    // Daily stats upsert
    db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, clicks)
      VALUES (?,?,?,?,date('now'),1)
      ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
      DO UPDATE SET clicks = clicks + 1`)
      .run(campaign.user_id, campaign.app_id||0, campaign.id, publisher_id||0);

    res.cookie('_cid', click_id, { maxAge: 86400000, httpOnly: true, sameSite: 'Lax' });

    // ── Macro substitution in advertiser's destination/tracking URL ──────────
    // The destination_url may contain the advertiser's own macro placeholders.
    // We replace all known macros with the real values captured at click time.
    let dest = campaign.destination_url || '/';

    const macroMap = {
      // Our click IDs
      '{click_id}':           click_id,
      '{our_click_id}':       click_id,
      // Publisher's own click ID (sent in clickid= param, returned in postbacks)
      '{publisher_click_id}': publisher_click_id || '',
      '{clickid}':            publisher_click_id || '',
      // Publisher / media source tokens
      '{pid}':                q.pid || '',
      '{pub_token}':          q.pid || '',
      '{af_siteid}':          q.af_siteid || '',
      '{site_id}':            q.af_siteid || '',
      // Sub-parameters (both naming conventions)
      '{sub1}':  q.af_sub1 || q.sub1 || '',
      '{sub2}':  q.af_sub2 || q.sub2 || '',
      '{sub3}':  q.af_sub3 || q.sub3 || '',
      '{sub4}':  q.af_sub4 || q.sub4 || '',
      '{sub5}':  q.af_sub5 || q.sub5 || '',
      '{sub6}':  q.sub6 || '',
      '{sub7}':  q.sub7 || '',
      '{sub8}':  q.sub8 || '',
      '{sub9}':  q.sub9 || '',
      '{sub10}': q.sub10 || '',
      '{af_sub1}': q.af_sub1 || q.sub1 || '',
      '{af_sub2}': q.af_sub2 || q.sub2 || '',
      '{af_sub3}': q.af_sub3 || q.sub3 || '',
      '{af_sub4}': q.af_sub4 || q.sub4 || '',
      '{af_sub5}': q.af_sub5 || q.sub5 || '',
      // Device identifiers
      '{advertising_id}': advertising_id || '',
      '{idfa}':           q.idfa || '',
      '{gaid}':           q.gps_adid || q.advertising_id || '',
      '{gps_adid}':       q.gps_adid || '',
      // Geo & device
      '{ip}':          ip,
      '{country}':     country || '',
      '{country_code}':country || '',
      '{device_type}': device_type || '',
      '{os}':          os || '',
      '{browser}':     browser || '',
      '{platform}':    platform || '',
      '{language}':    language || '',
      '{user_agent}':  encodeURIComponent(ua),
      // Campaign identifiers
      '{campaign_id}':    String(campaign.id),
      '{campaign_token}': campaign.campaign_token,
      '{af_c_id}':        q.af_c_id || String(campaign.id),
      '{creative_id}':    q.creative_id || q.creative || '',
      '{ad_id}':          q.ad_id || '',
    };

    // Replace every macro in one pass (case-insensitive)
    for (const [macro, value] of Object.entries(macroMap)) {
      dest = dest.split(macro).join(value);
    }

    // If click_id was not embedded in the URL, append it so postbacks can reference it
    if (!dest.includes(click_id)) {
      dest += (dest.includes('?') ? '&' : '?') + 'click_id=' + click_id;
    }

    return res.redirect(302, dest);
  } catch (err) { next(err); }
});

// GET /track/imp/:campaign_token  — Impression tracking (1x1 pixel or beacon)
router.get('/imp/:campaign_token', impLimiter, async (req, res, next) => {
  try {
    const { nanoid16: nid } = require('../utils/clickId');
    const campaign = db.prepare(
      "SELECT * FROM campaigns WHERE campaign_token = ? AND status = 'active'"
    ).get(req.params.campaign_token);

    if (campaign) {
      const q = req.query;
      const ua = req.headers['user-agent'] || '';
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const country = await lookupCountry(ip);
      const { device_type, os, platform } = parseDevice(ua);
      const impression_id = nid();

      let publisher_id = null;
      if (q.pid) {
        const pub = db.prepare('SELECT id FROM publishers WHERE pub_token = ? AND user_id = ?')
          .get(q.pid, campaign.user_id);
        if (pub) publisher_id = pub.id;
      }

      db.prepare(`INSERT INTO impressions
        (impression_id, campaign_id, publisher_id, user_id, pid, publisher_click_id,
         ip, user_agent, country, device_type, os, platform, advertising_id,
         af_sub1, af_sub2, af_sub3)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(impression_id, campaign.id, publisher_id, campaign.user_id,
             q.pid||null, q.clickid||q.publisher_click_id||null,
             ip, ua, country, device_type, os, platform,
             q.advertising_id||q.idfa||q.gps_adid||null,
             q.af_sub1||null, q.af_sub2||null, q.af_sub3||null);
    }

    // Return 1x1 transparent GIF
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' });
    res.send(pixel);
  } catch (err) { next(err); }
});

module.exports = router;
