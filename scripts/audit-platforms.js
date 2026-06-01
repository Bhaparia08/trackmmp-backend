#!/usr/bin/env node
/**
 * Platform parity audit
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans all 5 platform registries across backend + frontend and reports any
 * gaps. Run BEFORE declaring a new platform integration "done":
 *
 *   $ node backend/scripts/audit-platforms.js
 *
 * Exits 0 if every real (non-stub, non-MMP) platform is in all 5 registries.
 * Exits 1 if any gap is found — useful in pre-commit hooks or CI.
 *
 * Registries checked:
 *   1. backend/utils/connectors/index.js          (Discovery Hub registry)
 *   2. backend/routes/integrations.js ADAPTERS    (legacy /offer-import fetchers)
 *   3. frontend/src/pages/ApiAccess.jsx           (credential save dropdown)
 *   4. frontend/src/pages/AdvertiserIntegration.jsx (postback wizard tiles)
 *   5. frontend/src/pages/OfferImport.jsx         (offer-fetch tiles)
 *
 * Stub connectors (clickbank, lomadee, shareasale) and MMP-only platforms
 * (adjust, branch) are EXEMPT from the parity requirement — they're tracked
 * in the EXEMPT sets below. Edit those when promoting a stub to real.
 */
const fs = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..', '..');
const BACKEND       = path.join(ROOT, 'backend');
const FRONTEND_SRC  = path.join(ROOT, 'frontend', 'src', 'pages');

// Platforms that aren't expected to live in every UI. Adjust these only when
// a stub becomes a real connector or an MMP gains list_offers capability.
// Rakuten was added 2026-04 as a stub but accumulated 16+ cross-file refs (track.js,
// acquisition.js, campaigns.js, multiple frontend pages) — too invasive to remove
// without a focused refactor. Exempt from parity until a real connector is built.
const STUB_PLATFORMS = new Set(['clickbank', 'lomadee', 'shareasale', 'rakuten']);
const MMP_PLATFORMS  = new Set(['adjust', 'branch']);     // no offer fetch by design
const WEBHOOK_ONLY   = new Set(['custom']);                // operator pushes, no UI tile needed
const EXEMPT_FROM_API_ACCESS_FORM = new Set();             // ones intentionally not in /api-access
const EXEMPT_FROM_OFFER_IMPORT    = new Set([...MMP_PLATFORMS, ...WEBHOOK_ONLY]);
const EXEMPT_FROM_INTEGRATION_TILE = new Set([...STUB_PLATFORMS]);   // stubs don't need full wizard
const EXEMPT_FROM_NATIVE_REGISTRY  = new Set();            // bridge is sufficient

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return ''; }
}

// ── 1. Discovery Hub native registry ────────────────────────────────────────
function discoveryRegistry() {
  const src = read(path.join(BACKEND, 'utils/connectors/index.js'));
  const re  = /^\s+([a-z]+):\s+[A-Z]/gm;
  const out = new Set();
  let m; while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

// ── 2. Legacy /offer-import ADAPTERS map ────────────────────────────────────
function legacyAdapters() {
  const src = read(path.join(BACKEND, 'routes/integrations.js'));
  const match = src.match(/const ADAPTERS\s*=\s*\{([^}]+)\}/);
  if (!match) return new Set();
  const out = new Set();
  const re  = /(\w+):\s*fetch/g;
  let m; while ((m = re.exec(match[1])) !== null) out.add(m[1]);
  return out;
}

// ── 3. ApiAccess form dropdown (PLATFORM_OPTIONS) ───────────────────────────
function apiAccessForm() {
  const src = read(path.join(FRONTEND_SRC, 'ApiAccess.jsx'));
  const match = src.match(/PLATFORM_OPTIONS\s*=\s*\[([\s\S]*?)\];/);
  if (!match) return new Set();
  const out = new Set();
  const re  = /value:\s*['"]([a-z]+)['"]/g;
  let m; while ((m = re.exec(match[1])) !== null) out.add(m[1]);
  return out;
}

// ── 4. AdvertiserIntegration tiles (PLATFORMS object) ───────────────────────
function integrationTiles() {
  const src = read(path.join(FRONTEND_SRC, 'AdvertiserIntegration.jsx'));
  const match = src.match(/const PLATFORMS\s*=\s*\{([\s\S]*?)^\};/m);
  if (!match) return new Set();
  const out = new Set();
  // Top-level keys: name letters at line start with colon + opening brace
  const re = /^\s{2}([a-z_]+):\s*\{/gm;
  let m; while ((m = re.exec(match[1])) !== null) out.add(m[1]);
  return out;
}

// ── 5. OfferImport tiles (PLATFORMS array) ──────────────────────────────────
function offerImportTiles() {
  const src = read(path.join(FRONTEND_SRC, 'OfferImport.jsx'));
  const match = src.match(/const PLATFORMS\s*=\s*\[([\s\S]*?)^\];/m);
  if (!match) return new Set();
  const out = new Set();
  const re = /key:\s*['"]([a-z]+)['"]/g;
  let m; while ((m = re.exec(match[1])) !== null) out.add(m[1]);
  return out;
}

// ── Audit ───────────────────────────────────────────────────────────────────
function audit() {
  const reg     = discoveryRegistry();
  const adapt   = legacyAdapters();
  const apiForm = apiAccessForm();
  const intTile = integrationTiles();
  const offTile = offerImportTiles();

  const allPlatforms = new Set([...reg, ...adapt, ...apiForm, ...intTile, ...offTile]);
  const findings = [];

  for (const p of [...allPlatforms].sort()) {
    const inReg     = reg.has(p);
    const inAdapt   = adapt.has(p);
    const inApiForm = apiForm.has(p);
    const inIntTile = intTile.has(p);
    const inOffTile = offTile.has(p);
    const isStub    = STUB_PLATFORMS.has(p);
    const isMmp     = MMP_PLATFORMS.has(p);
    const isWebhook = WEBHOOK_ONLY.has(p);

    const gaps = [];
    if (!inReg && !EXEMPT_FROM_NATIVE_REGISTRY.has(p) && !inAdapt) {
      gaps.push('Discovery Hub registry (utils/connectors/index.js) + no bridge fallback');
    }
    if (!inApiForm && !EXEMPT_FROM_API_ACCESS_FORM.has(p)) {
      gaps.push('/api-access dropdown (frontend/src/pages/ApiAccess.jsx PLATFORM_OPTIONS)');
    }
    if (!inIntTile && !EXEMPT_FROM_INTEGRATION_TILE.has(p) && !isMmp) {
      gaps.push('/integration page tile (frontend/src/pages/AdvertiserIntegration.jsx PLATFORMS)');
    }
    if (!inOffTile && !EXEMPT_FROM_OFFER_IMPORT.has(p) && !isStub) {
      gaps.push('/offer-import tile (frontend/src/pages/OfferImport.jsx PLATFORMS)');
    }

    const tags = [];
    if (isStub)    tags.push('STUB');
    if (isMmp)     tags.push('MMP');
    if (isWebhook) tags.push('WEBHOOK');
    const tagStr = tags.length ? `  [${tags.join(',')}]` : '';

    findings.push({ platform: p, gaps, tagStr, inReg, inAdapt, inApiForm, inIntTile, inOffTile });
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const ok      = findings.filter(f => f.gaps.length === 0);
  const broken  = findings.filter(f => f.gaps.length > 0);

  console.log('\n═══ Platform parity audit ═══\n');
  console.log('Legend: ✓=present  ✗=missing  ·=exempt by design (stub/MMP/webhook)\n');
  console.log('platform        DiscReg LegAdapt ApiForm IntTile OffTile  tags');
  console.log('────────────────  ────── ──────── ─────── ─────── ───────  ────');
  for (const f of findings) {
    const c = (in_, exempt) => exempt ? '·' : (in_ ? '✓' : '✗');
    const isStub    = STUB_PLATFORMS.has(f.platform);
    const isMmp     = MMP_PLATFORMS.has(f.platform);
    const isWebhook = WEBHOOK_ONLY.has(f.platform);
    console.log(
      f.platform.padEnd(16) + '  ' +
      '   ' + c(f.inReg, false) + '       ' +
      c(f.inAdapt, false) + '       ' +
      c(f.inApiForm, EXEMPT_FROM_API_ACCESS_FORM.has(f.platform)) + '       ' +
      c(f.inIntTile, isMmp || isStub) + '       ' +
      c(f.inOffTile, isMmp || isWebhook || isStub) + '    ' +
      f.tagStr
    );
  }

  console.log('\n─── Summary ───');
  console.log(`  ${ok.length}/${findings.length} platforms have full parity (or exempt)`);
  if (broken.length === 0) {
    console.log('  ✓ All platforms pass — no parity gaps.\n');
    process.exit(0);
  }

  console.log(`  ✗ ${broken.length} platform(s) have gaps:\n`);
  for (const f of broken) {
    console.log(`  ${f.platform}:`);
    for (const g of f.gaps) console.log(`    - missing from ${g}`);
  }
  console.log('\n  Per project_trackmmp_pitfalls.md section 1 (multi-registry trap):');
  console.log('  every new platform must be added to all applicable registries before being');
  console.log('  declared "shipped". Run this script before merging any new connector.\n');
  process.exit(1);
}

audit();
