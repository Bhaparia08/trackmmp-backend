const express = require('express');
const bcrypt = require('bcrypt');
const { nanoid } = require('nanoid');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

// GET /api/admin/users?role=advertiser|publisher
router.get('/users', requireAdmin, (req, res) => {
  const { role } = req.query;
  let query = 'SELECT id, email, name, company_name, role, status, plan, created_at FROM users WHERE role != ?';
  const params = ['admin'];
  if (role) { query += ' AND role = ?'; params.push(role); }
  query += ' ORDER BY created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// POST /api/admin/users  — create advertiser or publisher
router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const { email, password, name, company_name, role } = req.body;
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
      'INSERT INTO users (email, password, name, company_name, role, created_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, role, req.user.id);

    const user = db.prepare('SELECT id, email, name, company_name, role, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);

    // If publisher — auto-create linked publisher record
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
    const { name, company_name, status, password } = req.body;
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND role != ?').get(req.params.id, 'admin');
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (password) {
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
    }
    db.prepare('UPDATE users SET name = ?, company_name = ?, status = ? WHERE id = ?')
      .run(name, company_name || null, status || 'active', req.params.id);

    res.json(db.prepare('SELECT id, email, name, company_name, role, status, created_at FROM users WHERE id = ?').get(req.params.id));
  } catch (err) { next(err); }
});

// DELETE /api/admin/users/:id  (suspend, not hard delete)
router.delete('/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND role != ?').get(req.params.id, 'admin');
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
