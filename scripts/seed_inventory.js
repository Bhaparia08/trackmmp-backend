#!/usr/bin/env node
/**
 * Bulk-register the ApogeeMobi 19-site portfolio as inventory + placements.
 *
 *   node backend/scripts/seed_inventory.js              # dry run (default — safe)
 *   node backend/scripts/seed_inventory.js --apply      # actually write
 *   node backend/scripts/seed_inventory.js --apply --target=local
 *   node backend/scripts/seed_inventory.js --apply --target=prod
 *
 * Idempotent — re-running is safe. Existing inventory rows (matched by
 * domain) are skipped; existing placements (matched by slug) are skipped.
 *
 * Default mode is DRY RUN. The script prints what WOULD be created without
 * touching the DB. Pass --apply to actually write.
 *
 * Authentication: the script either logs in via admin email+password OR uses
 * a JWT passed via APG_TOKEN env var. Credentials come from env, not flags,
 * to avoid leaking them in shell history.
 */

const path = require('path');
const fs   = require('fs');

// ─── PORTFOLIO ────────────────────────────────────────────────────────────────
// Each site's vertical, geo, and the placement slots we'd create on day one.
// Edit this list before --apply if anything is wrong.
const SITES = [
  // USA Betting (4) — branded promo-code domains use offer_card hero;
  //                    comparison sites use comparison_table.
  {
    domain: 'betmgmbonuscode.us',     vertical: 'us-betting',  geo: 'US',
    placements: [
      { name: 'Hero Promo Card',      type: 'offer_card' },
      { name: 'In-content CTA',       type: 'cta' },
    ],
  },
  {
    domain: 'draftkingspromocode.us', vertical: 'us-betting',  geo: 'US',
    placements: [
      { name: 'Hero Promo Card',      type: 'offer_card' },
      { name: 'In-content CTA',       type: 'cta' },
    ],
  },
  {
    domain: 'top10betting.us',        vertical: 'us-betting',  geo: 'US',
    placements: [
      { name: 'Top 10 Sportsbooks',   type: 'comparison_table' },
      { name: 'Sidebar Featured',     type: 'offer_card' },
    ],
  },
  {
    domain: 'top20betting.us',        vertical: 'us-betting',  geo: 'US',
    placements: [
      { name: 'Top 20 Sportsbooks',   type: 'comparison_table' },
      { name: 'Sidebar Featured',     type: 'offer_card' },
    ],
  },

  // USA Finance (2)
  {
    domain: 'cashonnow.us',           vertical: 'us-finance',  geo: 'US',
    placements: [
      { name: 'Top Loan Offers',      type: 'comparison_table' },
      { name: 'In-content CTA',       type: 'cta' },
    ],
  },
  {
    domain: 'zerointerestshop.us',    vertical: 'us-finance',  geo: 'US',
    placements: [
      { name: 'Top BNPL Offers',      type: 'comparison_table' },
    ],
  },

  // USA Insurance (3)
  {
    domain: 'carinsuranceguide.us',   vertical: 'us-insurance', geo: 'US',
    placements: [
      { name: 'Top Insurance Quotes', type: 'comparison_table' },
      { name: 'Sidebar Featured',     type: 'offer_card' },
    ],
  },
  {
    domain: 'insurancepick.us',       vertical: 'us-insurance', geo: 'US',
    placements: [
      { name: 'Top Insurance Quotes', type: 'comparison_table' },
    ],
  },
  {
    domain: 'autoinsuranceguide.us',  vertical: 'us-insurance', geo: 'US',
    placements: [
      { name: 'Top Auto Quotes',      type: 'comparison_table' },
    ],
  },

  // USA Other (1)
  {
    domain: 'aftermint.us',           vertical: 'us-other',    geo: 'US',
    placements: [
      { name: 'Featured Offer',       type: 'offer_card' },
    ],
  },

  // India (2)
  {
    domain: 'creditdost.in',          vertical: 'in-finance',  geo: 'IN',
    placements: [
      { name: 'Top Credit Cards',     type: 'comparison_table' },
      { name: 'Sidebar Featured',     type: 'offer_card' },
    ],
  },
  {
    domain: 'doctorreviews.in',       vertical: 'in-health',   geo: 'IN',
    placements: [
      { name: 'Featured Offer',       type: 'offer_card' },
    ],
  },

  // Brazil (3)
  {
    domain: 'quizfinanceiro.com',           vertical: 'br-finance', geo: 'BR',
    placements: [
      { name: 'Resultado Recomendado',      type: 'offer_card' },
    ],
  },
  {
    domain: 'simuladorinvestimento.com.br', vertical: 'br-finance', geo: 'BR',
    placements: [
      { name: 'Top Investimentos',          type: 'comparison_table' },
    ],
  },
  {
    domain: 'quantorendeinvestimento.com',  vertical: 'br-finance', geo: 'BR',
    placements: [
      { name: 'Top Investimentos',          type: 'comparison_table' },
    ],
  },

  // Mexico (4)
  {
    domain: 'compraydespues.com',     vertical: 'mx-finance', geo: 'MX',
    placements: [
      { name: 'Top BNPL Mexico',      type: 'comparison_table' },
    ],
  },
  {
    domain: 'llegamas.com',           vertical: 'mx-finance', geo: 'MX',
    placements: [
      { name: 'Top Loan Offers',      type: 'comparison_table' },
    ],
  },
  {
    domain: 'tusicuro.com',           vertical: 'mx-finance', geo: 'MX',
    placements: [
      { name: 'Top Loan Offers',      type: 'comparison_table' },
    ],
  },
  {
    domain: 'sincreditoburo.com',     vertical: 'mx-finance', geo: 'MX',
    placements: [
      { name: 'Top Subprime Offers',  type: 'comparison_table' },
    ],
  },
];

// ─── ARGS ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY  = args.includes('--apply');
const TARGET = (args.find((a) => a.startsWith('--target=')) || '--target=local').split('=')[1];

const BASE = TARGET === 'prod'
  ? (process.env.APG_PROD_URL  || 'https://track.apogeemobi.com')
  : (process.env.APG_LOCAL_URL || 'http://127.0.0.1:3001');

console.log('\n  📦 ApogeeMobi inventory seed');
console.log('  ───────────────────────────────────────────');
console.log('  Mode:    ' + (APPLY ? '⚡ APPLY (writes to DB)' : '🔍 DRY RUN (no changes)'));
console.log('  Target:  ' + TARGET + ' → ' + BASE);
console.log('  Sites:   ' + SITES.length);
console.log('');

(async () => {
  // Slug helper — must match backend/routes/placements.js
  const slugify = (s) => String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token = process.env.APG_TOKEN;
  if (!token) {
    const email    = process.env.APG_ADMIN_EMAIL    || 'admin@test.com';
    const password = process.env.APG_ADMIN_PASSWORD || 'admin123';
    console.log(`  → Logging in as ${email}…`);
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!loginRes.ok) {
      console.error(`  ✗ Login failed (HTTP ${loginRes.status})`);
      process.exit(1);
    }
    token = (await loginRes.json()).token;
  }
  const auth = { Authorization: `Bearer ${token}` };

  // ── Existing inventory (so we can skip dupes) ─────────────────────────────
  const existingInv = await fetch(`${BASE}/api/inventory`, { headers: auth }).then((r) => r.json());
  const byDomain = new Map(existingInv.map((i) => [i.domain || i.name, i]));

  let created = 0, skipped = 0, plCreated = 0, plSkipped = 0, errors = 0;

  for (const site of SITES) {
    let inv = byDomain.get(site.domain);
    if (inv) {
      console.log(`  · skip      ${site.domain.padEnd(32)} (already inventory id=${inv.id})`);
      skipped++;
    } else if (!APPLY) {
      console.log(`  + DRY RUN   ${site.domain.padEnd(32)} → would create (${site.vertical} / ${site.geo})`);
      created++;
      // dummy id for dry run placement preview
      inv = { id: '?', name: site.domain };
    } else {
      // Look up House publisher id (best effort)
      const pubs = await fetch(`${BASE}/api/publishers`, { headers: auth }).then((r) => r.json()).catch(() => []);
      const housePub = pubs.find((p) => p.name === 'ApogeeMobi House');
      if (!housePub) {
        console.error('  ✗ ApogeeMobi House publisher not found on target — aborting');
        process.exit(1);
      }
      const res = await fetch(`${BASE}/api/inventory`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publisher_id: housePub.id,
          type:    'website',
          name:    site.domain,
          domain:  site.domain,
          vertical:site.vertical,
          geo:     site.geo,
        }),
      });
      if (!res.ok) {
        console.error(`  ✗ create failed for ${site.domain}: HTTP ${res.status}`);
        errors++;
        continue;
      }
      inv = await res.json();
      console.log(`  + created   ${site.domain.padEnd(32)} → inventory id=${inv.id}`);
      created++;
    }

    // Placements
    if (!site.placements || site.placements.length === 0) continue;
    const existingPl = inv.id !== '?'
      ? await fetch(`${BASE}/api/placements?inventory_id=${inv.id}`, { headers: auth })
          .then((r) => r.json()).catch(() => [])
      : [];
    const existingSlugs = new Set(existingPl.map((p) => p.slug));

    for (const pl of site.placements) {
      const slug = slugify(pl.name);
      if (existingSlugs.has(slug)) {
        console.log(`     · skip   slot ${slug.padEnd(28)} (exists)`);
        plSkipped++;
        continue;
      }
      if (!APPLY) {
        console.log(`     + DRY    slot ${slug.padEnd(28)} (${pl.type})`);
        plCreated++;
        continue;
      }
      const res = await fetch(`${BASE}/api/placements`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventory_id:   inv.id,
          name:           pl.name,
          placement_type: pl.type,
          // slug + max_offers are filled in by server-side smart defaults
        }),
      });
      if (!res.ok) {
        console.error(`     ✗ slot ${slug} failed: HTTP ${res.status}`);
        errors++;
        continue;
      }
      const created_pl = await res.json();
      console.log(`     + created slot ${created_pl.slug.padEnd(28)} (id=${created_pl.id})`);
      plCreated++;
    }
  }

  console.log('\n  ───────────────────────────────────────────');
  console.log(`  Inventory:   ${created} ${APPLY ? 'created' : 'would create'} · ${skipped} skipped`);
  console.log(`  Placements:  ${plCreated} ${APPLY ? 'created' : 'would create'} · ${plSkipped} skipped`);
  if (errors > 0) console.log(`  ⚠ Errors:    ${errors}`);
  if (!APPLY) console.log('\n  Re-run with --apply to actually write.\n');
  else console.log('\n  ✓ Done.\n');

  process.exit(errors > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\n  ✗ Unexpected error:', err.message);
  process.exit(1);
});
