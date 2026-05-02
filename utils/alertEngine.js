/**
 * Alert Engine
 * Checks all active alert rules every 2 minutes.
 * When a rule fires, it creates an alert_notification and emits a socket event.
 *
 * Alert types:
 *   cap_hit         — campaign daily cap reached / approaching (threshold = %)
 *   revenue_spike   — revenue exceeds threshold in window
 *   fraud_spike     — fraud log entries exceed threshold in window
 *   click_spike     — clicks per minute exceed threshold
 *   install_drop    — install rate drops below threshold % vs previous window
 */

const db = require('../db/init');

function createNotification(userId, ruleId, alertType, title, message, data = {}) {
  try {
    db.prepare(`
      INSERT INTO alert_notifications (user_id, rule_id, alert_type, title, message, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, ruleId ?? null, alertType, title, message, JSON.stringify(data));
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
  } catch (e) {
    console.error('[AlertEngine] createNotification error:', e.message);
    return null;
  }
}

function shouldFire(rule) {
  if (!rule.last_fired_at) return true;
  // Don't fire the same rule more than once per window
  const cooldown = (rule.window_minutes || 60) * 60;
  return (Math.floor(Date.now() / 1000) - rule.last_fired_at) >= cooldown;
}

function markFired(ruleId) {
  db.prepare('UPDATE alert_rules SET last_fired_at = unixepoch() WHERE id = ?').run(ruleId);
}

function runAlertChecks(io) {
  const rules = db.prepare(
    "SELECT * FROM alert_rules WHERE status = 'active'"
  ).all();

  for (const rule of rules) {
    if (!shouldFire(rule)) continue;

    try {
      let fired = false;
      const windowStart = Math.floor(Date.now() / 1000) - (rule.window_minutes || 60) * 60;

      switch (rule.alert_type) {

        case 'cap_hit': {
          // Alert when campaign daily installs >= threshold% of daily cap
          const campFilter = rule.campaign_id ? 'AND c.id = ?' : '';
          const campParams = rule.campaign_id ? [rule.campaign_id] : [];
          const scopeFilter = rule.user_id ? ' AND c.user_id = ?' : '';
          const scopeParams = rule.user_id ? [rule.user_id] : [];

          const caps = db.prepare(`
            SELECT c.id, c.name, c.cap_daily,
              COALESCE((SELECT SUM(installs) FROM daily_stats WHERE campaign_id=c.id AND date=date('now')),0) AS used
            FROM campaigns c
            WHERE c.cap_daily > 0 AND c.status='active' ${campFilter}${scopeFilter}
          `).all(...campParams, ...scopeParams);

          for (const cap of caps) {
            const pct = cap.cap_daily > 0 ? (cap.used / cap.cap_daily) * 100 : 0;
            if (pct >= rule.threshold) {
              const notifId = createNotification(
                rule.user_id, rule.id, 'cap_hit',
                `Cap Alert: ${cap.name}`,
                `Campaign "${cap.name}" has used ${pct.toFixed(1)}% of its daily cap (${cap.used}/${cap.cap_daily} installs)`,
                { campaign_id: cap.id, cap_pct: pct.toFixed(1), used: cap.used, cap_daily: cap.cap_daily }
              );
              if (io && notifId) io.to(rule.user_id.toString()).emit('alert', { type: 'cap_hit', campaign: cap.name, pct: pct.toFixed(1) });
              fired = true;
            }
          }
          break;
        }

        case 'revenue_spike': {
          const campClause = rule.campaign_id ? ' AND pb.campaign_id = ?' : '';
          const campP      = rule.campaign_id ? [rule.campaign_id] : [];
          const scopeClause = rule.user_id ? ' AND pb.user_id = ?' : '';
          const scopeP      = rule.user_id ? [rule.user_id] : [];

          const rev = db.prepare(`
            SELECT COALESCE(SUM(revenue),0) AS total
            FROM postbacks pb
            WHERE pb.status='attributed' AND pb.created_at >= ?${campClause}${scopeClause}
          `).get(windowStart, ...campP, ...scopeP);

          if (rev.total >= rule.threshold) {
            createNotification(
              rule.user_id, rule.id, 'revenue_spike',
              `Revenue Alert: $${rev.total.toFixed(2)}`,
              `Revenue reached $${rev.total.toFixed(2)} in the last ${rule.window_minutes} minutes`,
              { revenue: rev.total, window_minutes: rule.window_minutes }
            );
            if (io) io.to(rule.user_id.toString()).emit('alert', { type: 'revenue_spike', revenue: rev.total });
            fired = true;
          }
          break;
        }

        case 'fraud_spike': {
          const scopeClause = rule.user_id ? ' AND user_id = ?' : '';
          const scopeP      = rule.user_id ? [rule.user_id] : [];
          const campClause  = rule.campaign_id ? ' AND campaign_id = ?' : '';
          const campP       = rule.campaign_id ? [rule.campaign_id] : [];

          const fraudCount = db.prepare(`
            SELECT COUNT(*) AS n FROM fraud_log
            WHERE created_at >= ?${campClause}${scopeClause}
          `).get(windowStart, ...campP, ...scopeP);

          if (fraudCount.n >= rule.threshold) {
            createNotification(
              rule.user_id, rule.id, 'fraud_spike',
              `Fraud Alert: ${fraudCount.n} events`,
              `${fraudCount.n} fraud events detected in the last ${rule.window_minutes} minutes`,
              { count: fraudCount.n, window_minutes: rule.window_minutes }
            );
            if (io) io.to(rule.user_id.toString()).emit('alert', { type: 'fraud_spike', count: fraudCount.n });
            fired = true;
          }
          break;
        }

        case 'click_spike': {
          const campClause = rule.campaign_id ? ' AND campaign_id = ?' : '';
          const campP      = rule.campaign_id ? [rule.campaign_id] : [];
          const scopeClause = rule.user_id ? ' AND user_id = ?' : '';
          const scopeP      = rule.user_id ? [rule.user_id] : [];

          const clicks = db.prepare(`
            SELECT COUNT(*) AS n FROM clicks
            WHERE created_at >= ?${campClause}${scopeClause}
          `).get(windowStart, ...campP, ...scopeP);

          if (clicks.n >= rule.threshold) {
            createNotification(
              rule.user_id, rule.id, 'click_spike',
              `Click Spike: ${clicks.n} clicks`,
              `${clicks.n} clicks received in the last ${rule.window_minutes} minutes`,
              { clicks: clicks.n, window_minutes: rule.window_minutes }
            );
            if (io) io.to(rule.user_id.toString()).emit('alert', { type: 'click_spike', clicks: clicks.n });
            fired = true;
          }
          break;
        }

        case 'install_drop': {
          // Compare install rate in last window vs previous window
          const prevStart = windowStart - (rule.window_minutes || 60) * 60;
          const campClause = rule.campaign_id ? ' AND campaign_id = ?' : '';
          const campP      = rule.campaign_id ? [rule.campaign_id] : [];
          const scopeClause = rule.user_id ? ' AND user_id = ?' : '';
          const scopeP      = rule.user_id ? [rule.user_id] : [];

          const current = db.prepare(`
            SELECT COUNT(*) AS n FROM clicks
            WHERE created_at >= ? AND status = 'installed'${campClause}${scopeClause}
          `).get(windowStart, ...campP, ...scopeP);

          const previous = db.prepare(`
            SELECT COUNT(*) AS n FROM clicks
            WHERE created_at >= ? AND created_at < ? AND status = 'installed'${campClause}${scopeClause}
          `).get(prevStart, windowStart, ...campP, ...scopeP);

          if (previous.n > 0) {
            const dropPct = ((previous.n - current.n) / previous.n) * 100;
            if (dropPct >= rule.threshold) {
              createNotification(
                rule.user_id, rule.id, 'install_drop',
                `Install Drop: -${dropPct.toFixed(1)}%`,
                `Installs dropped by ${dropPct.toFixed(1)}% (${current.n} vs ${previous.n} in prior window)`,
                { current: current.n, previous: previous.n, drop_pct: dropPct.toFixed(1) }
              );
              if (io) io.to(rule.user_id.toString()).emit('alert', { type: 'install_drop', drop_pct: dropPct.toFixed(1) });
              fired = true;
            }
          }
          break;
        }
      }

      if (fired) markFired(rule.id);

    } catch (e) {
      console.error(`[AlertEngine] rule #${rule.id} error:`, e.message);
    }
  }
}

module.exports = { runAlertChecks, createNotification };
