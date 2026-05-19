/**
 * Webhook Trigger Utility
 *
 * Finds all active webhook_subscriptions matching a given event type,
 * builds a signed JSON payload, and queues each into webhook_retry_queue
 * for reliable delivery via the existing retry worker.
 *
 * Usage:
 *   const { triggerWebhook } = require('./utils/webhookTrigger');
 *   triggerWebhook('conversion', { click_id: '...', campaign_id: 42, payout: 1.5 });
 */

const crypto = require('crypto');
const db     = require('../db/init');

/**
 * Trigger webhooks for a given event type.
 * @param {string} eventType  – e.g. 'conversion', 'cap_reached', 'fraud_detected', 'campaign_paused'
 * @param {object} payload    – arbitrary data to send in the POST body
 */
function triggerWebhook(eventType, payload = {}) {
  if (!eventType) return;

  // Find all active subscriptions whose comma-separated events list contains eventType
  const subs = db.prepare(`
    SELECT * FROM webhook_subscriptions
    WHERE status = 'active' AND (',' || events || ',') LIKE '%,' || ? || ',%'
  `).all(eventType);

  if (subs.length === 0) return;

  const now = Math.floor(Date.now() / 1000);

  const enqueue = db.prepare(`
    INSERT INTO webhook_retry_queue (url, context_type, context_id, next_retry_at)
    VALUES (?, ?, ?, unixepoch())
  `);

  const updateSub = db.prepare(`
    UPDATE webhook_subscriptions
    SET last_triggered_at = ?, trigger_count = trigger_count + 1, updated_at = ?
    WHERE id = ?
  `);

  const runBatch = db.transaction((subscriptions) => {
    for (const sub of subscriptions) {
      const body = {
        event:      eventType,
        timestamp:  new Date().toISOString(),
        data:       payload,
      };

      // If the subscription has a secret, compute HMAC-SHA256 signature
      if (sub.secret) {
        const rawBody = JSON.stringify(body);
        const signature = crypto
          .createHmac('sha256', sub.secret)
          .update(rawBody)
          .digest('hex');
        body._meta = {
          signature_header: 'X-Webhook-Signature',
          signature:        signature,
        };
      }

      // Build a special URL that the retry worker will POST to.
      // We encode the full payload in the webhook_retry_queue.url column
      // as a JSON-tagged string so the worker can detect it and POST.
      const queuePayload = JSON.stringify({
        __webhook: true,
        method:    'POST',
        url:       sub.url,
        headers:   {
          'Content-Type':        'application/json',
          'User-Agent':          'TrackMMP-Webhook/1.0',
          ...(sub.secret ? { 'X-Webhook-Signature': body._meta.signature } : {}),
        },
        body: body,
      });

      enqueue.run(queuePayload, 'webhook_subscription', sub.id);
      updateSub.run(now, now, sub.id);
    }
  });

  try {
    runBatch(subs);
  } catch (e) {
    console.error('[webhookTrigger] error queuing webhooks:', e.message);
  }
}

module.exports = { triggerWebhook };
