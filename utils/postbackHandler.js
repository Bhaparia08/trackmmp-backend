const db = require('../db/init');
const fetch = require('node-fetch');
const { macroReplace } = require('./macroReplace');
const { nanoid16 } = require('./clickId');
const { enqueueWebhook } = require('./webhookRetry');

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
    // Platform-specific echo params: the advertiser's platform sends our click_id
    // back under their own param name (e.g. Admitad→subid, HasOffers alt→aff_sub, Rakuten→u1)
    subid, aff_sub, u1,
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

  // primaryClickId: our platform click ID echoed back by the advertiser platform.
  // Checked in order of specificity — most unambiguous param names first.
  // transaction_id = TUNE/HasOffers/Trackier standard
  // subid          = Admitad standard
  // aff_sub        = HasOffers sub1 used as click ID by some advertisers
  // u1             = Rakuten LinkShare
  const primaryClickId = rawClickId || transaction_id || subid || aff_sub || u1 || null;
  const pubClickId     = rawPublisherCid || irclickid || aff_click_id || null;

  // ── Attribution ────────────────────────────────────────────────────────────
  // 1. Primary: click_id / transaction_id / subid / aff_sub / u1
  // 2. clickid-as-primary: Affise fires postback with clickid=OUR_CLICK_ID —
  //    try it as a click_id lookup before falling back to publisher_click_id
  // 3. Secondary: publisher's own click_id (publisher_click_id column)
  let click = null;
  let isViewThrough = false;

  if (primaryClickId) click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(primaryClickId);
  // Affise (and some Adjust integrations) echo our click_id back in the 'clickid' param.
  // Try it as a primary click_id lookup before using it as publisher secondary.
  if (!click && rawPublisherCid) click = db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(rawPublisherCid);
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

  // ── Re-engagement check (retargeting campaigns only) ──────────────────────
  let isReEngagement = false;
  if (campaign?.is_retargeting && deviceId && eventType === 'install') {
    const windowSecs = (campaign.re_engagement_window_days || 30) * 86400;
    const priorInstall = db.prepare(`
      SELECT pb.id FROM postbacks pb
      JOIN clicks cl ON cl.click_id = pb.click_id
      WHERE pb.advertising_id = ? AND cl.campaign_id = ?
        AND pb.event_type = 'install' AND pb.status = 'attributed'
        AND pb.created_at > (unixepoch() - ?)
      LIMIT 1
    `).get(deviceId, click.campaign_id, windowSecs);
    if (priorInstall) isReEngagement = true;
  }
  const finalEventType = isReEngagement ? 're_engagement' : eventType;

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

  // ── Enhanced ML-style Fraud Checks ────────────────────────────────────────

  // 1. Publisher install rate anomaly: if publisher CVR is far above campaign average
  //    (>3x average) flag for review. This catches incentivized/junk traffic.
  if (click.publisher_id && eventType === 'install') {
    try {
      const window24h = Math.floor(Date.now() / 1000) - 86400;
      const pubStats = db.prepare(`
        SELECT COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
               COUNT(DISTINCT cl.id) AS clicks
        FROM clicks cl
        WHERE cl.publisher_id = ? AND cl.campaign_id = ? AND cl.created_at > ?
      `).get(click.publisher_id, click.campaign_id, window24h);

      const campStats = db.prepare(`
        SELECT COUNT(DISTINCT CASE WHEN cl.status IN ('installed','converted') THEN cl.id END) AS installs,
               COUNT(DISTINCT cl.id) AS clicks
        FROM clicks cl
        WHERE cl.campaign_id = ? AND cl.created_at > ?
      `).get(click.campaign_id, window24h);

      const pubCVR  = pubStats.clicks  > 10 ? pubStats.installs  / pubStats.clicks  : null;
      const campCVR = campStats.clicks > 20 ? campStats.installs / campStats.clicks : null;

      if (pubCVR !== null && campCVR !== null && campCVR > 0 && pubCVR > campCVR * 3) {
        logFraud(click, 'install_rate_anomaly', {
          publisher_id: click.publisher_id,
          pub_cvr: +(pubCVR * 100).toFixed(2),
          camp_cvr: +(campCVR * 100).toFixed(2),
          ratio: +(pubCVR / campCVR).toFixed(2)
        });
      }
    } catch {}
  }

  // 2. Device fingerprint registry — detect same device converting across many IPs
  //    (indicates emulator farm / spoofed device IDs)
  if (deviceId && eventType === 'install') {
    try {
      const existing = db.prepare('SELECT * FROM fraud_device_fingerprints WHERE fingerprint = ?').get(deviceId);
      if (existing) {
        const newHit = existing.hit_count + 1;
        db.prepare(`UPDATE fraud_device_fingerprints SET hit_count=?, last_seen=unixepoch(), ip=? WHERE id=?`)
          .run(newHit, ip, existing.id);
        // If the same advertising_id has been seen 3+ times across different campaigns/IPs, flag it
        if (newHit >= 3) {
          logFraud(click, 'device_farm', {
            advertising_id: deviceId, hit_count: newHit, previous_ip: existing.ip, current_ip: ip
          });
        }
      } else {
        db.prepare(`INSERT INTO fraud_device_fingerprints (fingerprint, ip, user_agent, campaign_id) VALUES (?,?,?,?)`)
          .run(deviceId, ip, params.user_agent || null, click.campaign_id);
      }
    } catch {}
  }

  // 3. High-frequency installs from same sub-publisher (af_sub1) in 1 hour
  if (click.af_sub1 && eventType === 'install') {
    try {
      const subInstalls = db.prepare(`
        SELECT COUNT(*) AS n FROM clicks cl
        JOIN postbacks pb ON pb.click_id = cl.click_id
        WHERE cl.af_sub1 = ? AND cl.campaign_id = ? AND cl.created_at > ? AND pb.status = 'attributed'
      `).get(click.af_sub1, click.campaign_id, Math.floor(Date.now()/1000) - 3600).n;
      if (subInstalls > 50) {
        logFraud(click, 'sub_publisher_spike', { af_sub1: click.af_sub1, installs_per_hour: subInstalls });
      }
    } catch {}
  }

  // 4. Zero-day install spike: more than 200 installs from same campaign in last 5 minutes
  //    (indicates a bot burst — legitimate traffic doesn't do this)
  if (eventType === 'install') {
    try {
      const recentInstalls = db.prepare(`
        SELECT COUNT(*) AS n FROM postbacks
        WHERE campaign_id = ? AND event_type = 'install' AND status = 'attributed' AND created_at > ?
      `).get(click.campaign_id, Math.floor(Date.now()/1000) - 300).n;
      if (recentInstalls > 200) {
        logFraud(click, 'install_burst', { campaign_id: click.campaign_id, installs_5min: recentInstalls });
      }
    } catch {}
  }

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
         finalEventType, event_name||null, event_value||null,
         finalPayout, finalRevenue, currency,
         deviceId||null, idfa||null, idfv||null, android_id||null,
         Math.floor(Date.now()/1000), 'attributed', blocked_reason||null,
         JSON.stringify(params), ip,
         matchedGoal?.id||null, matchedGoal?.name||null, isViewThrough ? 1 : 0);

  // Update click status
  const newStatus = finalEventType === 'install' ? 'installed' : 'converted';
  db.prepare("UPDATE clicks SET status = ? WHERE click_id = ?").run(newStatus, click.click_id);

  // ── Multi-touch: record this click as a touch point ───────────────────────
  if (deviceId && eventType === 'install') {
    try {
      // Count prior touch points for this device+campaign to determine order
      const priorCount = db.prepare(
        'SELECT COUNT(*) AS n FROM touch_points WHERE device_id = ? AND campaign_id = ?'
      ).get(deviceId, click.campaign_id).n;
      db.prepare(`INSERT INTO touch_points (device_id, campaign_id, publisher_id, click_id, touch_type, touch_order)
        VALUES (?,?,?,?,?,?)`)
        .run(deviceId, click.campaign_id, click.publisher_id||null, click.click_id, 'click', priorCount + 1);

      // For linear attribution model: distribute credit equally among all touchpoints
      if (campaign?.attribution_model === 'linear') {
        const allTouches = db.prepare(
          'SELECT publisher_id FROM touch_points WHERE device_id = ? AND campaign_id = ?'
        ).all(deviceId, click.campaign_id);
        if (allTouches.length > 1) {
          const share = +(finalRevenue / allTouches.length).toFixed(4);
          // Log linear distribution in fraud_log for auditability (non-blocking)
          try {
            db.prepare('INSERT INTO fraud_log (click_id, campaign_id, user_id, fraud_type, details, action) VALUES (?,?,?,?,?,?)')
              .run(click.click_id, click.campaign_id, click.user_id, 'linear_attribution',
                JSON.stringify({ touches: allTouches.length, share_per_touch: share, total: finalRevenue }), 'info');
          } catch {}
        }
      }
    } catch {}
  }

  // Upsert daily stats
  const statsCol = finalEventType === 'install' ? 'installs'
                 : finalEventType === 're_engagement' ? 're_engagements'
                 : finalEventType === 'lead' ? 'leads' : 'conversions';
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

  // ── Fire outbound postbacks (via reliable retry queue) ───────────────────
  if (matchedGoal?.postback_url) {
    enqueueWebhook(macroReplace(matchedGoal.postback_url, macroData), 'goal', pbResult.lastInsertRowid);
  }
  if (campaign?.postback_url) {
    enqueueWebhook(macroReplace(campaign.postback_url, macroData), 'postback', pbResult.lastInsertRowid);
  }
  if (isReEngagement && campaign?.re_engagement_postback_url) {
    enqueueWebhook(macroReplace(campaign.re_engagement_postback_url, macroData), 're_engagement', pbResult.lastInsertRowid);
  }

  // ── Fire publisher global postback (if configured) ────────────────────────
  if (click.publisher_id) {
    const pub = db.prepare('SELECT global_postback_url FROM publishers WHERE id = ?').get(click.publisher_id);
    if (pub?.global_postback_url) {
      enqueueWebhook(macroReplace(pub.global_postback_url, macroData), 'publisher', pbResult.lastInsertRowid);
    }
  }

  // ── Socket emit ────────────────────────────────────────────────────────────
  if (io) {
    const pbRecord = db.prepare('SELECT * FROM postbacks WHERE id = ?').get(pbResult.lastInsertRowid);
    io.to(click.user_id.toString()).emit('postback', { ...pbRecord, campaign_name: campaign?.name || 'Unknown' });
  }
}

module.exports = { handlePostback };
