const express = require('express');
const db = require('../db/init');
const fetch = require('node-fetch');
const { macroReplace } = require('../utils/macroReplace');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const pbLimiter = rateLimit({ windowMs: 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false });

function handlePostback(params, ip, io) {
  const {
    click_id: rawClickId, clickid: rawPublisherCid,
    payout = 0, event = 'install', event_name,
    advertising_id, idfa, idfv, android_id,
    revenue = 0, currency = 'USD',
    event_value, blocked_reason
  } = params;

  const eventType = event || 'install';

  // Attribution: try click_id first, then publisher_click_id (AF-style)
  let click = null;
  if (rawClickId) click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(rawClickId);
  if (!click && rawPublisherCid) click = db.prepare('SELECT * FROM clicks WHERE publisher_click_id = ?').get(rawPublisherCid);

  if (!click) {
    db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, event_type, payout, status, raw_params, ip)
      VALUES (?,?,?,?,'rejected',?,?)`)
      .run(rawClickId||null, rawPublisherCid||null, eventType, +payout, JSON.stringify(params), ip);
    return;
  }

  // Check lookback window
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(click.campaign_id);
  const lookbackSecs = (campaign?.click_lookback_days || 7) * 86400;
  if (Math.floor(Date.now() / 1000) - click.created_at > lookbackSecs) {
    db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, campaign_id, user_id, event_type, payout, status, raw_params, ip)
      VALUES (?,?,?,?,?,?,'rejected',?,?)`)
      .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id, eventType, +payout, JSON.stringify(params), ip);
    return;
  }

  // Duplicate check
  const dup = db.prepare(
    "SELECT id FROM postbacks WHERE click_id = ? AND event_type = ? AND status = 'attributed'"
  ).get(click.click_id, eventType);

  if (dup) {
    db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, campaign_id, user_id, event_type, payout, status, raw_params, ip)
      VALUES (?,?,?,?,?,?,'duplicate',?,?)`)
      .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id, eventType, +payout, JSON.stringify(params), ip);
    return;
  }

  // Insert attributed postback
  const pbResult = db.prepare(`INSERT INTO postbacks
    (click_id, publisher_click_id, campaign_id, user_id, event_type, event_name, event_value,
     payout, revenue, currency, advertising_id, idfa, idfv, android_id,
     install_unix_ts, status, blocked_reason, raw_params, ip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id,
         eventType, event_name||null, event_value||null,
         +payout, +revenue, currency,
         advertising_id||null, idfa||null, idfv||null, android_id||null,
         Math.floor(Date.now()/1000), 'attributed', blocked_reason||null,
         JSON.stringify(params), ip);

  // Update click status
  const newStatus = eventType === 'install' ? 'installed' : 'converted';
  db.prepare("UPDATE clicks SET status = ? WHERE click_id = ?").run(newStatus, click.click_id);

  // Upsert daily stats
  const statsCol = eventType === 'install' ? 'installs' : eventType === 'lead' ? 'leads' : 'conversions';
  db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, ${statsCol}, revenue)
    VALUES (?,?,?,?,date('now'),1,?)
    ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
    DO UPDATE SET ${statsCol} = ${statsCol} + 1, revenue = revenue + excluded.revenue`)
    .run(click.user_id, campaign?.app_id||0, click.campaign_id, click.publisher_id||0, +revenue);

  // Fire outbound postback (non-blocking)
  if (campaign?.postback_url) {
    const app = campaign.app_id ? db.prepare('SELECT * FROM apps WHERE id = ?').get(campaign.app_id) : null;
    const outUrl = macroReplace(campaign.postback_url, {
      ...params,
      click_id: click.click_id,
      publisher_click_id: click.publisher_click_id,
      campaign_name: campaign.name,
      af_c_id: click.af_c_id,
      af_siteid: click.af_siteid,
      af_sub1: click.af_sub1, af_sub2: click.af_sub2, af_sub3: click.af_sub3,
      af_sub4: click.af_sub4, af_sub5: click.af_sub5,
      country: click.country, language: click.language,
      platform: click.platform, bundle_id: app?.bundle_id,
      app_name: app?.name, is_retargeting: campaign.is_retargeting,
      install_unix_ts: Math.floor(Date.now()/1000),
    });
    fetch(outUrl).catch(() => {}); // fire-and-forget
  }

  // Emit real-time socket event to the campaign owner
  if (io) {
    const pbRecord = db.prepare('SELECT * FROM postbacks WHERE id = ?').get(pbResult.lastInsertRowid);
    io.to(click.user_id.toString()).emit('postback', {
      ...pbRecord,
      campaign_name: campaign?.name || 'Unknown',
    });
  }
}

router.get('/', pbLimiter, (req, res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    handlePostback(req.query, ip, req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

router.post('/', pbLimiter, express.json(), (req, res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    handlePostback({ ...req.query, ...req.body }, ip, req.app.get('io'));
    res.status(200).send('OK');
  } catch (err) { next(err); }
});

module.exports = router;
