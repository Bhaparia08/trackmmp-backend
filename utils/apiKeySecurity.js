const crypto = require('crypto');

const API_KEY_PREFIX = 'apg_live_';
const REDACTED_PREFIX = 'redacted:publisher-api-key:';

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateApiKey() {
  return API_KEY_PREFIX + base64url(crypto.randomBytes(32));
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || ''), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function getKeyPrefix(apiKey) {
  const key = String(apiKey || '');
  if (key.startsWith(API_KEY_PREFIX)) return key.slice(0, API_KEY_PREFIX.length + 6);
  return key.slice(0, 6);
}

function getKeyLast4(apiKey) {
  return String(apiKey || '').slice(-4);
}

function getKeyPreview(rowOrKey) {
  if (rowOrKey && typeof rowOrKey === 'object') {
    const prefix = rowOrKey.api_key_prefix || '';
    const last4 = rowOrKey.api_key_last4 || '';
    if (prefix && last4) return `${prefix}••••${last4}`;
    return '••••••••';
  }
  const key = String(rowOrKey || '');
  if (!key) return '••••••••';
  return `${getKeyPrefix(key)}••••${getKeyLast4(key)}`;
}

function redactedApiKeyValue(id, last4) {
  return `${REDACTED_PREFIX}${id || 'pending'}:${last4 || 'none'}`;
}

function temporaryRedactedApiKeyValue(last4) {
  return redactedApiKeyValue(`pending-${crypto.randomUUID()}`, last4);
}

function isRedactedApiKeyValue(value) {
  return String(value || '').startsWith(REDACTED_PREFIX);
}

function verifyApiKey(candidate, storedHash) {
  return timingSafeEqualHex(hashApiKey(candidate), storedHash);
}

module.exports = {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  getKeyPrefix,
  getKeyLast4,
  getKeyPreview,
  redactedApiKeyValue,
  temporaryRedactedApiKeyValue,
  isRedactedApiKeyValue,
};
