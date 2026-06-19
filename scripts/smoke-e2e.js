#!/usr/bin/env node
/**
 * smoke-e2e.js — authed end-to-end smoke test for the programmatic surface
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies the click → attribution chain works end-to-end with real DB writes.
 * Uses the dev-only /api/dev/preview-token endpoint to bootstrap an admin
 * session and the /api/dev/smart-test-click endpoint to simulate a click
 * through the smart-link engine. Pairs with smoke-prod.sh (boundary checks);
 * this script complements it with authed flow validation.
 *
 * Usage:
 *   PROD=http://localhost:3001 node backend/scripts/smoke-e2e.js
 *
 * Default target: http://localhost:3001. Will only run against localhost
 * because the dev token minter is loopback-only by design.
 *
 * Exits 0 on success, 1 on any regression.
 */
const BASE = process.env.PROD || 'http://localhost:3001';

const failures = [];
let pass = 0;

function ok(desc) { console.log(`  ✓ ${desc}`); pass++; }
function fail(desc, detail) { console.log(`  ✗ ${desc}${detail ? ` — ${detail}` : ''}`); failures.push(`${desc}${detail ? ` (${detail})` : ''}`); }

async function assertStatus(method, path, expected, init = {}) {
  try {
    const r = await fetch(`${BASE}${path}`, { method, ...init });
    if (r.status === expected) { ok(`${method} ${path} → ${r.status}`); return r; }
    fail(`${method} ${path}`, `expected ${expected}, got ${r.status}`);
    return r;
  } catch (e) {
    fail(`${method} ${path}`, `network error: ${e.message}`);
    return null;
  }
}

async function mintToken() {
  const r = await fetch(`${BASE}/api/dev/preview-token`);
  if (r.status !== 200) throw new Error(`token mint failed: HTTP ${r.status}`);
  const { token, user } = await r.json();
  if (!token) throw new Error('token mint returned no token');
  return { token, user };
}

async function authed(method, path, token, body) {
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, init);
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

(async () => {
  console.log(`E2E smoke against ${BASE}\n`);

  console.log('[1] Dev token mint');
  let token;
  try {
    const t = await mintToken();
    token = t.token;
    ok(`mint token for ${t.user.email}`);
  } catch (e) {
    fail('mint dev token', e.message);
    console.log('\nCannot continue without token. Aborting.');
    process.exit(1);
  }

  console.log('\n[2] Authed reads — programmatic core');
  const inv = await authed('GET', '/api/inventory', token);
  if (inv.status === 200 && Array.isArray(inv.body)) ok(`GET /api/inventory → ${inv.body.length} rows`);
  else fail('GET /api/inventory', `status=${inv.status}`);

  const sls = await authed('GET', '/api/smart-links', token);
  if (sls.status === 200 && Array.isArray(sls.body)) ok(`GET /api/smart-links → ${sls.body.length} rows`);
  else fail('GET /api/smart-links', `status=${sls.status}`);

  const counts = await authed('GET', '/api/smart-links/inventory-approval-counts', token);
  if (counts.status === 200 && Array.isArray(counts.body)) ok(`GET inventory-approval-counts → ${counts.body.length} inventories with approvals`);
  else fail('GET inventory-approval-counts', `status=${counts.status}`);

  const camps = await authed('GET', '/api/campaigns', token);
  if (camps.status === 200 && Array.isArray(camps.body)) ok(`GET /api/campaigns → ${camps.body.length} rows`);
  else fail('GET /api/campaigns', `status=${camps.status}`);

  const reports = await authed('GET', '/api/reports/summary', token);
  if (reports.status === 200 && reports.body && typeof reports.body === 'object') ok(`GET /api/reports/summary → ${JSON.stringify(reports.body).length}b`);
  else fail('GET /api/reports/summary', `status=${reports.status}`);

  console.log('\n[3] Smart-link engine — pick an inventory-linked smart link');
  const slLinked = (sls.body || []).find(s => s.inventory_id && s.status === 'active');
  if (!slLinked) {
    fail('inventory-linked smart link', 'none found — Generate one via /preview/smart-links first');
  } else {
    ok(`inventory-linked smart link: id=${slLinked.id} token=${slLinked.token} rules=${slLinked.rule_count}`);

    console.log('\n[4] Money path — simulate click via dev sandbox');
    const tc = await authed('POST', `/api/dev/smart-test-click/${slLinked.token}`, token, { country: 'US', device_type: 'desktop', slot: 'smoke-e2e' });
    if (tc.status !== 200) {
      fail('POST /api/dev/smart-test-click', `status=${tc.status}`);
    } else if (!tc.body?.matched) {
      fail('smart-test-click matched', `no rule matched (${tc.body?.reason || 'unknown'})`);
    } else {
      ok(`click matched campaign #${tc.body.campaign_id} (${tc.body.campaign_name})`);
      if (tc.body.click_id) ok(`click_id issued: ${tc.body.click_id.slice(0, 10)}…`);
      else fail('click_id issued', 'missing from response');
      if (tc.body.destination_url) {
        if (tc.body.destination_url.includes(tc.body.click_id)) ok('macro {click_id} expanded in destination URL');
        else fail('macro {click_id} expansion', 'click_id not present in destination URL');
      } else {
        fail('destination_url returned', 'missing from response');
      }
    }

    console.log('\n[5] Aggregator + optimizer');
    const agg = await authed('POST', `/api/smart-links/${slLinked.id}/aggregate-stats`, token, {});
    if (agg.status === 200 && typeof agg.body?.rolled_up === 'number') ok(`aggregate-stats → ${agg.body.rolled_up} segment rows`);
    else fail('aggregate-stats', `status=${agg.status}`);

    const opt = await authed('POST', `/api/smart-links/${slLinked.id}/optimize-weights`, token, { apply: false });
    if (opt.status === 200 && Array.isArray(opt.body?.rules)) {
      ok(`optimize-weights (dry) → ${opt.body.rules.length} rules, platform_avg_epc=$${opt.body.platform_avg_epc}`);
      // Verify exploration floor invariant: no proposed_weight below 10% of base_weight
      const floorViolations = opt.body.rules.filter(r => r.base_weight > 0 && r.proposed_weight < r.base_weight * 0.1);
      if (floorViolations.length === 0) ok('exploration floor respected (no rule below 10% of base)');
      else fail('exploration floor', `${floorViolations.length} rule(s) below 10% of base`);
      // Verify ceiling invariant: no proposed_weight above 10× base_weight
      const ceilViolations = opt.body.rules.filter(r => r.base_weight > 0 && r.proposed_weight > r.base_weight * 10);
      if (ceilViolations.length === 0) ok('exploration ceiling respected (no rule above 10× base)');
      else fail('exploration ceiling', `${ceilViolations.length} rule(s) above 10× base`);
    } else {
      fail('optimize-weights', `status=${opt.status}`);
    }
  }

  console.log('\n[6] /track/smart redirect engine — invalid token must 404');
  await assertStatus('GET', '/track/smart/INVALID_TOKEN_FOR_TEST', 404);

  console.log('\n[7] /pb postback — must always 200 (always-200 contract)');
  await assertStatus('GET', '/pb', 200);
  await assertStatus('GET', '/pb?click_id=nonexistent', 200);

  console.log('\n[8] /preview-go demo route');
  // Valid-looking token → 302 to /track/smart/...
  const pgValid = await fetch(`${BASE}/preview-go/abc123XYZ?pid=smoke`, { redirect: 'manual' });
  if (pgValid.status === 302) ok('GET /preview-go/<valid> → 302');
  else fail('GET /preview-go/<valid>', `expected 302, got ${pgValid.status}`);
  // Garbage token → 400
  await assertStatus('GET', '/preview-go/!!!INVALID!!!', 400);

  console.log('\n────────────────────────────────────────────────────');
  if (failures.length === 0) {
    console.log(`✓ ${pass}/${pass} E2E checks passed`);
    process.exit(0);
  } else {
    console.log(`✗ ${failures.length} regression(s) found out of ${pass + failures.length} checks:`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exit(1);
  }
})().catch(e => {
  console.error('\n[fatal]', e);
  process.exit(1);
});
