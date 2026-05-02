/**
 * Webhook Retry Queue
 * Outbound postback URLs that fail (network error / 5xx) are stored in
 * webhook_retry_queue and retried with exponential backoff.
 *
 * Retry schedule (attempts × 30s base):
 *   attempt 1 → 30s
 *   attempt 2 → 2m
 *   attempt 3 → 8m
 *   attempt 4 → 32m
 *   attempt 5 → give up → status = 'failed'
 */

const fetch = require('node-fetch');
const db    = require('../db/init');

const BASE_DELAY_SEC = 30;

/**
 * Enqueue a URL for reliable delivery.
 * @param {string} url            – fully-resolved postback URL
 * @param {string} contextType    – 'postback' | 'goal' | 'publisher'
 * @param {number|null} contextId – postback row id (optional, for debugging)
 */
function enqueueWebhook(url, contextType = 'postback', contextId = null) {
  if (!url) return;
  try {
    db.prepare(`
      INSERT INTO webhook_retry_queue (url, context_type, context_id, next_retry_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(url, contextType, contextId ?? null);
  } catch (e) {
    console.error('[webhookRetry] enqueue error:', e.message);
  }
}

/**
 * Calculate next retry delay using exponential backoff.
 * attempt 0 = 30s, 1 = 2m, 2 = 8m, 3 = 32m
 */
function nextDelaySeconds(attempts) {
  return BASE_DELAY_SEC * Math.pow(4, attempts);
}

/**
 * Process all pending/retry-due webhooks.
 * Called by the server.js interval every 30 seconds.
 */
async function processWebhookQueue() {
  const now = Math.floor(Date.now() / 1000);
  const pending = db.prepare(`
    SELECT * FROM webhook_retry_queue
    WHERE status = 'pending' AND next_retry_at <= ?
    ORDER BY next_retry_at ASC
    LIMIT 50
  `).all(now);

  if (pending.length === 0) return;

  for (const item of pending) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(item.url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'ApogeeMobiTrackMMP/1.0' },
      });
      clearTimeout(timeout);

      if (resp.ok || (resp.status >= 200 && resp.status < 300)) {
        // Success
        db.prepare(`UPDATE webhook_retry_queue SET status = 'delivered', attempts = ? WHERE id = ?`)
          .run(item.attempts + 1, item.id);
      } else {
        handleFailure(item, `HTTP ${resp.status}`);
      }
    } catch (err) {
      handleFailure(item, err.message || 'network_error');
    }
  }
}

function handleFailure(item, errorMsg) {
  const newAttempts = item.attempts + 1;
  if (newAttempts >= item.max_attempts) {
    db.prepare(`UPDATE webhook_retry_queue SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`)
      .run(newAttempts, errorMsg, item.id);
    console.warn(`[webhookRetry] FAILED after ${newAttempts} attempts — ${item.url.substring(0, 80)}`);
  } else {
    const delay = nextDelaySeconds(newAttempts);
    const nextRetry = Math.floor(Date.now() / 1000) + delay;
    db.prepare(`UPDATE webhook_retry_queue SET attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?`)
      .run(newAttempts, errorMsg, nextRetry, item.id);
  }
}

/**
 * Get queue stats (for admin dashboard / API).
 */
function getQueueStats() {
  return db.prepare(`
    SELECT status, COUNT(*) AS n FROM webhook_retry_queue GROUP BY status
  `).all();
}

/**
 * Clean up delivered/failed entries older than 7 days.
 */
function cleanupOldEntries() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  db.prepare(`
    DELETE FROM webhook_retry_queue WHERE status IN ('delivered','failed') AND created_at < ?
  `).run(cutoff);
}

module.exports = { enqueueWebhook, processWebhookQueue, getQueueStats, cleanupOldEntries };
