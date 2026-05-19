const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const db      = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// ── GET / — list webhook subscriptions for the current user ──────────────
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM webhook_subscriptions
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// ── POST / — create a new webhook subscription ──────────────────────────
router.post('/', (req, res) => {
  const { name, url, events, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const VALID_EVENTS = ['conversion', 'cap_reached', 'fraud_detected', 'campaign_paused'];
  const eventList = (events || 'conversion').split(',').map(e => e.trim()).filter(Boolean);
  const invalid = eventList.filter(e => !VALID_EVENTS.includes(e));
  if (invalid.length) {
    return res.status(400).json({ error: `Invalid event types: ${invalid.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}` });
  }

  // Generate a secret if not provided
  const webhookSecret = secret || crypto.randomBytes(32).toString('hex');

  const result = db.prepare(`
    INSERT INTO webhook_subscriptions (user_id, name, url, events, secret)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, name || '', url, eventList.join(','), webhookSecret);

  const row = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// ── PUT /:id — update an existing subscription ──────────────────────────
router.put('/:id', (req, res) => {
  const sub = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!sub) return res.status(404).json({ error: 'Webhook subscription not found' });

  const { name, url, events, secret, status } = req.body;

  if (events) {
    const VALID_EVENTS = ['conversion', 'cap_reached', 'fraud_detected', 'campaign_paused'];
    const eventList = events.split(',').map(e => e.trim()).filter(Boolean);
    const invalid = eventList.filter(e => !VALID_EVENTS.includes(e));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid event types: ${invalid.join(', ')}` });
    }
  }

  if (status && !['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or paused' });
  }

  db.prepare(`
    UPDATE webhook_subscriptions SET
      name   = COALESCE(?, name),
      url    = COALESCE(?, url),
      events = COALESCE(?, events),
      secret = COALESCE(?, secret),
      status = COALESCE(?, status),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    name   || null,
    url    || null,
    events || null,
    secret || null,
    status || null,
    sub.id
  );

  const updated = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?').get(sub.id);
  res.json(updated);
});

// ── DELETE /:id — delete a subscription ──────────────────────────────────
router.delete('/:id', (req, res) => {
  const sub = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!sub) return res.status(404).json({ error: 'Webhook subscription not found' });

  db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(sub.id);
  res.json({ ok: true });
});

// ── POST /:id/test — send a test webhook to the subscription URL ────────
router.post('/:id/test', async (req, res) => {
  const sub = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!sub) return res.status(404).json({ error: 'Webhook subscription not found' });

  const body = {
    event:     'test',
    timestamp: new Date().toISOString(),
    data: {
      message:         'This is a test webhook from TrackMMP',
      subscription_id: sub.id,
      subscription_name: sub.name,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':   'TrackMMP-Webhook/1.0',
  };

  if (sub.secret) {
    const rawBody = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', sub.secret)
      .update(rawBody)
      .digest('hex');
    headers['X-Webhook-Signature'] = signature;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(sub.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    res.json({
      ok:          resp.ok,
      status:      resp.status,
      status_text: resp.statusText,
    });
  } catch (err) {
    res.status(502).json({
      ok:    false,
      error: err.message || 'Failed to reach webhook URL',
    });
  }
});

module.exports = router;
