const express = require('express');
const bcrypt = require('bcrypt');
const { nanoid } = require('nanoid');
const { customAlphabet } = require('nanoid');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const nanoid20hex = customAlphabet('0123456789abcdef', 20);

const router = express.Router();
const SALT_ROUNDS = 12;

// ── Account Managers ──────────────────────────────────────────────────────────

// GET /api/admin/account-managers
router.get('/account-managers', requireAdmin, (req, res) => {
  const ams = db.prepare(`
    SELECT am.*, u.status AS user_status, u.id AS user_id
    FROM account_managers am
    LEFT JOIN users u ON u.id = am.user_id
    ORDER BY am.name ASC
  `).all();
  res.json(ams);
});

// POST /api/admin/account-managers — creates AM record + user login account
router.post('/account-managers', requireAdmin, async (req, res, next) => {
  try {
    const { name, email, phone, notes, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });

    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingUser) return res.status(409).json({ error: 'Email already registered as a user' });
    const existingAM = db.prepare('SELECT id FROM account_managers WHERE email = ?').get(email);
    if (existingAM) return res.status(409).json({ error: 'Email already exists as account manager' });

    // Create user account with account_manager role
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const userResult = db.prepare(
      'INSERT INTO users (email, password, name, role, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, name, 'account_manager', req.user.id);
    const userId = userResult.lastInsertRowid;

    // Create account manager record linked to the user
    const amResult = db.prepare(
      'INSERT INTO account_managers (name, email, phone, notes, user_id) VALUES (?, ?, ?, ?, ?)'
    ).run(name, email, phone || null, notes || null, userId);

    res.status(201).json(db.prepare('SELECT am.*, u.status AS user_status FROM account_managers am LEFT JOIN users u ON u.id = am.user_id WHERE am.id = ?').get(amResult.lastInsertRowid));
  } catch (err) { next(err); }
});

// PUT /api/admin/account-managers/:id
router.put('/account-managers/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, email, phone, notes, password, status } = req.body;
    const am = db.prepare('SELECT * FROM account_managers WHERE id = ?').get(req.params.id);
    if (!am) return res.status(404).json({ error: 'Account manager not found' });

    db.prepare('UPDATE account_managers SET name = ?, email = ?, phone = ?, notes = ? WHERE id = ?')
      .run(name, email, phone || null, notes || null, req.params.id);

    // Sync to user account
    if (am.user_id) {
      db.prepare('UPDATE users SET name = ?, email = ?, status = ? WHERE id = ?')
        .run(name, email, status || 'active', am.user_id);
      if (password) {
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, am.user_id);
      }
    }

    res.json(db.prepare('SELECT am.*, u.status AS user_status FROM account_managers am LEFT JOIN users u ON u.id = am.user_id WHERE am.id = ?').get(req.params.id));
  } catch (err) { next(err); }
});

// DELETE /api/admin/account-managers/:id
router.delete('/account-managers/:id', requireAdmin, (req, res) => {
  const am = db.prepare('SELECT * FROM account_managers WHERE id = ?').get(req.params.id);
  if (!am) return res.status(404).json({ error: 'Account manager not found' });
  db.prepare('UPDATE users SET account_manager_id = NULL WHERE account_manager_id = ?').run(req.params.id);
  if (am.user_id) {
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(am.user_id);
  }
  db.prepare('DELETE FROM account_managers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Users ─────────────────────────────────────────────────────────────────────

// GET /api/admin/users?role=advertiser|publisher
router.get('/users', requireAdmin, (req, res) => {
  const { role } = req.query;
  let query = `
    SELECT u.id, u.email, u.name, u.company_name, u.role, u.status, u.plan, u.created_at,
           u.account_manager_id,
           am.name  AS account_manager_name,
           am.email AS account_manager_email,
           am.phone AS account_manager_phone
    FROM users u
    LEFT JOIN account_managers am ON am.id = u.account_manager_id
    WHERE u.role NOT IN ('admin','account_manager')`;
  const params = [];
  if (role) { query += ' AND u.role = ?'; params.push(role); }
  query += ' ORDER BY u.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// POST /api/admin/users  — create advertiser or publisher
router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const { email, password, name, company_name, role, account_manager_id } = req.body;
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'email, password, name and role are required' });
    }
    if (!['advertiser', 'publisher'].includes(role)) {
      return res.status(400).json({ error: 'role must be advertiser or publisher' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role, created_by, account_manager_id, postback_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, role, req.user.id, account_manager_id || null, nanoid20hex());

    const user = db.prepare('SELECT id, email, name, company_name, role, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);

    if (role === 'publisher') {
      const pub_token = nanoid(10);
      db.prepare(
        'INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token) VALUES (?, ?, ?, ?, ?)'
      ).run(req.user.id, result.lastInsertRowid, name, email, pub_token);
    }

    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PUT /api/admin/users/:id
router.put('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, company_name, status, password, account_manager_id } = req.body;
    const user = db.prepare("SELECT id FROM users WHERE id = ? AND role NOT IN ('admin','account_manager')").get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (password) {
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
    }
    db.prepare('UPDATE users SET name = ?, company_name = ?, status = ?, account_manager_id = ? WHERE id = ?')
      .run(name, company_name || null, status || 'active', account_manager_id || null, req.params.id);

    const updated = db.prepare(`
      SELECT u.id, u.email, u.name, u.company_name, u.role, u.status, u.created_at,
             u.account_manager_id,
             am.name  AS account_manager_name,
             am.email AS account_manager_email,
             am.phone AS account_manager_phone
      FROM users u
      LEFT JOIN account_managers am ON am.id = u.account_manager_id
      WHERE u.id = ?`).get(req.params.id);
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/admin/users/:id  (suspend, not hard delete)
router.delete('/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role NOT IN ('admin','account_manager')").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/stats  — platform-wide overview
router.get('/stats', requireAdmin, (req, res) => {
  const advertisers = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'advertiser'").get().n;
  const publishers  = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'publisher'").get().n;
  const campaigns   = db.prepare('SELECT COUNT(*) as n FROM campaigns').get().n;
  const clicks      = db.prepare('SELECT COUNT(*) as n FROM clicks').get().n;
  const conversions = db.prepare("SELECT COUNT(*) as n FROM postbacks WHERE status = 'attributed'").get().n;
  const revenue     = db.prepare('SELECT COALESCE(SUM(revenue),0) as r FROM postbacks').get().r;
  res.json({ advertisers, publishers, campaigns, clicks, conversions, revenue });
});

module.exports = router;
