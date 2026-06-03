#!/usr/bin/env node
/**
 * Awin connector audit script
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies the audit's findings against ACTUAL Awin API response shape.
 * Run when you have a saved Awin credential and want to know which fields
 * the connector reads correctly vs which are speculation.
 *
 * Usage:
 *   AWIN_API_KEY=... AWIN_PUBLISHER_ID=... node scripts/audit-awin.js
 *
 * Or inline:
 *   node scripts/audit-awin.js
 *   (paste credentials when prompted, OR edit the constants below)
 *
 * Outputs: per-finding verdict (REAL BUG / FALSE ALARM / CAN'T VERIFY).
 * No DB writes, no commits — pure read-only probe.
 */

const API_KEY      = process.env.AWIN_API_KEY      || '<paste-api-key>';
const PUBLISHER_ID = process.env.AWIN_PUBLISHER_ID || '<paste-publisher-id>';

const fetch = require('node-fetch');
const BASE = 'https://api.awin.com';

async function main() {
  if (API_KEY.startsWith('<') || PUBLISHER_ID.startsWith('<')) {
    console.error('ERROR: set AWIN_API_KEY and AWIN_PUBLISHER_ID env vars first.');
    console.error('Example: AWIN_API_KEY=abc AWIN_PUBLISHER_ID=12345 node scripts/audit-awin.js');
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' };

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('Awin connector audit — verifying speculation against real API responses');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── 1. Auth probe ──────────────────────────────────────────────────────
  console.log('[1] Auth probe: /publishers/' + PUBLISHER_ID + '/programmes?relationship=joined&limit=5');
  const r = await fetch(`${BASE}/publishers/${PUBLISHER_ID}/programmes?relationship=joined&limit=5`, { headers, timeout: 15000 });
  console.log('    HTTP', r.status);
  if (!r.ok) {
    console.error('    Body:', (await r.text()).slice(0, 500));
    console.error('\nABORT: auth probe failed.');
    process.exit(1);
  }

  const body = await r.json();
  const programmes = Array.isArray(body) ? body : (body.programmes || []);
  console.log('    Programmes returned:', programmes.length);
  if (programmes.length === 0) {
    console.log('\nNo programmes in account — cannot verify field mappings. Stopping.');
    process.exit(0);
  }

  console.log('\n[2] First programme — full keys:');
  const sample = programmes[0];
  console.log('   ', Object.keys(sample).join(', '));

  console.log('\n[3] First programme — pretty-printed (truncated):');
  console.log(JSON.stringify(sample, null, 2).slice(0, 1500));

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('Audit findings — verdict');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── Finding 1: validDomains field for countries ────────────────────────
  console.log('FINDING 1: Connector reads `validDomains` for allowed_countries.');
  if ('validDomains' in sample) {
    console.log('    validDomains exists. Sample value:', JSON.stringify(sample.validDomains).slice(0, 200));
    if (Array.isArray(sample.validDomains)) {
      const twoLetters = sample.validDomains.filter(s => typeof s === 'string' && s.length === 2);
      console.log('    Items with length===2 (current filter):', twoLetters.length, '/', sample.validDomains.length);
      console.log('    Sample items:', sample.validDomains.slice(0, 3).map(s => JSON.stringify(s)).join(', '));
      console.log('    VERDICT:', twoLetters.length > 0 ? 'PASSES audit — current filter works' : '🔴 REAL BUG — current filter drops all validDomains values');
    } else {
      console.log('    validDomains is NOT an array. VERDICT: 🔴 REAL BUG');
    }
  } else {
    console.log('    validDomains field DOES NOT EXIST on Awin programme.');
    console.log('    VERDICT: 🔴 REAL BUG — connector reads non-existent field; allowed_countries always []');
  }

  // Check alternate Awin geo field
  console.log('\nFINDING 1B: Awin may use other fields for country targeting.');
  for (const key of ['regions', 'countries', 'primaryRegion', 'currencyCode', 'geoTargets']) {
    if (key in sample) {
      console.log('    Found alternate field "' + key + '":', JSON.stringify(sample[key]).slice(0, 150));
    }
  }

  // ── Finding 2: commissionRange.value / .default for payout ─────────────
  console.log('\nFINDING 2: Connector reads `commissionRange.value` and `.default` for payout.');
  if ('commissionRange' in sample) {
    console.log('    commissionRange exists:', JSON.stringify(sample.commissionRange).slice(0, 300));
    const cr = sample.commissionRange || {};
    if ('value' in cr || 'default' in cr) {
      console.log('    .value present:', 'value' in cr ? cr.value : '(missing)');
      console.log('    .default present:', 'default' in cr ? cr.default : '(missing)');
      console.log('    VERDICT: PASSES audit — at least one of value/default exists');
    } else {
      console.log('    Neither .value nor .default present. Actual keys:', Object.keys(cr).join(', '));
      console.log('    VERDICT: 🔴 REAL BUG — payout always 0');
    }
  } else {
    console.log('    commissionRange field DOES NOT EXIST.');
    console.log('    VERDICT: 🔴 REAL BUG — connector reads non-existent field; payout always 0');
  }

  // Check alternate Awin commission field
  console.log('\nFINDING 2B: Awin may use other fields for commission.');
  for (const key of ['commission', 'commissionGroups', 'commissionsRange', 'minCommission', 'maxCommission']) {
    if (key in sample) {
      console.log('    Found alternate field "' + key + '":', JSON.stringify(sample[key]).slice(0, 200));
    }
  }

  // ── 4. Pagination check ────────────────────────────────────────────────
  console.log('\nFINDING 3: Pagination — Awin docs mention limit/offset.');
  console.log('    First page returned', programmes.length, 'items with limit=5 query.');
  if (programmes.length === 5) {
    console.log('    Likely a "more pages" scenario — verifying:');
    const r2 = await fetch(`${BASE}/publishers/${PUBLISHER_ID}/programmes?relationship=joined&limit=5&offset=5`, { headers, timeout: 15000 });
    const body2 = await r2.json();
    const programmes2 = Array.isArray(body2) ? body2 : (body2.programmes || []);
    console.log('    Page 2 (offset=5):', programmes2.length, 'items');
    if (programmes2.length > 0) {
      const ids1 = new Set(programmes.map(p => p.id));
      const newOnPage2 = programmes2.filter(p => !ids1.has(p.id)).length;
      console.log('    Items unique to page 2:', newOnPage2);
      console.log('    VERDICT: Pagination', newOnPage2 > 0 ? 'WORKS (need to add loop)' : 'BROKEN (same items returned)');
    } else {
      console.log('    VERDICT: Page 2 empty — either small catalog or offset not supported');
    }
  } else {
    console.log('    VERDICT: Small catalog — pagination loop not critical here');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('Recommendation: review the verdicts above. If "REAL BUG" appears,');
  console.log('that audit finding is confirmed and worth fixing. If "PASSES audit",');
  console.log('the existing connector code is actually correct for your account.');
  console.log('═══════════════════════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('SCRIPT ERROR:', e.message);
  process.exit(1);
});
