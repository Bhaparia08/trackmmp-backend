/**
 * /api/attendance — AM attendance tracking with geo + optional biometric (WebAuthn)
 *
 * Routes:
 *   POST /register-challenge  — start WebAuthn registration (AM)
 *   POST /register-complete   — complete WebAuthn registration (AM)
 *   POST /auth-challenge      — get WebAuthn assertion challenge (AM)
 *   POST /checkin             — check in with geo + optional biometric (AM)
 *   POST /checkout            — check out with geo + optional biometric (AM)
 *   GET  /my                  — AM's own attendance history
 *   GET  /                    — admin: all AMs attendance (filterable)
 *   GET  /summary             — admin: today's summary per AM
 *   DELETE /credentials/:id   — AM removes a registered biometric device
 */
const express = require('express');
const db      = require('../db/init');
const fetch   = require('node-fetch');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { requireAuth, requireRole } = require('../middleware/auth');

const router   = express.Router();
const requireAM    = requireRole('account_manager', 'admin');
const requireAdmin = requireRole('admin');

// In-memory challenge store (keyed by user_id).
// Short-lived — challenges expire after 60s anyway via WebAuthn timeout.
const pendingChallenges = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// Reverse-geocode lat/lng → readable address using OSM Nominatim (free, no key)
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'TrackMMP-Attendance/1.0' },
      timeout: 4000,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.display_name || null;
  } catch {
    return null;
  }
}

// Determine RP ID and origin from request (needed for WebAuthn)
function getRpId(req) {
  const host = req.headers.host || 'localhost';
  return host.split(':')[0]; // strip port
}
function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host  = req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

// ── WebAuthn: Register biometric device ───────────────────────────────────

// Step 1: generate registration options (challenge)
router.post('/register-challenge', requireAM, (req, res) => {
  const user = req.user;
  const existing = db.prepare('SELECT credential_id FROM am_biometric_credentials WHERE user_id = ?').all(user.id);

  const options = generateRegistrationOptions({
    rpName:              'TrackMMP',
    rpID:                getRpId(req),
    userID:              String(user.id),
    userName:            user.email,
    userDisplayName:     user.name || user.email,
    attestationType:     'none',
    excludeCredentials:  existing.map(c => ({ id: c.credential_id, type: 'public-key' })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',  // device biometric (Face ID / fingerprint)
      requireResidentKey: false,
      userVerification: 'required',
    },
  });

  pendingChallenges.set(user.id, options.challenge);
  setTimeout(() => pendingChallenges.delete(user.id), 60000);

  res.json(options);
});

// Step 2: verify and save credential
router.post('/register-complete', requireAM, async (req, res) => {
  const user      = req.user;
  const challenge = pendingChallenges.get(user.id);
  if (!challenge) return res.status(400).json({ error: 'No pending registration challenge. Please start again.' });

  try {
    const verification = await verifyRegistrationResponse({
      response:            req.body,
      expectedChallenge:   challenge,
      expectedOrigin:      getOrigin(req),
      expectedRPID:        getRpId(req),
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Biometric verification failed.' });
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    const credId = Buffer.from(credentialID).toString('base64url');

    db.prepare(`INSERT OR REPLACE INTO am_biometric_credentials
      (user_id, credential_id, public_key, counter, device_name)
      VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, credId,
           Buffer.from(credentialPublicKey).toString('base64'),
           counter,
           req.body.deviceName || req.headers['user-agent']?.slice(0, 80) || 'Unknown device');

    pendingChallenges.delete(user.id);
    res.json({ ok: true, message: 'Biometric registered successfully.' });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Registration failed.' });
  }
});

// ── WebAuthn: Authentication challenge (before check-in) ──────────────────

router.post('/auth-challenge', requireAM, (req, res) => {
  const user  = req.user;
  const creds = db.prepare('SELECT credential_id FROM am_biometric_credentials WHERE user_id = ?').all(user.id);

  if (creds.length === 0) {
    return res.status(404).json({ error: 'No biometric registered for this account.' });
  }

  const options = generateAuthenticationOptions({
    rpID:                 getRpId(req),
    allowCredentials:     creds.map(c => ({ id: c.credential_id, type: 'public-key' })),
    userVerification:     'required',
  });

  pendingChallenges.set(`auth_${user.id}`, options.challenge);
  setTimeout(() => pendingChallenges.delete(`auth_${user.id}`), 60000);

  res.json(options);
});

// ── Check In ──────────────────────────────────────────────────────────────

router.post('/checkin', requireAM, async (req, res) => {
  const user = req.user;
  const { lat, lng, note, biometricResponse } = req.body;
  const ip   = getIp(req);
  let biometric_verified = 0;

  // Verify biometric if provided
  if (biometricResponse) {
    const challenge = pendingChallenges.get(`auth_${user.id}`);
    if (!challenge) return res.status(400).json({ error: 'Biometric challenge expired. Please try again.' });

    const cred = db.prepare('SELECT * FROM am_biometric_credentials WHERE user_id = ? AND credential_id = ?')
      .get(user.id, biometricResponse.id);
    if (!cred) return res.status(400).json({ error: 'Biometric credential not found.' });

    try {
      const verification = await verifyAuthenticationResponse({
        response:             biometricResponse,
        expectedChallenge:    challenge,
        expectedOrigin:       getOrigin(req),
        expectedRPID:         getRpId(req),
        authenticator: {
          credentialID:        Buffer.from(cred.credential_id, 'base64url'),
          credentialPublicKey: Buffer.from(cred.public_key, 'base64'),
          counter:             cred.counter,
        },
        requireUserVerification: true,
      });

      if (!verification.verified) return res.status(400).json({ error: 'Biometric verification failed.' });

      db.prepare('UPDATE am_biometric_credentials SET counter = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, cred.id);

      biometric_verified = 1;
      pendingChallenges.delete(`auth_${user.id}`);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Biometric verification failed.' });
    }
  }

  // Reverse geocode if coordinates provided
  let address = null;
  if (lat != null && lng != null) {
    address = await reverseGeocode(lat, lng);
  }

  const result = db.prepare(`INSERT INTO attendance (user_id, type, lat, lng, address, ip, biometric_verified, note)
    VALUES (?, 'check_in', ?, ?, ?, ?, ?, ?)`)
    .run(user.id, lat ?? null, lng ?? null, address, ip, biometric_verified, note || null);

  const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(record);
});

// ── Check Out ─────────────────────────────────────────────────────────────

router.post('/checkout', requireAM, async (req, res) => {
  const user = req.user;
  const { lat, lng, note, biometricResponse } = req.body;
  const ip   = getIp(req);
  let biometric_verified = 0;

  // Check they actually checked in today
  const todayIn = db.prepare(`SELECT id FROM attendance
    WHERE user_id = ? AND type = 'check_in'
    AND date(created_at, 'unixepoch') = date('now')
    ORDER BY created_at DESC LIMIT 1`).get(user.id);
  if (!todayIn) return res.status(400).json({ error: 'You have not checked in today.' });

  if (biometricResponse) {
    const challenge = pendingChallenges.get(`auth_${user.id}`);
    if (!challenge) return res.status(400).json({ error: 'Biometric challenge expired. Please try again.' });

    const cred = db.prepare('SELECT * FROM am_biometric_credentials WHERE user_id = ? AND credential_id = ?')
      .get(user.id, biometricResponse.id);
    if (!cred) return res.status(400).json({ error: 'Biometric credential not found.' });

    try {
      const verification = await verifyAuthenticationResponse({
        response:             biometricResponse,
        expectedChallenge:    challenge,
        expectedOrigin:       getOrigin(req),
        expectedRPID:         getRpId(req),
        authenticator: {
          credentialID:        Buffer.from(cred.credential_id, 'base64url'),
          credentialPublicKey: Buffer.from(cred.public_key, 'base64'),
          counter:             cred.counter,
        },
        requireUserVerification: true,
      });

      if (!verification.verified) return res.status(400).json({ error: 'Biometric verification failed.' });
      db.prepare('UPDATE am_biometric_credentials SET counter = ? WHERE id = ?')
        .run(verification.authenticationInfo.newCounter, cred.id);
      biometric_verified = 1;
      pendingChallenges.delete(`auth_${user.id}`);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Biometric verification failed.' });
    }
  }

  let address = null;
  if (lat != null && lng != null) {
    address = await reverseGeocode(lat, lng);
  }

  const result = db.prepare(`INSERT INTO attendance (user_id, type, lat, lng, address, ip, biometric_verified, note)
    VALUES (?, 'check_out', ?, ?, ?, ?, ?, ?)`)
    .run(user.id, lat ?? null, lng ?? null, address, ip, biometric_verified, note || null);

  const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(record);
});

// ── AM: own attendance history ─────────────────────────────────────────────

router.get('/my', requireAM, (req, res) => {
  const { from, to, limit = 30, offset = 0 } = req.query;
  let where = 'WHERE a.user_id = ?';
  const params = [req.user.id];
  if (from) { where += ' AND date(a.created_at,\'unixepoch\') >= ?'; params.push(from); }
  if (to)   { where += ' AND date(a.created_at,\'unixepoch\') <= ?'; params.push(to); }

  const rows = db.prepare(`SELECT a.* FROM attendance a ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, +limit, +offset);

  const hasBiometric = !!db.prepare('SELECT id FROM am_biometric_credentials WHERE user_id = ? LIMIT 1').get(req.user.id);
  res.json({ rows, hasBiometric });
});

// ── Admin: all AMs attendance ──────────────────────────────────────────────

router.get('/', requireAdmin, (req, res) => {
  const { from, to, user_id, limit = 50, offset = 0 } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (user_id) { where += ' AND a.user_id = ?'; params.push(+user_id); }
  if (from)    { where += ' AND date(a.created_at,\'unixepoch\') >= ?'; params.push(from); }
  if (to)      { where += ' AND date(a.created_at,\'unixepoch\') <= ?'; params.push(to); }

  const rows = db.prepare(`
    SELECT a.*, u.name as am_name, u.email as am_email
    FROM attendance a
    JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, +limit, +offset);

  const total = db.prepare(`SELECT COUNT(*) as n FROM attendance a ${where}`).get(...params).n;
  res.json({ rows, total });
});

// ── Admin: today's summary ─────────────────────────────────────────────────

router.get('/summary', requireAdmin, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  const ams = db.prepare(`
    SELECT u.id, u.name, u.email,
      (SELECT created_at FROM attendance WHERE user_id = u.id AND type = 'check_in'
        AND date(created_at,'unixepoch') = ? ORDER BY created_at ASC LIMIT 1) as check_in_at,
      (SELECT lat FROM attendance WHERE user_id = u.id AND type = 'check_in'
        AND date(created_at,'unixepoch') = ? ORDER BY created_at ASC LIMIT 1) as check_in_lat,
      (SELECT lng FROM attendance WHERE user_id = u.id AND type = 'check_in'
        AND date(created_at,'unixepoch') = ? ORDER BY created_at ASC LIMIT 1) as check_in_lng,
      (SELECT address FROM attendance WHERE user_id = u.id AND type = 'check_in'
        AND date(created_at,'unixepoch') = ? ORDER BY created_at ASC LIMIT 1) as check_in_address,
      (SELECT biometric_verified FROM attendance WHERE user_id = u.id AND type = 'check_in'
        AND date(created_at,'unixepoch') = ? ORDER BY created_at ASC LIMIT 1) as biometric_verified,
      (SELECT created_at FROM attendance WHERE user_id = u.id AND type = 'check_out'
        AND date(created_at,'unixepoch') = ? ORDER BY created_at DESC LIMIT 1) as check_out_at
    FROM users u
    WHERE u.role = 'account_manager' AND u.status = 'active'
    ORDER BY u.name
  `).all(date, date, date, date, date, date);

  res.json({ date, ams });
});

// ── AM: list + delete biometric credentials ────────────────────────────────

router.get('/credentials', requireAM, (req, res) => {
  const creds = db.prepare('SELECT id, device_name, created_at FROM am_biometric_credentials WHERE user_id = ?')
    .all(req.user.id);
  res.json(creds);
});

router.delete('/credentials/:id', requireAM, (req, res) => {
  db.prepare('DELETE FROM am_biometric_credentials WHERE id = ? AND user_id = ?')
    .run(+req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
