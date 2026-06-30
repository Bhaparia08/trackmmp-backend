#!/usr/bin/env node
/**
 * No-dependency unit tests for utils/validatePostbackUrl.
 * Run:  node scripts/test-validate-postback-url.js
 *
 * Tests fall into two groups:
 *   - Offline cases (skipDns:true) — exhaustive coverage of parse, protocol,
 *     hostname, literal IP, macro, length checks.
 *   - Online cases (DNS enabled) — a handful of representative cases that
 *     exercise the resolver. Skipped automatically when --no-dns is passed
 *     or when DNS lookup of a known public hostname fails (CI may be offline).
 */
const assert = require('node:assert/strict');
const dns = require('node:dns').promises;
const {
  validatePostbackUrl,
  _isBlockedIp,
  _isBlockedHostname,
  _extractMacros,
  MAX_URL_LENGTH,
} = require('../utils/validatePostbackUrl');

let pass = 0, fail = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    pass++; results.push(['✓', name]);
  } catch (err) {
    fail++; results.push(['✗', name, err.message]);
  }
}

async function expectOk(input, opts = { skipDns: true }) {
  const r = await validatePostbackUrl(input, opts);
  assert.equal(r.ok, true, `expected ok, got reason: ${r.reason}`);
  return r;
}

async function expectFail(input, expectedReasonFragment, opts = { skipDns: true }) {
  const r = await validatePostbackUrl(input, opts);
  assert.equal(r.ok, false, `expected fail, got ok with normalized: ${r.normalized}`);
  if (expectedReasonFragment) {
    assert.ok(
      r.reason.includes(expectedReasonFragment),
      `reason "${r.reason}" did not include "${expectedReasonFragment}"`
    );
  }
}

// ── IP-range helpers ──────────────────────────────────────────────────────────
async function ipTests() {
  await check('isBlockedIp: 127.0.0.1 → true', () => assert.equal(_isBlockedIp('127.0.0.1'), true));
  await check('isBlockedIp: 127.255.255.254 → true', () => assert.equal(_isBlockedIp('127.255.255.254'), true));
  await check('isBlockedIp: 10.0.0.1 → true', () => assert.equal(_isBlockedIp('10.0.0.1'), true));
  await check('isBlockedIp: 172.16.0.1 → true', () => assert.equal(_isBlockedIp('172.16.0.1'), true));
  await check('isBlockedIp: 172.31.255.255 → true', () => assert.equal(_isBlockedIp('172.31.255.255'), true));
  await check('isBlockedIp: 172.32.0.1 → false', () => assert.equal(_isBlockedIp('172.32.0.1'), false));
  await check('isBlockedIp: 192.168.1.1 → true', () => assert.equal(_isBlockedIp('192.168.1.1'), true));
  await check('isBlockedIp: 169.254.169.254 → true (AWS metadata)', () => assert.equal(_isBlockedIp('169.254.169.254'), true));
  await check('isBlockedIp: 100.64.0.1 → true (CGNAT)', () => assert.equal(_isBlockedIp('100.64.0.1'), true));
  await check('isBlockedIp: 224.0.0.1 → true (multicast)', () => assert.equal(_isBlockedIp('224.0.0.1'), true));
  await check('isBlockedIp: 8.8.8.8 → false (public)', () => assert.equal(_isBlockedIp('8.8.8.8'), false));
  await check('isBlockedIp: 1.1.1.1 → false (public)', () => assert.equal(_isBlockedIp('1.1.1.1'), false));
  await check('isBlockedIp: ::1 → true (v6 loopback)', () => assert.equal(_isBlockedIp('::1'), true));
  await check('isBlockedIp: fe80::1 → true (v6 link-local)', () => assert.equal(_isBlockedIp('fe80::1'), true));
  await check('isBlockedIp: fc00::1 → true (v6 ULA)', () => assert.equal(_isBlockedIp('fc00::1'), true));
  await check('isBlockedIp: ff02::1 → true (v6 multicast)', () => assert.equal(_isBlockedIp('ff02::1'), true));
  await check('isBlockedIp: 2001:db8::1 → false (v6 doc range, intentionally allowed by our list)',
    () => assert.equal(_isBlockedIp('2001:db8::1'), false));
  await check('isBlockedIp: ::ffff:127.0.0.1 → true (IPv4-mapped)',
    () => assert.equal(_isBlockedIp('::ffff:127.0.0.1'), true));
  await check('isBlockedIp: ::ffff:8.8.8.8 → false (mapped public)',
    () => assert.equal(_isBlockedIp('::ffff:8.8.8.8'), false));
  await check('isBlockedIp: not-an-ip → false', () => assert.equal(_isBlockedIp('not-an-ip'), false));
}

// ── Hostname helpers ──────────────────────────────────────────────────────────
async function hostnameTests() {
  await check('isBlockedHostname: localhost → true', () => assert.equal(_isBlockedHostname('localhost'), true));
  await check('isBlockedHostname: foo.localhost → true', () => assert.equal(_isBlockedHostname('foo.localhost'), true));
  await check('isBlockedHostname: api.internal → true', () => assert.equal(_isBlockedHostname('api.internal'), true));
  await check('isBlockedHostname: printer.local → true', () => assert.equal(_isBlockedHostname('printer.local'), true));
  await check('isBlockedHostname: example.com → false', () => assert.equal(_isBlockedHostname('example.com'), false));
  await check('isBlockedHostname: LOCALHOST → true (case-insensitive)', () => assert.equal(_isBlockedHostname('LOCALHOST'), true));
}

// ── Macro extraction ──────────────────────────────────────────────────────────
async function macroTests() {
  await check('extractMacros: none', () => assert.deepEqual(_extractMacros('https://x.com/cb?a=1'), []));
  await check('extractMacros: single', () => assert.deepEqual(_extractMacros('https://x.com/cb?id={click_id}'), ['{click_id}']));
  await check('extractMacros: multiple', () => assert.deepEqual(
    _extractMacros('https://x.com/cb?id={click_id}&p={payout}&e={event}'),
    ['{click_id}', '{payout}', '{event}']
  ));
  await check('extractMacros: nested braces (treated as single token, will fail whitelist later)',
    () => assert.deepEqual(_extractMacros('https://x.com/cb?id={broken'), []));
}

// ── Full validator: offline cases ─────────────────────────────────────────────
async function offlineValidatorTests() {
  await check('empty string → ok (clears field)', async () => {
    const r = await expectOk('');
    assert.equal(r.normalized, '');
  });
  await check('null → ok (clears field)', async () => {
    const r = await expectOk(null);
    assert.equal(r.normalized, '');
  });
  await check('undefined → ok (clears field)', async () => {
    const r = await expectOk(undefined);
    assert.equal(r.normalized, '');
  });
  await check('whitespace-only → ok (clears field)', async () => {
    const r = await expectOk('   ');
    assert.equal(r.normalized, '');
  });

  await check('valid https → ok', () => expectOk('https://example.com/cb'));
  await check('valid http → ok', () => expectOk('http://example.com/cb'));
  await check('valid https with allowed macros → ok',
    () => expectOk('https://example.com/cb?clickid={click_id}&payout={payout}&event={event}'));
  await check('valid https with sub1-10 macros → ok',
    () => expectOk('https://example.com/cb?s1={sub1}&s5={sub5}&s10={sub10}'));

  await check('malformed → fail', () => expectFail('not a url', 'malformed'));
  await check('protocol ftp → fail', () => expectFail('ftp://example.com/cb', 'not allowed'));
  await check('protocol file → fail', () => expectFail('file:///etc/passwd', 'not allowed'));
  await check('protocol javascript → fail', () => expectFail('javascript:alert(1)', 'not allowed'));
  await check('protocol gopher → fail', () => expectFail('gopher://example.com/', 'not allowed'));
  await check('protocol dict → fail', () => expectFail('dict://example.com/', 'not allowed'));

  await check('embedded credentials → fail', () => expectFail('http://user:pass@example.com/', 'credentials'));

  await check('localhost → fail', () => expectFail('http://localhost/cb', 'not allowed'));
  await check('api.internal → fail', () => expectFail('http://api.internal/cb', 'not allowed'));
  await check('printer.local → fail', () => expectFail('http://printer.local/cb', 'not allowed'));

  await check('IP 127.0.0.1 → fail', () => expectFail('http://127.0.0.1/cb', 'blocked range'));
  await check('IP 10.0.0.1 → fail', () => expectFail('http://10.0.0.1/cb', 'blocked range'));
  await check('IP 192.168.1.1 → fail', () => expectFail('http://192.168.1.1/cb', 'blocked range'));
  await check('IP 169.254.169.254 (AWS metadata) → fail', () => expectFail('http://169.254.169.254/latest/meta-data/', 'blocked range'));
  await check('IP 100.64.0.1 (CGNAT) → fail', () => expectFail('http://100.64.0.1/cb', 'blocked range'));
  await check('IPv6 [::1] → fail', () => expectFail('http://[::1]/cb', 'blocked range'));
  await check('IPv6 [fe80::1] → fail', () => expectFail('http://[fe80::1]/cb', 'blocked range'));
  await check('IPv6 [::ffff:127.0.0.1] → fail', () => expectFail('http://[::ffff:127.0.0.1]/cb', 'blocked range'));

  await check('IP 8.8.8.8 (public) → ok', () => expectOk('http://8.8.8.8/cb'));
  await check('IP 1.1.1.1 (public) → ok', () => expectOk('http://1.1.1.1/cb'));

  await check('unknown macro {evil} → fail', () => expectFail('https://example.com/cb?x={evil}', 'Unknown macro'));
  await check('unknown macro {publisher_id} (not in macroReplace) → fail',
    () => expectFail('https://example.com/cb?p={publisher_id}', 'Unknown macro'));
  await check('valid macro {pub_id} → ok',
    () => expectOk('https://example.com/cb?p={pub_id}'));

  const longUrl = 'https://example.com/cb?p=' + 'a'.repeat(MAX_URL_LENGTH);
  await check(`length > ${MAX_URL_LENGTH} → fail`, () => expectFail(longUrl, 'exceeds'));
}

// ── Online cases (best-effort) ────────────────────────────────────────────────
async function onlineValidatorTests() {
  // Probe DNS so we can skip cleanly on offline runners.
  let online = false;
  try {
    await dns.lookup('one.one.one.one', { all: true });
    online = true;
  } catch { /* offline */ }

  if (!online) {
    results.push(['~', 'DNS-dependent tests SKIPPED (resolver unreachable)']);
    return;
  }

  await check('public hostname with DNS → ok',
    () => expectOk('https://one.one.one.one/cb', { skipDns: false }));
  await check('nonexistent TLD → fail',
    () => expectFail('https://this-host-should-not-exist.invalid-tld-zzz/', 'DNS lookup failed', { skipDns: false }));
}

(async () => {
  await ipTests();
  await hostnameTests();
  await macroTests();
  await offlineValidatorTests();
  await onlineValidatorTests();

  for (const r of results) {
    if (r[0] === '✓') console.log(`  ${r[0]}  ${r[1]}`);
    else if (r[0] === '~') console.log(`  ${r[0]}  ${r[1]}`);
    else console.log(`  ${r[0]}  ${r[1]}\n     → ${r[2]}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
