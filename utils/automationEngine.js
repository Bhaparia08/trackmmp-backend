/**
 * Automation Rules Engine
 * Runs on a setInterval from server.js — evaluates all active rules every 60 seconds.
 * Completely self-contained — no existing routes or logic is touched.
 */
const db = require('../db/init');

function tryParse(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function logTrigger(ruleId, triggerData, actionTaken) {
  db.prepare(
    'INSERT INTO automation_rule_logs (rule_id, trigger_data, action_taken) VALUES (?, ?, ?)'
  ).run(ruleId, JSON.stringify(triggerData), actionTaken);
  db.prepare('UPDATE automation_rules SET last_triggered_at = unixepoch() WHERE id = ?').run(ruleId);
}

// ── Trigger evaluators ─────────────────────────────────────────────────────

function evalCapThreshold(rule, cfg) {
  // Fires when a campaign's cap usage % crosses a threshold
  // trigger_config: { campaign_id, cap_type: 'daily'|'total', threshold_pct: 90 }
  if (!cfg.campaign_id) return null;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(cfg.campaign_id);
  if (!campaign) return null;

  const cap = cfg.cap_type === 'total' ? campaign.cap_total : campaign.cap_daily;
  if (!cap || cap === 0) return null; // unlimited cap, never fires

  let used;
  if (cfg.cap_type === 'total') {
    used = db.prepare(
      "SELECT COUNT(*) AS cnt FROM clicks WHERE campaign_id = ? AND status = 'installed'"
    ).get(cfg.campaign_id)?.cnt || 0;
  } else {
    used = db.prepare(
      "SELECT COUNT(*) AS cnt FROM clicks WHERE campaign_id = ? AND status = 'installed' AND date(created_at, 'unixepoch') = date('now')"
    ).get(cfg.campaign_id)?.cnt || 0;
  }

  const usedPct = (used / cap) * 100;
  const threshold = cfg.threshold_pct || 90;
  if (usedPct >= threshold) {
    return { campaign_id: cfg.campaign_id, campaign_name: campaign.name, cap, used, usedPct: Math.round(usedPct), threshold };
  }
  return null;
}

function evalFraudRate(rule, cfg) {
  // Fires when rejected click % exceeds threshold in a time window
  // trigger_config: { campaign_id, threshold_pct: 20, window_hours: 24 }
  if (!cfg.campaign_id) return null;
  const windowSecs = (cfg.window_hours || 24) * 3600;
  const since = Math.floor(Date.now() / 1000) - windowSecs;

  const total = db.prepare(
    'SELECT COUNT(*) AS cnt FROM clicks WHERE campaign_id = ? AND created_at >= ?'
  ).get(cfg.campaign_id, since)?.cnt || 0;
  if (total < 10) return null; // not enough data

  const rejected = db.prepare(
    "SELECT COUNT(*) AS cnt FROM clicks WHERE campaign_id = ? AND status = 'rejected' AND created_at >= ?"
  ).get(cfg.campaign_id, since)?.cnt || 0;

  const fraudPct = (rejected / total) * 100;
  const threshold = cfg.threshold_pct || 20;
  if (fraudPct >= threshold) {
    return { campaign_id: cfg.campaign_id, total, rejected, fraudPct: Math.round(fraudPct), threshold };
  }
  return null;
}

function evalConversionRateDrop(rule, cfg) {
  // Fires when CR drops below threshold vs. prior period
  // trigger_config: { campaign_id, min_cr_pct: 5, window_hours: 24 }
  if (!cfg.campaign_id) return null;
  const windowSecs = (cfg.window_hours || 24) * 3600;
  const since = Math.floor(Date.now() / 1000) - windowSecs;

  const clicks = db.prepare(
    'SELECT COUNT(*) AS cnt FROM clicks WHERE campaign_id = ? AND created_at >= ?'
  ).get(cfg.campaign_id, since)?.cnt || 0;
  if (clicks < 20) return null;

  const installs = db.prepare(
    "SELECT COUNT(*) AS cnt FROM clicks WHERE campaign_id = ? AND status = 'installed' AND created_at >= ?"
  ).get(cfg.campaign_id, since)?.cnt || 0;

  const crPct = (installs / clicks) * 100;
  const threshold = cfg.min_cr_pct || 5;
  if (crPct < threshold) {
    return { campaign_id: cfg.campaign_id, clicks, installs, crPct: Math.round(crPct * 100) / 100, threshold };
  }
  return null;
}

const EVALUATORS = {
  cap_threshold:        evalCapThreshold,
  fraud_rate:           evalFraudRate,
  conversion_rate_drop: evalConversionRateDrop,
};

// ── Action executors ───────────────────────────────────────────────────────

function execPauseCampaign(cfg, triggerData) {
  const campaignId = cfg.campaign_id || triggerData.campaign_id;
  if (!campaignId) return 'no campaign_id';
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = unixepoch() WHERE id = ?").run(campaignId);
  return `Paused campaign #${campaignId}`;
}

function execPausePublisher(cfg, triggerData) {
  const publisherId = cfg.publisher_id;
  if (!publisherId) return 'no publisher_id';
  db.prepare("UPDATE publishers SET status = 'paused' WHERE id = ?").run(publisherId);
  return `Paused publisher #${publisherId}`;
}

function execSendAlert(cfg, triggerData) {
  // Placeholder — extend with actual email/slack webhook sending as needed
  // For now just logs the alert details
  console.log(`[AutomationAlert] Rule triggered:`, JSON.stringify(triggerData));
  return `Alert logged: ${JSON.stringify(triggerData).slice(0, 200)}`;
}

const EXECUTORS = {
  pause_campaign:  execPauseCampaign,
  pause_publisher: execPausePublisher,
  send_alert:      execSendAlert,
};

// ── Main runner ─────────────────────────────────────────────────────────────

function runAutomationRules() {
  const rules = db.prepare("SELECT * FROM automation_rules WHERE status = 'active'").all();

  for (const rule of rules) {
    try {
      const triggerCfg = tryParse(rule.trigger_config);
      const actionCfg  = tryParse(rule.action_config);

      const evaluator = EVALUATORS[rule.trigger_type];
      if (!evaluator) continue;

      const triggerData = evaluator(rule, triggerCfg);
      if (!triggerData) continue; // condition not met

      const executor = EXECUTORS[rule.action_type];
      const actionTaken = executor ? executor(actionCfg, triggerData) : `Unknown action: ${rule.action_type}`;

      logTrigger(rule.id, triggerData, actionTaken);
      console.log(`[Automation] Rule "${rule.name}" (id=${rule.id}) fired: ${actionTaken}`);

    } catch (err) {
      console.error(`[Automation] Error in rule #${rule.id}:`, err.message);
    }
  }

  // Stamp last_checked for all active rules
  db.prepare("UPDATE automation_rules SET last_checked_at = unixepoch() WHERE status = 'active'").run();
}

module.exports = { runAutomationRules };
