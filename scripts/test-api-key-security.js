#!/usr/bin/env node
const assert = require('assert');

const {
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
} = require('../utils/apiKeySecurity');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

test('generateApiKey creates prefixed high-entropy keys', () => {
  const key = generateApiKey();
  assert.ok(key.startsWith(API_KEY_PREFIX));
  assert.ok(key.length >= API_KEY_PREFIX.length + 40);
});

test('generated keys are unique', () => {
  const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
  assert.strictEqual(keys.size, 100);
});

test('hashApiKey is deterministic and does not expose plaintext', () => {
  const key = generateApiKey();
  const h1 = hashApiKey(key);
  const h2 = hashApiKey(key);
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
  assert.ok(!h1.includes(key));
});

test('verifyApiKey accepts only matching key/hash pair', () => {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  assert.strictEqual(verifyApiKey(key, hash), true);
  assert.strictEqual(verifyApiKey(key + 'x', hash), false);
});

test('prefix and last4 are display-only metadata', () => {
  const key = 'apg_live_abcdefghijklmnopqrstuvwxyz1234567890';
  assert.strictEqual(getKeyPrefix(key), 'apg_live_abcdef');
  assert.strictEqual(getKeyLast4(key), '7890');
  assert.strictEqual(getKeyPreview(key), 'apg_live_abcdef••••7890');
});

test('legacy key preview supports pre-prefixed historical keys', () => {
  const key = 'AbCdEf1234567890';
  assert.strictEqual(getKeyPrefix(key), 'AbCdEf');
  assert.strictEqual(getKeyLast4(key), '7890');
  assert.strictEqual(getKeyPreview(key), 'AbCdEf••••7890');
});

test('row preview uses stored metadata only', () => {
  assert.strictEqual(getKeyPreview({ api_key_prefix: 'apg_live_abc123', api_key_last4: 'wxyz' }), 'apg_live_abc123••••wxyz');
  assert.strictEqual(getKeyPreview({}), '••••••••');
});

test('redacted placeholders are detectable and do not contain full secret', () => {
  const value = redactedApiKeyValue(42, 'abcd');
  assert.strictEqual(isRedactedApiKeyValue(value), true);
  assert.ok(value.includes('42'));
  assert.ok(value.includes('abcd'));
  assert.strictEqual(isRedactedApiKeyValue('real-secret'), false);
});

test('temporary redacted placeholders are unique', () => {
  const values = new Set(Array.from({ length: 20 }, () => temporaryRedactedApiKeyValue('abcd')));
  assert.strictEqual(values.size, 20);
  for (const value of values) assert.strictEqual(isRedactedApiKeyValue(value), true);
});

if (process.exitCode) {
  console.error(`\n${passed} passed before failure.`);
  process.exit(process.exitCode);
}

console.log(`\n${passed} passed, 0 failed`);
