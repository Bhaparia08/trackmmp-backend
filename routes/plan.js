const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const plans = require('../utils/plans');

const router = express.Router();

// Public list of plan tiers — used by pricing page + plan picker.
router.get('/tiers', (req, res) => {
  res.json(plans.listTiers());
});

// Authenticated: current user's plan + monthly usage.
router.get('/me', requireAuth, (req, res) => {
  // For sub-roles (publisher / account_manager), report the parent
  // advertiser-of-record's usage when known. Admins always see their own.
  res.json(plans.status(req.user.id));
});

// Admin: change another user's plan.
router.post('/users/:id/plan', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { plan } = req.body || {};
  if (!plans.getTier(plan) || !plans.TIERS[plan]) {
    return res.status(400).json({ error: 'Unknown plan id' });
  }
  const u = db.prepare('SELECT id, plan FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, u.id);
  res.json({ success: true, user_id: u.id, plan });
});

module.exports = router;
