// Visitor ID helper — stable per-browser identifier for frequency capping,
// A/B test bucketing, and impression attribution. The SDK sets `apg_uid` on
// the first visit (localStorage + cookie). Server reads either source.
//
// Falls back to a deterministic fingerprint of (ip + ua + day) when no visitor
// id is supplied — useful for non-SDK callers (WordPress plugin SSR) so caps
// still apply, though it's a weaker identifier (rotates daily by design).

const crypto = require('crypto');

const SALT = process.env.VISITOR_ID_SALT || 'apg-v1-2026-default-salt';

function getVisitorId(req) {
  // Explicit param wins (the SDK sends it as ?uid=... or X-Apg-Uid header).
  const fromQuery  = (req.query?.uid || '').trim();
  const fromHeader = (req.headers?.['x-apg-uid'] || '').trim();
  const fromCookie = parseCookie(req.headers?.cookie || '')['apg_uid'];

  const explicit = fromQuery || fromHeader || fromCookie;
  if (explicit && /^[A-Za-z0-9_-]{16,64}$/.test(explicit)) return explicit;

  // Fallback: deterministic daily hash of IP + UA.  This intentionally
  // rotates each day to limit cross-day re-identification.
  const ip = (req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim();
  const ua = req.headers?.['user-agent'] || '';
  const day = new Date().toISOString().slice(0, 10);
  const h = crypto.createHash('sha256').update(`${ip}|${ua}|${day}|${SALT}`).digest('base64url');
  return 'fp_' + h.slice(0, 22);
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`${ip}|${SALT}`).digest('hex').slice(0, 32);
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

module.exports = { getVisitorId, hashIp };
