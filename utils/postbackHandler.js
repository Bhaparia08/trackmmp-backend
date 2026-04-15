const db = require('../db/init');
const fetch = require('node-fetch');
const { macroReplace } = require('./macroReplace');

function logFraud(click, type, details, action = 'flagged') {
  try {
    db.prepare('INSERT INTO fraud_log (click_id, campaign_id, user_id, fraud_type, details, action) VALUES (?,?,?,?,?,?)')
      .run(click?.click_id || null, click?.campaign_id || null, click?.user_id || null, type, JSON.stringify(details), action);
  } catch {}
}

/**
 * Core postback attribution logic.
 * Accepts normalised params (all ad-network aliases already resolved by the caller).
 *
 * Supported params:
 *   click_id        – platform click ID (from our tracking link)
 *   clickid         – publisher's own click ID (secondary attribution key)
 *   event           – install | lead | purchase | custom  (default: install)
 *   event_name      – in-app event name / goal_value
 *   event_value     – JSON blob
 *   payout          – publisher payout
 *   revenue         – advertiser revenue
 *   currency        – ISO code (default: USD)
 *   advertising_id  – GAID or IDFA
 *   idfa            – Apple IDFA
 *   idfv            – Apple IDFV
 *   android_id      – Android device ID
 *   blocked_reason  – fraud reason from network
 *   security_token  – campaign-level security token (optional extra validation)
 */
function handlePostback(params, ip, io) {
  const {
    click_id: rawClickId,
    clickid: rawPublisherCid,
    irclickid, aff_click_id, transaction_id,
    payout = 0,
    event = 'install',
    event_name,
    advertising_id, gps_adid, idfa, idfv, android_id,
    revenue = 0, currency = 'USD',
    event_value, blocked_reason,
    security_token,
  } = params;

  const eventType   = event || 'install';
  const pubClickId  = rawPublisherCid || irclickid || aff_click_id || transaction_id || null;
  const deviceId    = advertising_id || gps_adid || idfa || null;

  // ── Attribution ────────────────────────────────────────────────────────────
  let click = null;
  if (rawClickId) click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(rawClickId);
  if (!click && pubClickId) click = db.prepare('SELECT * FROM clicks WHERE publisher_click_id = ?').get(pubClickId);

  // Validate security_token against users.postback_token (account-level token)
  if (security_token) {
    const owner = db.prepare('SELECT id FROM users WHERE postback_token = ?').get(security_token);
    if (!owner) {
      db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, event_type, payout, status, raw_params, ip, blocked_reason)
        VALUES (?,?,?,?,'rejected',?,?,?)`)
        .run(rawClickId||null, pubClickId||null, eventType, +payout, JSON.stringify(params), ip, 'invalid_security_token');
      return;
    }
  }

  if (!click) {
    db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, event_type, payout, status, raw_params, ip)
      VALUES (?,?,?,?,'rejected',?,?)`)
      .run(rawClickId||null, pubClickId||null, eventType, +payout, JSON.stringify(params), ip);
    return;
  }

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(click.campaign_id);

  // ── Lookback check ─────────────────────────────────────────────────────────
  const lookbackSecs = (campaign?.click_lookback_days || 7) * 86400;
  if (Math.floor(Date.now() / 1000) - click.created_at > lookbackSecs) {
    db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, campaign_id, user_id, event_type, payout, status, raw_params, ip)
      VALUES (?,?,?,?,?,?,'rejected',?,?)`)
      .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id, eventType, +payout, JSON.stringify(params), ip);
    return;
  }

  // ── Duplicate check ────────────────────────────────────────────────────────
  const dup = db.prepare(
    "SELECT id FROM postbacks WHERE click_id = ? AND event_type = ? AND status = 'attributed'"
  ).get(click.click_id, eventType);
  if (dup) {
    db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, campaign_id, user_id, event_type, payout, status, raw_params, ip)
      VALUES (?,?,?,?,?,?,'duplicate',?,?)`)
      .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id, eventType, +payout, JSON.stringify(params), ip);
    return;
  }

  // ── Fraud Detection ────────────────────────────────────────────────────────
  const timeDiff = Math.floor(Date.now() / 1000) - click.created_at;
  if (eventType === 'install' && timeDiff < 5) {
    logFraud(click, 'time_to_install', { seconds: timeDiff, click_id: click.click_id });
  }
  if (deviceId) {
    const dupDevice = db.prepare(`
      SELECT pb.id FROM postbacks pb
      JOIN clicks cl ON cl.click_id = pb.click_id
      WHERE pb.advertising_id = ? AND cl.campaign_id = ? AND pb.status = 'attributed' AND pb.event_type = ?
    `).get(deviceId, click.campaign_id, eventType);
    if (dupDevice) logFraud(click, 'duplicate_device', { advertising_id: deviceId });
  }
  const recentClicks = db.prepare(`
    SELECT COUNT(*) as n FROM clicks WHERE ip = ? AND campaign_id = ? AND created_at > ?
  `).get(ip, click.campaign_id, Math.floor(Date.now()/1000) - 600).n;
  if (recentClicks > 10) logFraud(click, 'click_flooding', { ip, count: recentClicks });

  // ── Goal Matching ──────────────────────────────────────────────────────────
  const goalEventName = event_name || eventType;
  let matchedGoal = db.prepare(
    "SELECT * FROM campaign_goals WHERE campaign_id = ? AND event_name = ? AND status = 'active'"
  ).get(click.campaign_id, goalEventName);
  if (!matchedGoal) {
    matchedGoal = db.prepare(
      "SELECT * FROM campaign_goals WHERE campaign_id = ? AND is_default = 1 AND status = 'active'"
    ).get(click.campaign_id);
  }

  const finalPayout  = matchedGoal ? matchedGoal.payout  : +payout  || campaign?.payout  || 0;
  const finalRevenue = matchedGoal ? matchedGoal.revenue : +revenue || 0;

  // ── Insert attributed postback ─────────────────────────────────────────────
  const pbResult = db.prepare(`INSERT INTO postbacks
    (click_id, publisher_click_id, campaign_id, user_id, event_type, event_name, event_value,
     payout, revenue, currency, advertising_id, idfa, idfv, android_id,
     install_unix_ts, status, blocked_reason, raw_params, ip, goal_id, goal_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id,
         eventType, event_name||null, event_value||null,
         finalPayout, finalRevenue, currency,
         deviceId||null, idfa||null, idfv||null, android_id||null,
         Math.floor(Date.now()/1000), 'attributed', blocked_reason||null,
         JSON.stringify(params), ip,
         matchedGoal?.id||null, matchedGoal?.name||null);

  // Update click status
  const newStatus = eventType === 'install' ? 'installed' : 'converted';
  db.prepare("UPDATE clicks SET status = ? WHERE click_id = ?").run(newStatus, click.click_id);

  // Upsert daily stats
  const statsCol = eventType === 'install' ? 'installs' : eventType === 'lead' ? 'leads' : 'conversions';
  db.prepare(`INSERT INTO daily_stats (user_id, app_id, campaign_id, publisher_id, date, ${statsCol}, revenue)
    VALUES (?,?,?,?,date('now'),1,?)
    ON CONFLICT(user_id, app_id, campaign_id, publisher_id, date)
    DO UPDATE SET ${statsCol} = ${statsCol} + 1, revenue = revenue + excluded.revenue`)
    .run(click.user_id, campaign?.app_id||0, click.campaign_id, click.publisher_id||0, finalRevenue);

  // ── Fire outbound postbacks ────────────────────────────────────────────────
  const app = campaign?.app_id ? db.prepare('SELECT * FROM apps WHERE id = ?').get(campaign.app_id) : null;
  const macroData = {
    ...params,
    click_id: click.click_id,
    publisher_click_id: click.publisher_click_id,
    campaign_name: campaign?.name, campaign_id: campaign?.id,
    af_c_id: click.af_c_id, af_siteid: click.af_siteid,
    af_sub1: click.af_sub1, af_sub2: click.af_sub2, af_sub3: click.af_sub3,
    af_sub4: click.af_sub4, af_sub5: click.af_sub5,
    sub6: click.sub6, sub7: click.sub7, sub8: click.sub8, sub9: click.sub9, sub10: click.sub10,
    creative_id: click.creative_id, ad_id: click.ad_id,
    country: click.country, language: click.language,
    platform: click.platform, bundle_id: app?.bundle_id, app_name: app?.name,
    is_retargeting: campaign?.is_retargeting,
    install_unix_ts: Math.floor(Date.now()/1000),
    advertising_id: deviceId,
    payout: finalPayout, revenue: finalRevenue,
    goal_id: matchedGoal?.id, goal_name: matchedGoal?.name,
    ip,
  };

  if (matchedGoal?.postback_url) fetch(macroReplace(matchedGoal.postback_url, macroData)).catch(() => {});
  if (campaign?.postback_url) fetch(macroReplace(campaign.postback_url, macroData)).catch(() => {});

  // ── Socket emit ────────────────────────────────────────────────────────────
  if (io) {
    const pbRecord = db.prepare('SELECT * FROM postbacks WHERE id = ?').get(pbResult.lastInsertRowid);
    io.to(click.user_id.toString()).emit('postback', { ...pbRecord, campaign_name: campaign?.name || 'Unknown' });
  }
}

module.exports = { handlePostback };
