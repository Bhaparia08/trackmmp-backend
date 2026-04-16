const db = require('../db/init');
const fetch = require('node-fetch');
const { macroReplace } = require('./macroReplace');
const { nanoid16 } = require('./clickId');

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
 *   security_token  – account-level postback token (optional extra validation)
 */
function handlePostback(params, ip, io) {
  const {
    click_id: rawClickId,
    clickid: rawPublisherCid,
    irclickid, aff_click_id, transaction_id,
    payout = 0,
    event = 'install',
    event_name,
    advertising_id, gps_adid, gaid, idfa, idfv, android_id,
    revenue = 0, currency = 'USD',
    event_value, blocked_reason,
    security_token,
  } = params;

  const eventType = event || 'install';
  const deviceId  = advertising_id || gps_adid || gaid || idfa || null;

  // transaction_id is our primary click ID (advertiser passes it back after receiving
  // it via {click_id} macro in the destination URL). Treat it the same as click_id.
  const primaryClickId = rawClickId || transaction_id || null;
  const pubClickId     = rawPublisherCid || irclickid || aff_click_id || null;

  // ── Attribution ────────────────────────────────────────────────────────────
  // 1. Try our platform click_id (or transaction_id which is the same thing)
  // 2. Fall back to publisher's own click_id (secondary key)
  let click = null;
  let isViewThrough = false;

  if (primaryClickId) click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(primaryClickId);
  if (!click && pubClickId) click = db.prepare('SELECT * FROM clicks WHERE publisher_click_id = ?').get(pubClickId);

  // Validate security_token against users.postback_token (account-level token)
  let tokenOwner = null;
  if (security_token) {
    tokenOwner = db.prepare('SELECT id FROM users WHERE postback_token = ?').get(security_token);
    if (!tokenOwner) {
      db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, event_type, payout, status, raw_params, ip, blocked_reason)
        VALUES (?,?,?,?,'rejected',?,?,?)`)
        .run(rawClickId||null, pubClickId||null, eventType, +payout, JSON.stringify(params), ip, 'invalid_security_token');
      return;
    }
  }

  // ── View-Through Attribution (VTA) ─────────────────────────────────────────
  // 3. No click found but device ID present → look for a prior impression
  if (!click && deviceId) {
    let impression = null;

    if (tokenOwner) {
      // Scoped to this advertiser's campaigns (most accurate)
      impression = db.prepare(`
        SELECT i.* FROM impressions i
        JOIN campaigns c ON c.id = i.campaign_id
        WHERE i.advertising_id = ?
          AND i.user_id = ?
          AND i.created_at > (unixepoch() - COALESCE(c.impression_lookback_days, 1) * 86400)
        ORDER BY i.created_at DESC LIMIT 1
      `).get(deviceId, tokenOwner.id);
    } else {
      // No security token — search all campaigns, use default 1-day lookback
      impression = db.prepare(`
        SELECT i.* FROM impressions i
        JOIN campaigns c ON c.id = i.campaign_id
        WHERE i.advertising_id = ?
          AND i.created_at > (unixepoch() - COALESCE(c.impression_lookback_days, 1) * 86400)
        ORDER BY i.created_at DESC LIMIT 1
      `).get(deviceId);
    }

    if (impression) {
      // VTA dedup: reject if this device already has an attributed conversion
      // for this campaign+event (prevents double-attribution on repeated postbacks)
      const vtaDup = db.prepare(`
        SELECT pb.id FROM postbacks pb
        JOIN clicks cl ON cl.click_id = pb.click_id
        WHERE pb.advertising_id = ? AND cl.campaign_id = ?
          AND pb.event_type = ? AND pb.status = 'attributed'
        LIMIT 1
      `).get(deviceId, impression.campaign_id, eventType);

      if (vtaDup) {
        db.prepare(`INSERT INTO postbacks (click_id, publisher_click_id, campaign_id, user_id, event_type, payout, status, raw_params, ip)
          VALUES (?,?,?,?,?,?,'duplicate',?,?)`)
          .run(rawClickId||null, pubClickId||null, impression.campaign_id, impression.user_id,
               eventType, +payout, JSON.stringify(params), ip);
        return;
      }

      // Create a synthetic click from the impression so the rest of the
      // attribution pipeline runs identically for VTA and click-based flows
      const syntheticClickId = nanoid16();
      db.prepare(`INSERT INTO clicks
        (click_id, campaign_id, publisher_id, user_id,
         pid, publisher_click_id,
         ip, user_agent, country, device_type, os, platform,
         advertising_id, af_sub1, af_sub2, af_sub3,
         impression_id, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'clicked',unixepoch())`)
        .run(
          syntheticClickId,
          impression.campaign_id, impression.publisher_id, impression.user_id,
          impression.pid||null, impression.publisher_click_id||null,
          ip, impression.user_agent||null, impression.country||null,
          impression.device_type||null, impression.os||null, impression.platform||null,
          deviceId,
          impression.af_sub1||null, impression.af_sub2||null, impression.af_sub3||null,
          impression.impression_id
        );
      click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(syntheticClickId);
      isViewThrough = true;
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
  // Skip time-to-install check for VTA: synthetic clicks are created at attribution
  // time so timeDiff is always ~0, which would be a guaranteed false positive.
  if (!isViewThrough && eventType === 'install' && timeDiff < 5) {
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
     install_unix_ts, status, blocked_reason, raw_params, ip, goal_id, goal_name, is_view_through)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(click.click_id, click.publisher_click_id, click.campaign_id, click.user_id,
         eventType, event_name||null, event_value||null,
         finalPayout, finalRevenue, currency,
         deviceId||null, idfa||null, idfv||null, android_id||null,
         Math.floor(Date.now()/1000), 'attributed', blocked_reason||null,
         JSON.stringify(params), ip,
         matchedGoal?.id||null, matchedGoal?.name||null, isViewThrough ? 1 : 0);

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

  // ── Fire outbound postbacks ───────────────────────────────────────────────
  if (matchedGoal?.postback_url) fetch(macroReplace(matchedGoal.postback_url, macroData)).catch(() => {});
  if (campaign?.postback_url)    fetch(macroReplace(campaign.postback_url, macroData)).catch(() => {});

  // ── Fire publisher global postback (if configured) ────────────────────────
  if (click.publisher_id) {
    const pub = db.prepare('SELECT global_postback_url FROM publishers WHERE id = ?').get(click.publisher_id);
    if (pub?.global_postback_url) {
      fetch(macroReplace(pub.global_postback_url, macroData)).catch(() => {});
    }
  }

  // ── Socket emit ────────────────────────────────────────────────────────────
  if (io) {
    const pbRecord = db.prepare('SELECT * FROM postbacks WHERE id = ?').get(pbResult.lastInsertRowid);
    io.to(click.user_id.toString()).emit('postback', { ...pbRecord, campaign_name: campaign?.name || 'Unknown' });
  }
}

module.exports = { handlePostback };
