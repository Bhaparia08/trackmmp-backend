const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { customAlphabet } = require('nanoid');
const nodemailer = require('nodemailer');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');

const nanoid20hex = customAlphabet('0123456789abcdef', 20);
const nanoid32    = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 32);
function newPostbackToken() { return nanoid20hex(); }

// Email transporter — only created when SMTP env vars are set
function getMailer() {
  if (!process.env.SMTP_HOST && !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

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
    const nextSeq = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role, postback_token, seq_num) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'admin', newPostbackToken(), nextSeq);

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, postback_token, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
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

    const mailer = getMailer();
    const needsVerification = !!mailer;

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const nextSeq = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role, postback_token, email_verified, seq_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'advertiser', newPostbackToken(), needsVerification ? 0 : 1, nextSeq);

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, postback_token, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);

    if (needsVerification) {
      const verifyToken = nanoid32();
      const expiresAt = Math.floor(Date.now() / 1000) + 86400;
      db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, verifyToken, expiresAt);
      const base = process.env.FRONTEND_ORIGIN || 'https://track.apogeemobi.com';
      await sendVerificationEmail(mailer, email, name, `${base}/verify-email?token=${verifyToken}`);
      return res.status(201).json({ sent: true, email: user.email });
    }

    res.status(201).json({ token: signToken(user), user });
  } catch (err) { next(err); }
});

// Helper: send verification email or log URL (if SMTP not configured)
async function sendVerificationEmail(mailer, userEmail, userName, verifyUrl) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await mailer.sendMail({
    from: `"Apogeemobi" <${from}>`,
    to: userEmail,
    subject: 'Verify your Apogeemobi account',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#6366f1">Verify Your Email</h2>
        <p>Hi ${userName},</p>
        <p>Thanks for signing up! Please verify your email address to activate your account. This link expires in <strong>24 hours</strong>.</p>
        <p style="margin:24px 0">
          <a href="${verifyUrl}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
            Verify My Email
          </a>
        </p>
        <p style="color:#94a3b8;font-size:13px">If you didn't create an account, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
        <p style="color:#94a3b8;font-size:12px">Apogeemobi · track.apogeemobi.com</p>
      </div>
    `,
  });
}

// POST /api/auth/register/publisher  (open publisher self-signup)
router.post('/register/publisher', async (req, res, next) => {
  try {
    const { email, password, name, company_name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const mailer = getMailer();
    const needsVerification = !!mailer;

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const nextSeqUser = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role, postback_token, email_verified, seq_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'publisher', newPostbackToken(), needsVerification ? 0 : 1, nextSeqUser);

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, postback_token, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);

    // Auto-create a publisher record linked to this user.
    const { nanoid } = require('nanoid');
    const pub_token = nanoid(10);
    const adminRow = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
    const adminUserId = adminRow?.id || 1;
    const nextSeqPub = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM publishers').get().n);
    db.prepare(
      'INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token, seq_num) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(adminUserId, result.lastInsertRowid, name, email, pub_token, nextSeqPub);

    if (needsVerification) {
      const verifyToken = nanoid32();
      const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours
      db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, verifyToken, expiresAt);
      const base = process.env.FRONTEND_ORIGIN || 'https://track.apogeemobi.com';
      await sendVerificationEmail(mailer, email, name, `${base}/verify-email?token=${verifyToken}`);
      return res.status(201).json({ sent: true, email: user.email });
    }

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

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email address before signing in. Check your inbox for the verification link.',
        unverified: true,
        email: user.email,
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _p, ...safeUser } = user;
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (err) { next(err); }
});

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(
      'SELECT * FROM email_verification_tokens WHERE token=? AND used=0 AND expires_at > ?'
    ).get(token, now);
    if (!row) return res.status(400).json({ error: 'Verification link is invalid or has expired. Please request a new one.' });

    db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(row.user_id);
    db.prepare('UPDATE email_verification_tokens SET used=1 WHERE id=?').run(row.id);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const user = db.prepare('SELECT id, email, name, email_verified FROM users WHERE email = ?').get(email.toLowerCase().trim());
    // Silent success — don't leak which emails exist or verification state
    if (!user || user.email_verified) return res.json({ sent: true });

    const mailer = getMailer();
    if (!mailer) return res.json({ sent: true }); // SMTP not configured

    // Expire old tokens
    db.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND used=0').run(user.id);

    const verifyToken = nanoid32();
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, verifyToken, expiresAt);

    const base = process.env.FRONTEND_ORIGIN || 'https://track.apogeemobi.com';
    await sendVerificationEmail(mailer, user.email, user.name, `${base}/verify-email?token=${verifyToken}`);

    res.json({ sent: true });
  } catch (err) { next(err); }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email.toLowerCase().trim());
    // Always return 200 so we don't leak which emails exist
    if (!user) return res.json({ sent: true });

    // Expire any existing unused tokens for this user
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE user_id=? AND used=0').run(user.id);

    const token = nanoid32();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

    const base = process.env.FRONTEND_ORIGIN || 'https://track.apogeemobi.com';
    const resetUrl = `${base}/reset-password?token=${token}`;

    const mailer = getMailer();
    if (mailer) {
      const from = process.env.SMTP_FROM || process.env.SMTP_USER;
      await mailer.sendMail({
        from: `"Apogeemobi" <${from}>`,
        to: user.email,
        subject: 'Reset your Apogeemobi password',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#6366f1">Password Reset</h2>
            <p>Hi ${user.name},</p>
            <p>We received a request to reset your password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
            <p style="margin:24px 0">
              <a href="${resetUrl}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
                Reset Password
              </a>
            </p>
            <p style="color:#94a3b8;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:12px">Apogeemobi · track.apogeemobi.com</p>
          </div>
        `,
      });
      res.json({ sent: true });
    } else {
      // No SMTP configured — return the reset URL directly (admin use / dev mode)
      console.log(`[forgot-password] reset URL for ${user.email}: ${resetUrl}`);
      res.json({ sent: true, reset_url: resetUrl, note: 'SMTP not configured — reset URL returned directly' });
    }
  } catch (err) { next(err); }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare(
      'SELECT * FROM password_reset_tokens WHERE token=? AND used=0 AND expires_at > ?'
    ).get(token, now);
    if (!row) return res.status(400).json({ error: 'Reset link is invalid or has expired. Please request a new one.' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(row.id);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.email, u.name, u.company_name, u.role, u.plan, u.status,
           u.postback_token, u.created_at,
           am.name  AS account_manager_name,
           am.email AS account_manager_email,
           am.phone AS account_manager_phone
    FROM users u
    LEFT JOIN account_managers am ON am.id = u.account_manager_id
    WHERE u.id = ?`).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

module.exports = router;
