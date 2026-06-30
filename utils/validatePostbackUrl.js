/**
 * validatePostbackUrl — SSRF-hardening validator for publisher postback URLs.
 *
 * Why this exists: routes/publisher.js PUT /api/publisher/settings persists
 * a `global_postback_url` that the webhook worker fires server-side. Without
 * validation, a publisher can point it at internal services or cloud metadata
 * endpoints (e.g. http://169.254.169.254/). This module rejects URLs that
 * resolve to private/reserved IP space at save time.
 *
 * Caveat (TOCTOU / DNS rebinding): a hostname can resolve clean here and dirty
 * at fire time. Save-time validation blocks the common case and accidental
 * misconfiguration, but the strongest defense is to also re-validate the
 * resolved IP inside the webhook worker before issuing the HTTP request.
 * That fire-time recheck is a documented follow-up (see TODO in
 * utils/webhookRetry.js when that work lands).
 */

const dns = require('dns').promises;
const net = require('net');
const { MACRO_KEYS } = require('./macroReplace');

const MAX_URL_LENGTH = 2048;
const DNS_TIMEOUT_MS = 1500;

// IPv4 ranges that must not be reachable from a server-side fetcher.
const V4_BLOCKED_CIDRS = [
  ['0.0.0.0',       8],   // "this network"
  ['10.0.0.0',      8],   // RFC1918 private
  ['100.64.0.0',   10],   // CGNAT
  ['127.0.0.0',     8],   // loopback
  ['169.254.0.0',  16],   // link-local (includes 169.254.169.254 cloud metadata)
  ['172.16.0.0',   12],   // RFC1918 private
  ['192.0.0.0',    24],   // IETF protocol assignments
  ['192.168.0.0',  16],   // RFC1918 private
  ['198.18.0.0',   15],   // benchmarking
  ['224.0.0.0',     4],   // multicast
  ['240.0.0.0',     4],   // reserved / future use (includes 255.255.255.255)
];

// IPv6 ranges. ::ffff:0:0/96 (IPv4-mapped) is handled by extracting the inner
// v4 and re-running the v4 check, not by listing here.
const V6_BLOCKED = [
  '::',           // unspecified
  '::1',          // loopback
  'fe80::',       // link-local (we only compare the first 10 bits below)
  'fc00::',       // ULA (we only compare the first 7 bits)
  'ff00::',       // multicast (we only compare the first 8 bits)
];

// Hostnames that resolve internally regardless of DNS lookup result.
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.internal', '.local'];
const BLOCKED_HOSTNAMES_EXACT   = new Set(['localhost']);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedV4(ip) {
  const v = ipv4ToInt(ip);
  if (v === null) return false;
  for (const [base, bits] of V4_BLOCKED_CIDRS) {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if ((v & mask) === (ipv4ToInt(base) & mask)) return true;
  }
  return false;
}

// Compare the leading `bits` bits of two IPv6 addresses (given as 16-byte arrays).
function v6PrefixMatch(a, b, bits) {
  let i = 0;
  while (bits >= 8) {
    if (a[i] !== b[i]) return false;
    i++; bits -= 8;
  }
  if (bits === 0) return true;
  const mask = (0xFF << (8 - bits)) & 0xFF;
  return (a[i] & mask) === (b[i] & mask);
}

function v6ToBytes(ip) {
  // Expand :: shorthand, then parse 8 groups of up to 4 hex chars.
  if (!ip || typeof ip !== 'string') return null;
  let s = ip;
  // Strip zone id (fe80::1%en0)
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  // Handle ::ffff:1.2.3.4 — IPv4-mapped form is detected before raw v6 parse.
  if (!s.includes(':')) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (parts.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes[i * 2] = (n >> 8) & 0xFF;
    bytes[i * 2 + 1] = n & 0xFF;
  }
  return bytes;
}

function isBlockedV6(ip) {
  // IPv4-mapped dotted-quad form: ::ffff:a.b.c.d
  const mappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch) return isBlockedV4(mappedMatch[1]);

  const bytes = v6ToBytes(ip);
  if (!bytes) return false;

  // IPv4-mapped compressed form: bytes 0–9 zero, 10–11 are 0xFFFF, 12–15 = v4.
  // node's URL normalizer often rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1,
  // which is the same address but never matches the dotted-quad regex above.
  const v4MappedPrefix = bytes.slice(0, 10).every(b => b === 0)
    && bytes[10] === 0xFF && bytes[11] === 0xFF;
  if (v4MappedPrefix) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isBlockedV4(v4);
  }

  for (const blocked of V6_BLOCKED) {
    const b = v6ToBytes(blocked);
    if (!b) continue;
    let bits;
    if (blocked === '::')      bits = 128;
    else if (blocked === '::1') bits = 128;
    else if (blocked === 'fe80::') bits = 10;
    else if (blocked === 'fc00::') bits = 7;
    else if (blocked === 'ff00::') bits = 8;
    else bits = 128;
    if (v6PrefixMatch(bytes, b, bits)) return true;
  }
  return false;
}

function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return false;
}

function isBlockedHostname(host) {
  const h = host.toLowerCase();
  if (BLOCKED_HOSTNAMES_EXACT.has(h)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some(suf => h === suf.slice(1) || h.endsWith(suf));
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

function extractMacros(url) {
  // Pull every {…} token. We accept word chars + a few separators inside.
  const out = [];
  const re = /\{[^{}]+\}/g;
  let m;
  while ((m = re.exec(url)) !== null) out.push(m[0]);
  return out;
}

/**
 * Validate a publisher-supplied postback URL.
 *
 * Returns { ok: true, normalized } on success or { ok: false, reason } on
 * failure. Empty/blank input is treated as "clear the field" → ok with
 * normalized === ''.
 *
 * @param {string|null|undefined} input
 * @param {object} [opts]
 * @param {boolean} [opts.skipDns=false] — bypass DNS lookup (tests only)
 * @returns {Promise<{ok: true, normalized: string} | {ok: false, reason: string}>}
 */
async function validatePostbackUrl(input, opts = {}) {
  const skipDns = opts.skipDns === true;
  const raw = (input == null ? '' : String(input)).trim();
  if (raw === '') return { ok: true, normalized: '' };

  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds ${MAX_URL_LENGTH} chars` };
  }

  let parsed;
  try { parsed = new URL(raw); }
  catch { return { ok: false, reason: 'URL is malformed' }; }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Protocol "${parsed.protocol}" not allowed — use http or https` };
  }

  // Reject embedded credentials. `http://user:pass@host/` is an SSRF vector
  // (some clients honor it, others don't — best to refuse outright).
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  // Node's URL keeps brackets on IPv6 literals (e.g. parsed.hostname === '[::1]'),
  // and net.isIP rejects bracketed forms — so we strip them before further checks.
  let host = parsed.hostname;
  if (!host) return { ok: false, reason: 'URL has no hostname' };
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (isBlockedHostname(host)) {
    return { ok: false, reason: `Hostname "${host}" is not allowed` };
  }

  // Literal IP in URL — check directly without DNS.
  const ipFam = net.isIP(host);
  if (ipFam !== 0) {
    if (isBlockedIp(host)) {
      return { ok: false, reason: `IP "${host}" is in a blocked range (private/loopback/link-local/reserved)` };
    }
  }

  // Macro whitelist — every {…} token must be in MACRO_KEYS. We scan the full
  // raw URL (not parsed.href) so we catch tokens inside the path AND query
  // exactly as the publisher wrote them.
  const macros = extractMacros(raw);
  for (const m of macros) {
    if (!MACRO_KEYS.has(m)) {
      return { ok: false, reason: `Unknown macro "${m}" — see docs for the allowed macro list` };
    }
  }

  // DNS resolution — only for non-literal hostnames.
  if (!skipDns && ipFam === 0) {
    let addrs;
    try {
      addrs = await withTimeout(
        dns.lookup(host, { all: true, verbatim: true }),
        DNS_TIMEOUT_MS,
        'DNS lookup'
      );
    } catch (err) {
      return { ok: false, reason: `DNS lookup failed for "${host}": ${err.code || err.message}` };
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
      return { ok: false, reason: `DNS returned no addresses for "${host}"` };
    }
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        return { ok: false, reason: `Hostname "${host}" resolves to blocked IP ${a.address}` };
      }
    }
  }

  return { ok: true, normalized: parsed.toString() };
}

module.exports = {
  validatePostbackUrl,
  // Exported for unit tests:
  _isBlockedIp: isBlockedIp,
  _isBlockedHostname: isBlockedHostname,
  _extractMacros: extractMacros,
  MAX_URL_LENGTH,
  DNS_TIMEOUT_MS,
};
