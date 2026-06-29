#!/usr/bin/env node
/**
 * loadtest.js — concurrency stress test for /track/smart/:token
 * ─────────────────────────────────────────────────────────────────────────────
 * Spins up a TEMPORARY smart link with one country-unfiltered rule (so dev
 * GeoIP returning "XX" still matches), fires N parallel hits to
 * /track/smart/<token>, then asserts:
 *
 *   1. All N requests return 302 (redirected, no errors)
 *   2. All N clicks landed in the clicks table (no INSERT race losses)
 *   3. p95 latency stays under the budget (default 500ms locally)
 *
 * Always cleans up: deletes the temp smart link + rule + nulls out the
 * loadtest clicks' smart_link_id (so prod stats aren't polluted).
 *
 * Usage:
 *   N=100 node backend/scripts/loadtest.js      # 100 parallel requests
 *   N=500 node backend/scripts/loadtest.js      # heavier load
 *   BASE=http://localhost:3001 N=100 node backend/scripts/loadtest.js
 */
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

// Native fetch follows redirects (or throws on 'manual' in some Node versions).
// We need just the local /track/smart response time, not the downstream
// destination URL. Raw http.get + no follow gives us that.
function getNoFollow(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Spread synthetic visitor IPs across the test so the rate limiter
// (200/min/IP on /track/smart) treats each request as a unique visitor.
function syntheticIp(i) {
  return `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${(i & 0xff) || 1}`;
}

const BASE = process.env.BASE || process.env.PROD || 'http://localhost:3001';
const N = parseInt(process.env.N, 10) || 100;
const P95_BUDGET_MS = parseInt(process.env.P95_BUDGET_MS, 10) || 500;

const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'tracking.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function nanoid12() {
  // Match utils/clickId nanoid12 alphabet to avoid token-format mismatch
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

(async () => {
  // Find an admin user and an active campaign with a destination URL to wire up
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1").get();
  const camp  = db.prepare("SELECT id, user_id FROM campaigns WHERE status='active' AND destination_url != '' LIMIT 1").get();
  if (!admin) { console.error('No active admin user'); process.exit(1); }
  if (!camp)  { console.error('No active campaign with destination URL'); process.exit(1); }

  // Create the temporary smart link + one catch-all rule
  const token = nanoid12();
  const slResult = db.prepare(`
    INSERT INTO smart_links (user_id, name, token, fallback_url, status)
    VALUES (?, ?, ?, '', 'active')
  `).run(admin.id, `LOADTEST: ${new Date().toISOString()}`, token);
  const tempSlId = slResult.lastInsertRowid;

  db.prepare(`
    INSERT INTO smart_link_rules (smart_link_id, campaign_id, priority, weight, country_codes, device_types, os_names)
    VALUES (?, ?, 0, 100, '', '', '')
  `).run(tempSlId, camp.id);

  console.log(`Loadtest: ${N} parallel hits on /track/smart/${token}`);
  console.log(`Temp smart link id=${tempSlId} routing to campaign #${camp.id}`);
  console.log(`Target:  ${BASE}/track/smart/${token}`);
  console.log(`Budget:  p95 < ${P95_BUDGET_MS}ms`);
  console.log('');

  const url = `${BASE}/track/smart/${token}?pid=loadtest&sub1=concurrency`;
  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE smart_link_id = ?').get(tempSlId).n;

  const start = Date.now();
  const latencies = [];
  let success = 0, fail = 0;
  const failureStatuses = {};

  let lastErr = '';
  const promises = Array.from({ length: N }, async (_, i) => {
    const t0 = Date.now();
    try {
      const r = await getNoFollow(url, { 'X-Forwarded-For': syntheticIp(i) });
      const dt = Date.now() - t0;
      latencies.push(dt);
      if (r.status === 302 && r.location) success++;
      else { fail++; failureStatuses[`status_${r.status}`] = (failureStatuses[`status_${r.status}`] || 0) + 1; }
    } catch (e) {
      const dt = Date.now() - t0;
      latencies.push(dt);
      fail++;
      lastErr = e.message || e.code || String(e);
      const key = `err_${e.code || e.message || 'unknown'}`;
      failureStatuses[key] = (failureStatuses[key] || 0) + 1;
    }
  });

  await Promise.all(promises);
  const wallMs = Date.now() - start;

  // Brief settling window for in-flight DB writes
  await new Promise(r => setTimeout(r, 500));
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE smart_link_id = ?').get(tempSlId).n;
  const delta = afterCount - beforeCount;

  // Latency stats
  latencies.sort((a, b) => a - b);
  const pct = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const p50 = pct(0.50), p95 = pct(0.95), p99 = pct(0.99);
  const max = latencies[latencies.length - 1];
  const avg = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);

  console.log(`Wall clock:  ${wallMs}ms`);
  console.log(`Throughput:  ${(N * 1000 / wallMs).toFixed(1)} req/s`);
  console.log(`Status:      ${success}/${N} returned 302 redirect`);
  if (fail > 0) {
    console.log(`Failures:    ${JSON.stringify(failureStatuses)}`);
    if (lastErr) console.log(`Last error:  ${lastErr}`);
  }
  console.log(`Clicks recorded: ${delta}/${N}`);
  console.log('');
  console.log('Latency (ms):');
  console.log(`  avg: ${avg}`);
  console.log(`  p50: ${p50}`);
  console.log(`  p95: ${p95}`);
  console.log(`  p99: ${p99}`);
  console.log(`  max: ${max}`);

  // Cleanup — keep this in finally-like block via explicit catch
  let passing = true;
  try {
    if (success !== N) { console.log(`\n✗ FAIL: ${fail} request(s) did not return 302`); passing = false; }
    if (delta !== N)   { console.log(`\n✗ FAIL: click count mismatch — expected ${N}, recorded ${delta} (INSERT race or buffering)`); passing = false; }
    if (p95 > P95_BUDGET_MS) { console.log(`\n✗ FAIL: p95 ${p95}ms exceeds budget ${P95_BUDGET_MS}ms`); passing = false; }
    if (passing) console.log('\n✓ All clicks recorded, no race losses, p95 within budget');
  } finally {
    // Always cleanup
    db.prepare('UPDATE clicks SET smart_link_id = NULL WHERE smart_link_id = ?').run(tempSlId);
    db.prepare('DELETE FROM smart_link_rules WHERE smart_link_id = ?').run(tempSlId);
    db.prepare('DELETE FROM smart_links WHERE id = ?').run(tempSlId);
    db.close();
    console.log('(cleaned up temp smart link, rules, and click attribution)');
  }

  process.exit(passing ? 0 : 1);
})().catch(e => {
  console.error('\n[fatal]', e);
  process.exit(1);
});
