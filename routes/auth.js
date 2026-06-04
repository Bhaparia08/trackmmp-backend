const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { customAlphabet } = require('nanoid');
const nodemailer = require('nodemailer');
const otplib = require('otplib');
const QRCode = require('qrcode');
// otplib v4+ has flat exports — wrap for authenticator-style API
const authenticator = {
  generateSecret: () => otplib.generateSecret(),
  keyuri: (email, issuer, secret) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
  verify: ({ token, secret }) => otplib.verifySync({ token, secret }),
};
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const audit = require('../utils/auditLog');

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
      const mailResult = await sendVerificationEmail(mailer, email, name, `${base}/verify-email?token=${verifyToken}`);
      if (!mailResult.sent) {
        // SMTP failed — auto-verify and log in directly
        db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(user.id);
        const freshUser = db.prepare('SELECT id, email, name, company_name, role, plan, status, postback_token, created_at FROM users WHERE id = ?').get(user.id);
        return res.status(201).json({ token: signToken(freshUser), user: freshUser });
      }
      return res.status(201).json({ sent: true, email: user.email });
    }

    res.status(201).json({ token: signToken(user), user });
  } catch (err) { next(err); }
});

// Helper: send verification email — catches SMTP errors gracefully
// Returns { sent: true } on success, { sent: false, verify_url } on SMTP failure
async function sendVerificationEmail(mailer, userEmail, userName, verifyUrl) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
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
    return { sent: true };
  } catch (smtpErr) {
    console.error('[sendVerificationEmail] SMTP error:', smtpErr.message);
    return { sent: false, verify_url: verifyUrl };
  }
}

// GET /api/auth/account-managers — public list of AM names for publisher signup dropdown
router.get('/account-managers', (req, res) => {
  const ams = db.prepare('SELECT id, name FROM account_managers ORDER BY name').all();
  res.json(ams.map(a => ({ id: a.id, name: a.name })));
});

// POST /api/auth/register/publisher  (open publisher self-signup — requires admin approval)
router.post('/register/publisher', async (req, res, next) => {
  try {
    const { email, password, name, company_name, website_url, vertical, geo, traffic_type, monthly_traffic, account_manager_id } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const nextSeqUser = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n);
    // New publishers start as 'pending' — admin must approve before they can log in
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role, postback_token, email_verified, status, seq_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(email, hash, name, company_name || null, 'publisher', newPostbackToken(), 1, 'pending', nextSeqUser);

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, postback_token, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);

    // Auto-create a publisher record linked to this user with vertical/geo info
    const { nanoid } = require('nanoid');
    const pub_token = nanoid(10);
    const adminRow = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
    const adminUserId = adminRow?.id || 1;
    const nextSeqPub = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM publishers').get().n);
    db.prepare(
      'INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token, seq_num, vertical, geo, website_url, traffic_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(adminUserId, result.lastInsertRowid, company_name || name, email, pub_token, nextSeqPub,
          vertical || '', geo || '', website_url || '', traffic_type || 'web',
          monthly_traffic ? `Monthly traffic: ${monthly_traffic}` : '');

    // Assign selected account manager (if chosen during signup)
    if (account_manager_id) {
      const am = db.prepare('SELECT id FROM account_managers WHERE id = ?').get(account_manager_id);
      if (am) {
        db.prepare('INSERT OR IGNORE INTO user_account_managers (user_id, account_manager_id) VALUES (?, ?)').run(result.lastInsertRowid, am.id);
      }
    }

    // Notify admin + assigned AM via socket
    try {
      const io = req.app.get('io');
      if (io) {
        const notification = { id: user.id, name, email, company_name, website_url, account_manager_id };
        io.to(adminUserId.toString()).emit('new_publisher_application', notification);
        // Also notify the assigned AM if they have a user account
        if (account_manager_id) {
          const amUser = db.prepare('SELECT user_id FROM account_managers WHERE id = ?').get(account_manager_id);
          if (amUser?.user_id) io.to(amUser.user_id.toString()).emit('new_publisher_application', notification);
        }
      }
    } catch {}

    res.status(201).json({
      pending: true,
      message: 'Your application has been submitted. Our team will review it and get back to you within 24 hours.',
    });
  } catch (err) { next(err); }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, totp_token } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact admin.' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Your application is under review. Our team will get back to you within 24 hours.', pending: true });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Your application was not approved. Contact support for more details.' });

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email address before signing in. Check your inbox for the verification link.',
        unverified: true,
        email: user.email,
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // 2FA check: if TOTP is enabled for this user
    if (user.totp_enabled === 1 && user.totp_secret) {
      if (!totp_token) {
        // Password correct but 2FA code not provided — prompt frontend
        return res.json({ requires_2fa: true, email: user.email });
      }
      // Verify the TOTP token
      const isValid = authenticator.verify({ token: totp_token, secret: user.totp_secret });
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    const { password: _p, totp_secret: _ts, ...safeUser } = user;
    audit.log(req, 'login', 'user', user.id, user.email, { role: user.role });
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
    const mailResult = await sendVerificationEmail(mailer, user.email, user.name, `${base}/verify-email?token=${verifyToken}`);
    if (!mailResult.sent) {
      // SMTP failed — auto-verify the user so they can log in
      db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(user.id);
      return res.json({ sent: true, auto_verified: true });
    }

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
      try {
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
      } catch (smtpErr) {
        // SMTP failed (bad credentials, blocked, etc.) — fall back to returning the reset URL directly
        console.error('[forgot-password] SMTP error:', smtpErr.message);
        res.json({ sent: true, reset_url: resetUrl, note: 'Email delivery failed — use this link to reset your password' });
      }
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

// POST /api/auth/change-password — authenticated self-service password change
// Requires the current password; rejects weak/common new passwords.
const WEAK_PASSWORDS = new Set([
  'admin123', 'password', 'password1', '12345678', '123456789', 'qwerty123',
  'admin1234', 'changeme', 'letmein1', 'trackmmp1',
]);
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (WEAK_PASSWORDS.has(new_password.toLowerCase())) {
      return res.status(400).json({ error: 'That password is too common — choose something stronger' });
    }
    const user = db.prepare('SELECT id, email, password FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(current_password, user.password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    if (await bcrypt.compare(new_password, user.password)) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
    try { audit.log(req, 'change_password', 'user', user.id, user.email, {}); } catch {}
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/auth/create-admin  — create additional admin accounts (super-admin only)
// Only integration@apogeemobi.com can call this. New admin starts with a fresh user_id (isolated data).
router.post('/create-admin', requireAuth, async (req, res, next) => {
  try {
    if (req.user.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Only the super-admin can create admin accounts' });
    }
    const { email, password, name, company_name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const nextSeq = (db.prepare('SELECT COALESCE(MAX(seq_num),0)+1 AS n FROM users').get().n);
    const result = db.prepare(
      'INSERT INTO users (email, password, name, company_name, role, postback_token, email_verified, created_by, seq_num) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(email, hash, name, company_name || null, 'admin', newPostbackToken(), req.user.id, nextSeq);

    const user = db.prepare('SELECT id, email, name, company_name, role, plan, status, postback_token, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.email, u.name, u.company_name, u.role, u.plan, u.status,
           u.postback_token, u.created_at, u.admin_nav_config,
           am.name  AS account_manager_name,
           am.email AS account_manager_email,
           am.phone AS account_manager_phone
    FROM users u
    LEFT JOIN account_managers am ON am.id = u.account_manager_id
    WHERE u.id = ?`).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Invoice visibility flag — drives the sidebar and any inline UI checks.
  // Driven by the same INVOICE_ADMINS allowlist as routes/invoices.js. Until
  // per-user invoice customisation ships, only listed emails see invoices.
  const allowRaw = process.env.INVOICE_ADMINS || 'integration@apogeemobi.com';
  const allowSet = new Set(allowRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  user.canViewInvoices = allowSet.has((user.email || '').toLowerCase());
  res.json(user);
});

// ───── Two-Factor Authentication (TOTP) routes ─────

// GET /api/auth/2fa/status — check if 2FA is enabled for the logged-in user
router.get('/2fa/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ enabled: user.totp_enabled === 1 });
});

// POST /api/auth/2fa/setup — generate a new TOTP secret + QR code data URL
router.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const user = db.prepare('SELECT id, email, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.totp_enabled === 1) return res.status(400).json({ error: '2FA is already enabled' });

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, 'TrackMMP', secret);
    const qr_url = await QRCode.toDataURL(otpauth);

    // Store secret temporarily — it only becomes active after verify step
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, user.id);

    res.json({ secret, qr_url });
  } catch (err) { next(err); }
});

// POST /api/auth/2fa/verify — verify 6-digit code and enable 2FA
router.post('/2fa/verify', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token (6-digit code) is required' });

  const user = db.prepare('SELECT id, email, totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totp_enabled === 1) return res.status(400).json({ error: '2FA is already enabled' });
  if (!user.totp_secret) return res.status(400).json({ error: 'Call /2fa/setup first to generate a secret' });

  const isValid = authenticator.verify({ token, secret: user.totp_secret });
  if (!isValid) return res.status(401).json({ error: 'Invalid 2FA code — please try again' });

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  try { audit.log(req, '2fa_enable', 'user', user.id, user.email, {}); } catch {}
  res.json({ success: true, message: '2FA has been enabled' });
});

// POST /api/auth/2fa/disable — verify code and disable 2FA
router.post('/2fa/disable', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token (6-digit code) is required' });

  const user = db.prepare('SELECT id, email, totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totp_enabled !== 1) return res.status(400).json({ error: '2FA is not enabled' });
  if (!user.totp_secret) return res.status(400).json({ error: '2FA secret not found' });

  const isValid = authenticator.verify({ token, secret: user.totp_secret });
  if (!isValid) return res.status(401).json({ error: 'Invalid 2FA code' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = \'\' WHERE id = ?').run(user.id);
  try { audit.log(req, '2fa_disable', 'user', user.id, user.email, {}); } catch {}
  res.json({ success: true, message: '2FA has been disabled' });
});

module.exports = router;
