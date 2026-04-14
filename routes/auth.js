const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role || 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register  (admin registration — restricted to integration@apogeemobi.com only)
const ADMIN_EMAIL = 'integration@apogeemobi.com';
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, company_name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });

    if (email.toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Admin registration is not open. Use the Advertiser or Publisher signup.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'admin');

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user });
  } catch (err) { next(err); }
});

// POST /api/auth/register/advertiser  (open advertiser self-signup)
router.post('/register/advertiser', async (req, res, next) => {
  try {
    const { email, password, name, company_name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'advertiser');

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user });
  } catch (err) { next(err); }
});

// POST /api/auth/register/publisher  (open publisher self-signup)
router.post('/register/publisher', async (req, res, next) => {
  try {
    const { email, password, name, company_name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'publisher');

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);

    // Auto-create a publisher record linked to this user
    const { nanoid } = require('nanoid');
    const pub_token = nanoid(10);
    db.prepare(
      'INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token) VALUES (?, ?, ?, ?, ?)'
    ).run(1, result.lastInsertRowid, name, email, pub_token); // user_id=1 (admin owns it)

    res.status(201).json({ token: signToken(user), user });
  } catch (err) { next(err); }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact admin.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _p, ...safeUser } = user;
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
