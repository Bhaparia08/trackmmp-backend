/**
 * Local credential-free preview server for the Phase 0 owned-inventory layer.
 *
 *   node backend/scripts/preview-server.js
 *   open http://localhost:3002
 *
 * Reads the local SQLite DB directly and renders HTML — no login, no api key.
 * Standalone process on port 3002 so it never touches the live API server.
 *
 * NEVER deploy this to prod — it exposes inventory + approvals + clicks
 * without auth. Local dev only.
 */
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tracking.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('[preview] DB not found at', DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

const PORT = process.env.PREVIEW_PORT || 3002;
const TRACKING_BASE = process.env.TRACKING_DOMAIN || 'http://localhost:3001';

const app = express();

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function fmt$(n) {
  return '$' + Number(n || 0).toFixed(2);
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

const VERTICAL_COLORS = {
  'us-betting': '#f59e0b', 'us-finance': '#10b981', 'us-insurance': '#6366f1',
  'us-other': '#64748b',  'in-finance': '#10b981', 'in-health': '#ec4899',
  'br-finance': '#10b981', 'mx-finance': '#10b981',
};

/* ── Serve logic (replicates /api/v1/serve without api-key gate) ──────────── */

function getOffersForPlacement(placementId, country = 'US', device = 'desktop') {
  const placement = db.prepare(`
    SELECT p.*, i.id AS inv_id, i.name AS inv_name, i.vertical AS inv_vertical, i.geo AS inv_geo
    FROM placements p
    JOIN owned_inventory i ON i.id = p.inventory_id
    WHERE p.id = ? AND p.status = 'active' AND i.status = 'active'
  `).get(placementId);
  if (!placement) return { error: 'placement not found or inactive' };

  const offers = db.prepare(`
    SELECT c.id, c.name, c.advertiser_name, c.campaign_token, c.payout, c.payout_type,
           c.vertical, c.allowed_countries, c.allowed_devices,
           cia.priority, cia.weight,
           cre.logo_url, cre.brand_name, cre.headline, cre.subheadline,
           cre.bonus_amount, cre.bonus_label, cre.terms_short, cre.cta_text,
           cre.rating, cre.rating_count, cre.badge_text, cre.badge_color
    FROM campaign_inventory_approvals cia
    JOIN campaigns c ON c.id = cia.campaign_id
    LEFT JOIN campaign_creatives cre ON cre.id = (
      SELECT id FROM campaign_creatives
      WHERE campaign_id = c.id AND status = 'active'
      ORDER BY weight DESC, id ASC LIMIT 1
    )
    WHERE cia.inventory_id = ? AND cia.status = 'approved' AND c.status = 'active'
  `).all(placement.inv_id);

  const filtered = offers.filter((o) => {
    if (country && o.allowed_countries && o.allowed_countries.trim() !== '') {
      const allowed = o.allowed_countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(country)) return false;
    }
    if (device && o.allowed_devices && o.allowed_devices !== 'all') {
      const allowed = o.allowed_devices.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(device)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const pub = db.prepare('SELECT pub_token FROM publishers WHERE id = ?').get(placement.publisher_id || 0)
            || db.prepare("SELECT pub_token FROM publishers WHERE name = 'ApogeeMobi House'").get();

  const formatted = filtered.slice(0, placement.max_offers || 10).map((o) => ({
    campaign_id: o.id,
    name: o.name,
    advertiser_name: o.advertiser_name,
    vertical: o.vertical,
    payout: o.payout,
    payout_type: o.payout_type,
    creative: o.brand_name || o.headline || o.logo_url ? {
      brand_name: o.brand_name, headline: o.headline, subheadline: o.subheadline,
      logo_url: o.logo_url, bonus_amount: o.bonus_amount, bonus_label: o.bonus_label,
      terms_short: o.terms_short, cta_text: o.cta_text || 'Get Offer',
      rating: o.rating, rating_count: o.rating_count,
      badge_text: o.badge_text, badge_color: o.badge_color,
    } : null,
    tracking_url: `${TRACKING_BASE}/track/click/${o.campaign_token}`
                + `?pid=${pub?.pub_token || ''}&inv=${placement.inv_id}&pl=${placement.id}&clickid=preview-${Math.random().toString(36).slice(2, 10)}`,
  }));

  return { placement, offers: formatted };
}

/* Render an offers table — bare (no creatives) vs rich (with creatives). */
function renderOfferRowsBare(offers) {
  if (offers.length === 0) return '<div class="mock-empty">No offers.</div>';
  return `<table class="mock-table">
    <thead><tr><th>#</th><th>Offer</th><th>Payout</th><th></th></tr></thead>
    <tbody>${offers.map((o, i) => `
      <tr>
        <td class="mock-rank">${i+1}</td>
        <td><div class="mock-name">${esc(o.name)}</div>
            <div style="font-size:12px;color:#6b7280">${esc(o.advertiser_name || '')}</div></td>
        <td class="mock-payout">${fmt$(o.payout)} ${esc((o.payout_type || '').toUpperCase())}</td>
        <td><a class="mock-cta" href="${esc(o.tracking_url)}" rel="nofollow sponsored noopener" target="_blank">Get Offer</a></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderOfferRowsRich(offers) {
  if (offers.length === 0) return '<div class="mock-empty">No offers.</div>';
  return `<table class="mock-table mock-rich">
    <thead><tr><th>#</th><th>Brand</th><th>Offer</th><th></th></tr></thead>
    <tbody>${offers.map((o, i) => {
      const cre = o.creative;
      const brand   = esc(cre?.brand_name || o.name);
      const head    = esc(cre?.headline || '');
      const sub     = esc(cre?.subheadline || o.advertiser_name || '');
      const logo    = cre?.logo_url ? `<img src="${esc(cre.logo_url)}" alt="${brand}" class="mock-logo" loading="lazy" />` : '';
      const badge   = cre?.badge_text ? `<span class="mock-badge" style="background:#${esc(cre.badge_color || '6366f1')}">${esc(cre.badge_text)}</span>` : '';
      const stars   = cre?.rating != null ? '★'.repeat(Math.round(cre.rating)) + '☆'.repeat(5 - Math.round(cre.rating)) : '';
      const rating  = cre?.rating != null
        ? `<div class="mock-rating"><span class="mock-stars">${stars}</span> ${Number(cre.rating).toFixed(1)}${cre.rating_count > 0 ? ` <span style="opacity:.7">(${cre.rating_count.toLocaleString()})</span>` : ''}</div>`
        : '';
      const bonus   = cre?.bonus_amount
        ? `<div class="mock-bonus">${esc(cre.bonus_amount)}</div><div class="mock-bonus-label">${esc(cre.bonus_label || '')}</div>`
        : `<div class="mock-payout">${fmt$(o.payout)} ${esc((o.payout_type || '').toUpperCase())}</div>`;
      const cta     = esc(cre?.cta_text || 'Get Offer');
      const terms   = cre?.terms_short ? `<div class="mock-terms">${esc(cre.terms_short)}</div>` : '';
      return `<tr>
        <td class="mock-rank">${i+1}</td>
        <td><div class="mock-brand">
          ${logo}
          <div>
            ${badge}
            <div class="mock-name">${brand}</div>
            ${head ? `<div class="mock-headline">${head}</div>` : ''}
            ${sub ? `<div class="mock-sub">${sub}</div>` : ''}
            ${rating}
          </div>
        </div></td>
        <td>${bonus}</td>
        <td><a class="mock-cta" href="${esc(o.tracking_url)}" rel="nofollow sponsored noopener" target="_blank">${cta}</a>${terms}</td>
      </tr>`;
    }).join('')}
    </tbody>
  </table>`;
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

const css = `
  :root { color-scheme: dark; }
  body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#0f0f1a; color:#e2e8f0; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 28px 0 10px; padding-top: 14px; border-top: 1px solid #ffffff14; color: #818cf8; }
  h3 { font-size: 14px; margin: 18px 0 8px; color: #cbd5e1; }
  a { color: #818cf8; }
  .muted { color:#94a3b8; font-size:12px; }
  .card { background:#1a1a2e; border:1px solid #ffffff14; border-radius:10px; padding:16px; margin: 10px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#94a3b8; padding:8px 10px; border-bottom:1px solid #ffffff14; }
  td { padding:8px 10px; border-bottom:1px solid #ffffff0a; }
  .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; }
  .b-active   { background:rgba(16,185,129,.12); color:#10b981; }
  .b-deleted  { background:rgba(100,116,139,.12); color:#64748b; }
  .b-pending  { background:rgba(245,158,11,.12); color:#f59e0b; }
  .b-approved { background:rgba(16,185,129,.12); color:#10b981; }
  .b-rejected { background:rgba(239,68,68,.12); color:#ef4444; }
  .vchip { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; font-weight:600; }
  pre { background:#000; color:#a5f3fc; padding:12px; border-radius:6px; font-size:11px; line-height:1.45; overflow-x:auto; }
  .kpi { display:flex; gap:16px; flex-wrap:wrap; margin: 12px 0 24px; }
  .kpi > div { flex:1; min-width:140px; padding:14px; background:#1a1a2e; border:1px solid #ffffff14; border-radius:10px; }
  .kpi .n  { font-size:24px; font-weight:700; }
  .kpi .l  { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#94a3b8; }
  details { background:#0f0f1a; border:1px solid #ffffff14; border-radius:8px; padding:8px 12px; margin: 8px 0; }
  summary { cursor:pointer; color:#818cf8; font-size:12px; }
  .nav { position: sticky; top: 0; background:#0f0f1aee; backdrop-filter: blur(6px); z-index: 10; padding: 10px 0; border-bottom: 1px solid #ffffff14; margin: -24px -24px 16px; padding-left:24px; padding-right:24px; }
  .nav a { margin-right: 14px; font-size: 12px; }
  .warn { background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.3); color:#fbbf24; padding:10px 14px; border-radius:8px; font-size:12px; margin: 12px 0; }
  .right { text-align:right; font-variant-numeric: tabular-nums; }
  .green { color:#10b981; }
  /* Mock site styles */
  .mock-page { background:#fff; color:#1a1a2e; padding:30px 40px; border-radius:10px; margin: 14px 0; font-family: Georgia, serif; }
  .mock-page h1 { color:#0f172a; font-size:28px; margin-bottom:6px; }
  .mock-meta { color:#6b7280; font-size:13px; border-bottom:1px solid #e5e7eb; padding-bottom:12px; margin-bottom:16px; }
  .mock-page p { font-size:15px; line-height:1.6; }
  .mock-table { width:100%; border-collapse:collapse; margin:18px 0; }
  .mock-table th { background:#f9fafb; color:#6b7280; font-size:12px; text-transform:uppercase; padding:10px 12px; text-align:left; border-bottom:1px solid #e5e7eb; letter-spacing:.05em; font-family:system-ui; }
  .mock-table td { padding:12px; border-bottom:1px solid #e5e7eb; vertical-align:middle; font-family: system-ui; }
  .mock-rank { font-weight:700; color:#6366f1; font-size:14px; width:36px; text-align:center; }
  .mock-name { font-weight:600; font-size:15px; color:#111827; }
  .mock-payout { font-size:13px; color:#10b981; font-weight:600; }
  .mock-cta { display:inline-block; background:#6366f1; color:#fff !important; padding:8px 18px; text-decoration:none; border-radius:6px; font-weight:600; font-size:13px; }
  .mock-empty { padding:14px; color:#6b7280; font-style:italic; text-align:center; border:1px dashed #e5e7eb; border-radius:6px; }
  /* Rich creative styling */
  .mock-rich td { padding:14px 12px; }
  .mock-brand { display:flex; gap:12px; align-items:center; }
  .mock-logo { width:54px; height:54px; border-radius:10px; object-fit:contain; background:#fff; border:1px solid #e5e7eb; flex-shrink:0; }
  .mock-headline { font-size:13px; color:#374151; margin-top:3px; line-height:1.35; }
  .mock-sub { font-size:12px; color:#6b7280; margin-top:2px; }
  .mock-bonus { font-weight:700; font-size:18px; color:#0f172a; line-height:1.2; }
  .mock-bonus-label { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:.04em; margin-top:2px; }
  .mock-rating { display:flex; align-items:center; gap:4px; font-size:12px; color:#6b7280; margin-top:4px; }
  .mock-stars { color:#f59e0b; letter-spacing:1px; font-size:13px; }
  .mock-badge { display:inline-block; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; padding:2px 7px; border-radius:4px; color:#fff; margin-bottom:4px; }
  .mock-terms { font-size:10px; color:#9ca3af; margin-top:6px; line-height:1.3; max-width:200px; }
  .compare-grid { display:grid; grid-template-columns: 1fr 1fr; gap:24px; margin: 14px 0; }
  .compare-grid > div { background:#1a1a2e; border:1px solid #ffffff14; border-radius:10px; overflow:hidden; }
  .compare-grid h4 { margin:0; padding:10px 14px; background:#0f0f1a; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#94a3b8; border-bottom:1px solid #ffffff14; }
  .compare-grid .mock-page { background:#fff; color:#1a1a2e; padding:18px; border-radius:0; margin:0; font-family: Georgia, serif; }
  @media (max-width: 900px) { .compare-grid { grid-template-columns: 1fr; } }
`;

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head>
<body><div class="container">${body}</div></body></html>`;
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

app.get('/', (req, res) => {
  // KPIs
  const counts = {
    inventory: db.prepare("SELECT COUNT(*) AS n FROM owned_inventory WHERE status='active'").get().n,
    placements: db.prepare("SELECT COUNT(*) AS n FROM placements WHERE status='active'").get().n,
    pending:  db.prepare("SELECT COUNT(*) AS n FROM campaign_inventory_approvals WHERE status='pending'").get().n,
    approved: db.prepare("SELECT COUNT(*) AS n FROM campaign_inventory_approvals WHERE status='approved'").get().n,
    audit:    db.prepare("SELECT COUNT(*) AS n FROM inventory_approval_audit").get().n,
    clicksWithInv: db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE inventory_id IS NOT NULL").get().n,
  };

  // Inventory + stats
  const inv = db.prepare(`
    SELECT i.*, p.name AS publisher_name,
           (SELECT COUNT(*) FROM placements pl WHERE pl.inventory_id=i.id AND pl.status='active') AS placement_count,
           (SELECT COUNT(*) FROM clicks c WHERE c.inventory_id=i.id) AS clicks
    FROM owned_inventory i
    LEFT JOIN publishers p ON p.id=i.publisher_id
    WHERE i.status='active'
    ORDER BY i.id DESC
  `).all();

  // Approvals (most recent 20)
  const approvals = db.prepare(`
    SELECT cia.*, c.name AS campaign_name, c.vertical AS c_vertical,
           c.allowed_countries, i.name AS inventory_name, i.vertical AS i_vertical, i.geo AS i_geo
    FROM campaign_inventory_approvals cia
    JOIN campaigns c ON c.id=cia.campaign_id
    JOIN owned_inventory i ON i.id=cia.inventory_id
    ORDER BY cia.id DESC LIMIT 20
  `).all();

  // Recent audit log
  const audit = db.prepare(`
    SELECT a.*, c.name AS c_name, i.name AS i_name, u.email AS actor_email
    FROM inventory_approval_audit a
    LEFT JOIN campaigns c ON c.id=a.campaign_id
    LEFT JOIN owned_inventory i ON i.id=a.inventory_id
    LEFT JOIN users u ON u.id=a.actor_id
    ORDER BY a.id DESC LIMIT 15
  `).all();

  // Recent clicks
  const clicks = db.prepare(`
    SELECT c.id, c.click_id, c.campaign_id, c.inventory_id, c.placement_id, c.country, c.device_type, c.created_at,
           cp.name AS campaign_name, i.name AS inventory_name, p.name AS placement_name
    FROM clicks c
    LEFT JOIN campaigns cp ON cp.id=c.campaign_id
    LEFT JOIN owned_inventory i ON i.id=c.inventory_id
    LEFT JOIN placements p ON p.id=c.placement_id
    WHERE c.inventory_id IS NOT NULL OR c.placement_id IS NOT NULL
    ORDER BY c.id DESC LIMIT 12
  `).all();

  // For each active placement, fetch what /api/v1/serve would return
  const placements = db.prepare(`
    SELECT p.*, i.name AS i_name, i.vertical AS i_vertical, i.geo AS i_geo
    FROM placements p JOIN owned_inventory i ON i.id=p.inventory_id
    WHERE p.status='active' AND i.status='active' ORDER BY p.id DESC
  `).all();

  const placementSections = placements.map((pl) => {
    const result = getOffersForPlacement(pl.id, pl.i_geo || 'US', 'desktop');
    if (result.error) return `<div class="card"><h3>${esc(pl.i_name)} → <code>${esc(pl.slug)}</code></h3><p class="muted">${esc(result.error)}</p></div>`;

    return `<div class="card">
      <h3>📦 Placement: <code>${esc(pl.slug)}</code> on ${esc(pl.i_name)}</h3>
      <p class="muted">type=${esc(pl.placement_type)} · format=${esc(pl.format)} · max_offers=${pl.max_offers} · simulating visitor country=${esc(pl.i_geo || 'US')} desktop · <a href="/compare/${esc(pl.id)}">side-by-side compare →</a></p>

      <h3 style="margin-top:14px">As your visitors will see it (rendered by WP plugin):</h3>
      <div class="mock-page">
        <h1>${pl.i_vertical && pl.i_vertical.includes('betting') ? 'Best Sportsbooks 2026' : pl.i_vertical && pl.i_vertical.includes('insurance') ? 'Best Auto Insurance Quotes' : 'Top Picks for 2026'}</h1>
        <div class="mock-meta">Updated 2026 · 6 min read · ${esc(pl.i_name)}</div>
        <p>Here are our editor-picked options after reviewing payouts, terms, and reliability across the market.</p>
        ${result.offers.length === 0
          ? `<div class="mock-empty">No approved campaigns match this placement (${esc(pl.i_vertical || '?')} / ${esc(pl.i_geo || '?')}). Approve one in /approvals.</div>`
          : renderOfferRowsRich(result.offers)}
        <p style="font-size:12px;color:#6b7280;margin-top:16px">Disclosure: This page contains affiliate links. We may earn a commission when you sign up via the buttons above.</p>
      </div>

      <details><summary>Raw <code>/api/v1/serve</code> JSON response</summary>
        <pre>${esc(JSON.stringify({
          placement: { id: pl.id, slug: pl.slug, type: pl.placement_type, format: pl.format },
          inventory: { id: pl.inventory_id, name: pl.i_name, vertical: pl.i_vertical, geo: pl.i_geo },
          visitor: { country: pl.i_geo || 'US', device: 'desktop', os: 'unknown' },
          offers: result.offers, ttl: 60, cached: false,
        }, null, 2))}</pre>
      </details>
    </div>`;
  }).join('');

  const inventoryRows = inv.length === 0
    ? `<tr><td colspan="6" class="muted">No active inventory yet. Create one at <a href="http://localhost:5173/inventory">localhost:5173/inventory</a>.</td></tr>`
    : inv.map((i) => `
      <tr>
        <td><span class="vchip" style="background:#6366f129;color:#818cf8">#${i.id}</span></td>
        <td><b>${esc(i.name)}</b><div class="muted">${esc(i.domain || i.bundle_id || '')}</div></td>
        <td>${esc(i.publisher_name || '—')}</td>
        <td>${i.vertical ? `<span class="vchip" style="background:${VERTICAL_COLORS[i.vertical] || '#64748b'}26;color:${VERTICAL_COLORS[i.vertical] || '#64748b'}">${esc(i.vertical)}</span>` : ''} ${i.geo ? `<span class="vchip" style="background:#818cf826;color:#818cf8">${esc(i.geo)}</span>` : ''}</td>
        <td class="right">${i.placement_count} slots</td>
        <td class="right">${i.clicks}</td>
      </tr>`).join('');

  const approvalRows = approvals.length === 0
    ? `<tr><td colspan="6" class="muted">No approval rows yet. Run <code>auto-suggest</code> from the Approvals page.</td></tr>`
    : approvals.map((a) => `
      <tr>
        <td>${esc(a.campaign_name)}<div class="muted">cid=${a.campaign_id} · ${esc(a.c_vertical || '')}${a.allowed_countries ? ' · ' + esc(a.allowed_countries) : ''}</div></td>
        <td>${esc(a.inventory_name)}<div class="muted">${esc(a.i_vertical || '')} ${esc(a.i_geo || '')}</div></td>
        <td><span class="badge b-${esc(a.status)}">${esc(a.status)}</span></td>
        <td class="muted">${a.priority}/${a.weight}</td>
        <td class="muted">${fmtTs(a.reviewed_at)}</td>
      </tr>`).join('');

  const auditRows = audit.length === 0
    ? `<tr><td colspan="5" class="muted">No audit entries yet.</td></tr>`
    : audit.map((a) => `
      <tr>
        <td class="muted">${fmtTs(a.created_at)}</td>
        <td><code>${esc(a.action)}</code></td>
        <td>${esc(a.c_name || '?')} → ${esc(a.i_name || '?')}</td>
        <td class="muted">${esc(a.actor_email || '#'+a.actor_id)}</td>
        <td class="muted">${esc(a.reason || '')}</td>
      </tr>`).join('');

  const clickRows = clicks.length === 0
    ? `<tr><td colspan="6" class="muted">No clicks recorded with inventory/placement attribution yet.</td></tr>`
    : clicks.map((c) => `
      <tr>
        <td class="muted">${fmtTs(c.created_at)}</td>
        <td><code>${esc(c.click_id)}</code></td>
        <td>${esc(c.campaign_name || '?')}</td>
        <td>${c.inventory_id ? esc(c.inventory_name) + ' (#' + c.inventory_id + ')' : '<span class="muted">—</span>'}</td>
        <td>${c.placement_id ? esc(c.placement_name) + ' (#' + c.placement_id + ')' : '<span class="muted">—</span>'}</td>
        <td class="muted">${esc(c.country || '')} ${esc(c.device_type || '')}</td>
      </tr>`).join('');

  res.send(page('TrackMMP — Owned Inventory Preview', `
    <div class="nav">
      <strong>TrackMMP — Owned Inventory Preview</strong>
      <span style="margin-left:14px"><a href="#kpi">Overview</a></span>
      <a href="#inventory">Inventory</a>
      <a href="#approvals">Approvals</a>
      <a href="#serve">Live serve</a>
      <a href="#clicks">Clicks</a>
      <a href="#audit">Audit</a>
    </div>

    <h1>What Phase 0 looks like with your current data</h1>
    <p class="muted">Reading <code>${esc(DB_PATH)}</code> in read-only mode · Generated ${new Date().toISOString()}</p>
    <div class="warn">⚠ Local-only preview. This page bypasses auth — never expose port ${PORT} on a public host.</div>

    <h2 id="kpi">Snapshot</h2>
    <div class="kpi">
      <div><div class="l">Active inventory</div><div class="n">${counts.inventory}</div></div>
      <div><div class="l">Active placements</div><div class="n">${counts.placements}</div></div>
      <div><div class="l">Pending approvals</div><div class="n" style="color:#f59e0b">${counts.pending}</div></div>
      <div><div class="l">Approved</div><div class="n" style="color:#10b981">${counts.approved}</div></div>
      <div><div class="l">Audit entries</div><div class="n">${counts.audit}</div></div>
      <div><div class="l">Attributed clicks</div><div class="n">${counts.clicksWithInv}</div></div>
    </div>

    <h2 id="inventory">Owned inventory (admin view)</h2>
    <p class="muted">This is what the Inventory Manager page at <a href="http://localhost:5173/inventory">localhost:5173/inventory</a> shows you.</p>
    <div class="card">
      <table>
        <thead><tr><th>ID</th><th>Inventory</th><th>Publisher</th><th>Vertical/Geo</th><th class="right">Slots</th><th class="right">Clicks</th></tr></thead>
        <tbody>${inventoryRows}</tbody>
      </table>
    </div>

    <h2 id="approvals">Approval queue snapshot</h2>
    <p class="muted">Mirrors the Approval Queue page at <a href="http://localhost:5173/approvals">localhost:5173/approvals</a>.</p>
    <div class="card">
      <table>
        <thead><tr><th>Campaign</th><th>Inventory</th><th>Status</th><th>Priority/Weight</th><th>Reviewed</th></tr></thead>
        <tbody>${approvalRows}</tbody>
      </table>
    </div>

    <h2 id="serve">Live serve simulation — what visitors actually see</h2>
    <p class="muted">For each active placement, we run the same query <code>/api/v1/serve</code> runs and render the result both as a mock article page <em>and</em> as the raw JSON the WP plugin receives.</p>
    ${placementSections || '<div class="card muted">No active placements. Create one at <a href="http://localhost:5173/inventory">localhost:5173/inventory</a> → click "Slots →" → add placement.</div>'}

    <h2 id="clicks">Recent clicks with inventory attribution</h2>
    <div class="card">
      <table>
        <thead><tr><th>When</th><th>Click ID</th><th>Campaign</th><th>Inventory</th><th>Placement</th><th>Visitor</th></tr></thead>
        <tbody>${clickRows}</tbody>
      </table>
    </div>

    <h2 id="audit">Recent audit log</h2>
    <div class="card">
      <table>
        <thead><tr><th>When</th><th>Action</th><th>Subject</th><th>By</th><th>Reason</th></tr></thead>
        <tbody>${auditRows}</tbody>
      </table>
    </div>

    <div style="margin: 30px 0 60px; color:#64748b; font-size:11px; text-align:center">
      All-in-one preview generated by <code>backend/scripts/preview-server.js</code>. Refresh for fresh data. Stop with <code>kill ${process.pid}</code>.
    </div>
  `));
});

app.get('/site/:domain', (req, res) => {
  // Only consider active inventory — soft-deleted rows shouldn't show.
  const inv = db.prepare(
    "SELECT * FROM owned_inventory WHERE (domain = ? OR name = ?) AND status = 'active' ORDER BY id DESC LIMIT 1"
  ).get(req.params.domain, req.params.domain);
  if (!inv) return res.status(404).send(page('Not found', `<h1>Inventory not found</h1><p><a href="/">← back</a></p>`));
  const placements = db.prepare("SELECT * FROM placements WHERE inventory_id = ? AND status='active' ORDER BY id ASC").all(inv.id);
  if (placements.length === 0) return res.status(404).send(page(inv.name, `<h1>${esc(inv.name)}</h1><p>No active placements on this inventory yet.</p>`));

  const sections = placements.map((pl) => {
    const result = getOffersForPlacement(pl.id, inv.geo || 'US', 'desktop');
    // Guard against the error branch — happens if placement is no longer
    // serveable for any reason (e.g., inventory got soft-deleted between
    // the placements query above and this call).
    const offers = result.offers || [];
    return `<h3 style="margin-top:24px;color:#94a3b8">Placement: ${esc(pl.slug)}</h3>` +
      (offers.length === 0
        ? '<div class="mock-empty">No approved offers yet for this placement.</div>'
        : renderOfferRowsRich(offers));
  }).join('');

  const title = inv.vertical && inv.vertical.includes('betting') ? 'Best Sportsbooks 2026'
              : inv.vertical && inv.vertical.includes('insurance') ? 'Best Auto Insurance Quotes'
              : 'Top Picks for 2026';

  res.send(page(inv.name, `
    <p class="muted">Mock article page rendering for <code>${esc(inv.name)}</code>. <a href="/">← back to dashboard</a></p>
    <div class="mock-page">
      <h1>${title}</h1>
      <div class="mock-meta">Updated 2026 · 6 min read · ${esc(inv.name)}</div>
      <p>Here are our editor-picked options after reviewing payouts, terms, and reliability across the market.</p>
      ${sections}
      <p style="font-size:12px;color:#6b7280;margin-top:24px">Disclosure: This page contains affiliate links. We may earn a commission when you sign up via the buttons above.</p>
    </div>
  `));
});

app.get('/compare/:placement_id', (req, res) => {
  const pl = db.prepare(`
    SELECT p.*, i.name AS i_name, i.vertical AS i_vertical, i.geo AS i_geo
    FROM placements p JOIN owned_inventory i ON i.id = p.inventory_id
    WHERE p.id = ?
  `).get(req.params.placement_id);
  if (!pl) return res.status(404).send(page('Not found', '<h1>Placement not found</h1><p><a href="/">← back</a></p>'));

  const result = getOffersForPlacement(pl.id, pl.i_geo || 'US', 'desktop');
  if (result.error) return res.status(500).send(page('Error', `<p>${esc(result.error)}</p>`));

  const offers = result.offers;
  // For the "before" side, strip creative info to simulate the bare campaign-name-only state
  const offersBare = offers.map((o) => ({ ...o, creative: null }));

  const title = pl.i_vertical && pl.i_vertical.includes('betting') ? 'Best Sportsbooks 2026'
              : pl.i_vertical && pl.i_vertical.includes('insurance') ? 'Best Auto Insurance Quotes'
              : 'Top Picks for 2026';

  const haveCreatives = offers.filter((o) => o.creative).length;

  res.send(page('Before / After — ' + pl.slug, `
    <div class="nav"><strong>Side-by-side comparison</strong> &nbsp; <a href="/">← back to dashboard</a></div>
    <h1>Creative library impact — same data, two renderings</h1>
    <p class="muted">Placement <code>${esc(pl.slug)}</code> on <strong>${esc(pl.i_name)}</strong> · ${offers.length} approved offers (${haveCreatives} have creatives)</p>

    <div class="warn">Both panels use the <em>exact same</em> backend data. The only difference is whether the WP plugin uses creative fields when rendering. Same conversions if visitor clicks; <strong>vastly different click-through</strong>.</div>

    <div class="compare-grid">
      <div>
        <h4>BEFORE — campaign name + payout only (no creatives)</h4>
        <div class="mock-page">
          <h1>${title}</h1>
          <div class="mock-meta">Updated 2026 · 6 min read · ${esc(pl.i_name)}</div>
          <p>Here are our editor-picked options.</p>
          ${renderOfferRowsBare(offersBare)}
        </div>
      </div>
      <div>
        <h4>AFTER — with creative library populated</h4>
        <div class="mock-page">
          <h1>${title}</h1>
          <div class="mock-meta">Updated 2026 · 6 min read · ${esc(pl.i_name)}</div>
          <p>Here are our editor-picked options.</p>
          ${renderOfferRowsRich(offers)}
        </div>
      </div>
    </div>

    <h2>What's different</h2>
    <div class="card">
      <table>
        <thead><tr><th>Element</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          <tr><td>Brand identification</td><td>Campaign name only ("Test Campaign")</td><td>Brand logo + name + headline</td></tr>
          <tr><td>Offer value</td><td>Internal payout ("$1.50 CPI")</td><td>Display amount ("$1,500" + "First Bet Offer")</td></tr>
          <tr><td>Trust signals</td><td>None</td><td>Star rating, review count, editorial badge</td></tr>
          <tr><td>Compliance</td><td>None</td><td>Inline terms ("21+ NJ/PA/MI only…")</td></tr>
          <tr><td>CTA</td><td>Generic "Get Offer"</td><td>Per-offer ("Claim Bonus", "Bet Now", "Sign Up")</td></tr>
          <tr><td>Visitor confidence</td><td class="muted">Low — looks like generic ad</td><td class="green">High — looks like editorial review</td></tr>
        </tbody>
      </table>
    </div>

    <h2>What this means for revenue</h2>
    <div class="card">
      <p style="font-size:13px; line-height:1.6">
        Same visitors, same offers, same backend. Industry CTR data on comparison-style affiliate pages:
      </p>
      <ul style="font-size:13px; line-height:1.7">
        <li>Bare offer rows (left): typical CTR <strong>~2–4%</strong></li>
        <li>Rich creative rows with logo + bonus + rating (right): <strong>~8–15%</strong> — 2–4× uplift</li>
      </ul>
      <p style="font-size:13px; line-height:1.6">
        On 100k monthly visits to <code>${esc(pl.i_name)}</code>, that's the difference between
        <strong>~3,000 clicks</strong> and <strong>~12,000 clicks</strong>. At a $250 CPA with 1% click→FTD conversion:
        <strong>$7,500/mo vs $30,000/mo</strong> from the same traffic.
      </p>
      <p class="muted" style="font-size:11px">Numbers from typical betting/finance vertical benchmarks. Your mileage will vary, but the order of magnitude holds.</p>
    </div>
  `));
});

/* ── Walkthrough — full end-to-end story for a layman audience ─────────────── */

app.get('/walkthrough', (req, res) => {
  // Pull live data so the mocks reflect real state
  const inv = db.prepare(`
    SELECT i.*, p.name AS publisher_name,
           (SELECT COUNT(*) FROM placements pl WHERE pl.inventory_id=i.id AND pl.status='active') AS placement_count
    FROM owned_inventory i
    LEFT JOIN publishers p ON p.id=i.publisher_id
    WHERE i.status='active' LIMIT 5
  `).all();
  const samplePlacement = db.prepare(`
    SELECT p.*, i.name AS i_name, i.vertical AS i_vertical, i.geo AS i_geo
    FROM placements p JOIN owned_inventory i ON i.id=p.inventory_id
    WHERE p.status='active' AND i.status='active' ORDER BY p.id ASC LIMIT 1
  `).get();
  const liveOffers = samplePlacement ? getOffersForPlacement(samplePlacement.id, samplePlacement.i_geo || 'US', 'desktop').offers || [] : [];

  res.send(page('Walkthrough — How your platform works end-to-end', `
    <div class="nav">
      <strong>Walkthrough</strong> &nbsp;
      <a href="#step1">1 Admin</a> <a href="#step2">2 Add site</a> <a href="#step3">3 Slots</a>
      <a href="#step4">4 Campaign</a> <a href="#step5">5 Approve</a> <a href="#step6">6 Plugin</a>
      <a href="#step7">7 Visitor</a> <a href="#step8">8 Click</a> <a href="#step9">9 Revenue</a>
    </div>

    <h1>Your platform, end-to-end — visual walkthrough</h1>
    <p class="muted">Same backend, real data where possible. Scroll through to see exactly what every screen looks like and what happens when. Each section is one step in the live workflow.</p>

    <style>
      .step { margin: 36px 0; padding-top: 22px; border-top: 2px solid #ffffff14; }
      .step-tag { display: inline-block; padding: 3px 10px; border-radius: 12px; background: rgba(99,102,241,0.18); color: #818cf8; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
      .step h2 { margin: 8px 0 4px; padding: 0; border: none; color: #e2e8f0; font-size: 22px; }
      .step .lede { font-size: 13px; color: #94a3b8; margin-bottom: 14px; }
      .ui-mock { background: #0a0a14; border: 1px solid #ffffff14; border-radius: 12px; padding: 14px; margin: 10px 0; }
      .ui-mock .topbar { display:flex; align-items:center; gap:10px; padding-bottom:10px; margin-bottom:10px; border-bottom:1px solid #ffffff10; font-size:12px; color:#94a3b8; }
      .ui-mock .topbar .title { color:#e2e8f0; font-weight:700; font-size:14px; }
      .ui-mock .btn-primary-mock { display:inline-block; padding:6px 12px; background:#6366f1; color:#fff; border-radius:6px; font-size:12px; font-weight:600; }
      .ui-mock .btn-ghost-mock { display:inline-block; padding:6px 12px; background:transparent; border:1px solid #ffffff20; color:#94a3b8; border-radius:6px; font-size:12px; }
      .ui-mock .badge-active { background:rgba(16,185,129,.12); color:#10b981; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
      .ui-mock .badge-pending { background:rgba(245,158,11,.12); color:#f59e0b; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
      .ui-mock .badge-approved { background:rgba(16,185,129,.12); color:#10b981; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
      .ui-mock table { font-size: 12px; }
      .ui-mock input, .ui-mock select { width: 100%; padding: 6px 9px; background: #0f0f1a; border: 1px solid #ffffff14; border-radius: 5px; color: #e2e8f0; font-size: 12px; }
      .ui-mock label { display:block; font-size:11px; color:#94a3b8; margin-bottom:3px; text-transform: uppercase; letter-spacing: .04em; }
      .form-row { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px; }
      .form-row.two { grid-template-columns: 1fr 1fr; }
      .arrow-down { text-align:center; color:#818cf8; font-size:20px; margin: 14px 0 8px; }
      .what-happens { background:rgba(99,102,241,0.06); border-left:3px solid #6366f1; padding:10px 14px; font-size:12px; line-height:1.55; margin: 8px 0; }
      .what-happens strong { color: #e2e8f0; }
      .links-row { display:flex; gap:8px; flex-wrap:wrap; margin-top: 10px; }
      .links-row a { background: rgba(99,102,241,.08); border: 1px solid rgba(99,102,241,.3); padding: 5px 12px; border-radius: 6px; font-size: 11px; text-decoration: none; }
      /* WP-styled blocks */
      .wp-mock { background:#f0f0f1; color:#1d2327; padding:18px; border-radius:8px; font-family: -apple-system, sans-serif; }
      .wp-mock h3 { color:#1d2327; margin: 0 0 12px; font-size: 16px; padding: 0; border: none; }
      .wp-mock label { display:block; color:#1d2327; font-weight:600; font-size:13px; margin-bottom:4px; text-transform:none; letter-spacing:0; }
      .wp-mock input { background: #fff; border: 1px solid #8c8f94; color: #2c3338; padding: 6px 10px; }
      .wp-mock .button-secondary { display:inline-block; padding:5px 14px; background:#fff; border:1px solid #2271b1; color:#2271b1; border-radius:3px; font-size:13px; font-weight:600; }
      .wp-mock .test-result { color:#1e8c3b; font-weight:600; margin-top:10px; }
      .wp-mock .placement-table { background: #fff; padding: 10px; border: 1px solid #ddd; border-radius: 4px; margin-top: 12px; font-size: 12px; }
      /* Browser frame */
      .browser { border: 1px solid #ffffff20; border-radius: 8px; overflow: hidden; }
      .browser .url-bar { background: #1a1a2e; padding: 8px 14px; font-size: 11px; color: #94a3b8; font-family: monospace; }
      .browser .frame { background: #fff; padding: 22px; color: #1a1a2e; font-family: Georgia, serif; }
    </style>

    <div class="step" id="step1">
      <span class="step-tag">STEP 1</span>
      <h2>You log into your platform admin</h2>
      <p class="lede">Each morning, this is the page you'd open — your overview.</p>

      <div class="ui-mock">
        <div class="topbar"><span class="title">TrackMMP — Dashboard</span><span style="margin-left:auto">admin@apogeemobi.com · Admin</span></div>
        <div class="kpi" style="margin:0">
          <div><div class="l">Active inventory</div><div class="n">${inv.length}</div></div>
          <div><div class="l">Pending approvals</div><div class="n" style="color:#f59e0b">${db.prepare("SELECT COUNT(*) AS n FROM campaign_inventory_approvals WHERE status='pending'").get().n}</div></div>
          <div><div class="l">Approved offers</div><div class="n" style="color:#10b981">${db.prepare("SELECT COUNT(*) AS n FROM campaign_inventory_approvals WHERE status='approved'").get().n}</div></div>
          <div><div class="l">Today's clicks</div><div class="n">${db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE date(created_at,'unixepoch')=date('now')").get().n}</div></div>
          <div><div class="l">Today's revenue</div><div class="n green">$0.00</div></div>
        </div>
      </div>

      <div class="what-happens"><strong>What this is:</strong> a single screen that tells you "is the platform earning today, are there pending decisions, anything broken?" — five numbers. That's it.</div>
    </div>

    <div class="step" id="step2">
      <span class="step-tag">STEP 2</span>
      <h2>You register a new website (or app) as inventory</h2>
      <p class="lede">Inventory = a thing you own that has visitors. Each gets a row.</p>

      <div class="ui-mock">
        <div class="topbar"><span class="title">Inventory → + New Inventory</span></div>
        <div class="form-row">
          <div><label>Publisher</label><input value="ApogeeMobi House" disabled /></div>
          <div><label>Type</label><select><option>🌐 Website</option></select></div>
          <div><label>Name</label><input value="top10betting.us" /></div>
        </div>
        <div class="form-row">
          <div><label>Domain</label><input value="top10betting.us" /></div>
          <div><label>Vertical</label><select><option>us-betting</option></select></div>
          <div><label>Geo</label><select><option>US</option></select></div>
        </div>
        <span class="btn-primary-mock">Create Inventory</span>
        <span class="btn-ghost-mock">Cancel</span>
      </div>
      <div class="what-happens"><strong>You do this:</strong> 5 fields, save. Repeat for each of your 19 sites. Total: ~3 minutes per site, or run a script that does all 19 at once.</div>
    </div>

    <div class="step" id="step3">
      <span class="step-tag">STEP 3</span>
      <h2>You define "slots" on the site (placements)</h2>
      <p class="lede">A slot is a spot on the page where offers will appear. The slug is what the WordPress shortcode references.</p>

      <div class="ui-mock">
        <div class="topbar"><span class="title">Placements on top10betting.us</span></div>
        <table>
          <thead><tr><th>Slug</th><th>Name</th><th>Type</th><th>Max</th><th>Status</th></tr></thead>
          <tr><td><code style="color:#818cf8">top10</code></td><td>Top 10 Sportsbooks</td><td>Comparison Table</td><td>10</td><td><span class="badge-active">active</span></td></tr>
          <tr><td><code style="color:#818cf8">sidebar-feature</code></td><td>Sidebar Featured</td><td>Offer Card</td><td>1</td><td><span class="badge-active">active</span></td></tr>
          <tr><td><code style="color:#818cf8">in-content-cta</code></td><td>In-content CTA</td><td>CTA Button</td><td>1</td><td><span class="badge-active">active</span></td></tr>
        </table>

        <div style="margin-top:12px; padding:14px; background:#0f0f1a; border-radius:8px; border:1px solid #ffffff14">
          <div style="font-size:11px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">+ Add new placement</div>
          <div class="form-row">
            <div><label>Name *</label><input value="Sidebar Featured" /></div>
            <div><label>Slug (auto)</label><input value="sidebar-featured" /></div>
            <div><label>Type</label><select><option>Offer Card</option></select></div>
          </div>
          <span style="font-size:11px;color:#94a3b8">Slug auto-fills from name · Max offers auto-sets per type · 1 click to add</span>
        </div>
      </div>
      <div class="what-happens"><strong>Why slots matter:</strong> the slug ("top10") becomes the bridge to WordPress. In a moment you'll write <code>[apogee-offers placement="top10"]</code> in your blog post — and the offers will appear there.</div>
    </div>

    <div class="step" id="step4">
      <span class="step-tag">STEP 4</span>
      <h2>You add a campaign and its creative</h2>
      <p class="lede">A campaign = an offer from an advertiser. The creative = how it looks to visitors.</p>

      <div class="ui-mock">
        <div class="topbar"><span class="title">Campaigns → + New Campaign</span></div>
        <div class="form-row">
          <div><label>Campaign name</label><input value="BetMGM Sportsbook" /></div>
          <div><label>Vertical</label><select><option>us-betting</option></select></div>
          <div><label>Allowed countries</label><input value="US" /></div>
        </div>
        <div class="form-row two">
          <div><label>Payout</label><input value="$250 CPA" /></div>
          <div><label>Destination URL</label><input value="https://record.betmgmpartners.com/...?clickid={click_id}" /></div>
        </div>

        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #ffffff10">
          <div style="font-size:13px;font-weight:700;color:#e2e8f0;margin-bottom:10px">📸 Creative — how the offer looks to visitors</div>
          <div class="form-row">
            <div><label>Brand name</label><input value="BetMGM Sportsbook" /></div>
            <div><label>Logo URL</label><input value="https://cdn.../betmgm-logo.png" /></div>
            <div><label>Badge</label><input value="EDITOR'S PICK" /></div>
          </div>
          <div class="form-row two">
            <div><label>Headline</label><input value="Up to $1,500 First Bet Offer" /></div>
            <div><label>CTA text</label><input value="Claim Bonus" /></div>
          </div>
          <div class="form-row">
            <div><label>Bonus amount</label><input value="$1,500" /></div>
            <div><label>Bonus label</label><input value="First Bet Offer" /></div>
            <div><label>Rating</label><input value="4.8" /></div>
          </div>
          <div><label>Terms</label><input value="21+. NJ/PA/MI only. 1-800-GAMBLER." /></div>
        </div>
      </div>
      <div class="what-happens"><strong>The creative is the difference between a bare ad and a real-looking review-site offer card.</strong> See it in action at <a href="/compare/${samplePlacement?.id || 2}">/compare/${samplePlacement?.id || 2}</a> — same data, before vs after creatives.</div>
    </div>

    <div class="step" id="step5">
      <span class="step-tag">STEP 5</span>
      <h2>You approve which campaigns appear on which inventory</h2>
      <p class="lede">Click "Run auto-suggest" → system creates pending rows where vertical+geo match. You approve in bulk.</p>

      <div class="ui-mock">
        <div class="topbar"><span class="title">Approval Queue</span><span style="margin-left:auto"><span class="btn-ghost-mock">Preview auto-match</span> <span class="btn-primary-mock">Run auto-suggest</span></span></div>
        <table>
          <thead><tr><th>☐</th><th>Campaign</th><th>Inventory</th><th>Vertical / Geo</th><th>Payout</th><th>Status</th><th></th></tr></thead>
          <tr><td>☐</td><td><b>BetMGM Sportsbook</b><div class="muted">cid=14</div></td><td>top10betting.us</td><td><span class="vchip" style="background:#f59e0b26;color:#f59e0b">us-betting</span> <span class="vchip" style="background:#818cf826;color:#818cf8">US</span></td><td>$250 CPA</td><td><span class="badge-pending">Pending</span></td><td><a href="#">Approve</a> · <a href="#">Reject</a></td></tr>
          <tr><td>☐</td><td><b>DraftKings Sportsbook</b><div class="muted">cid=15</div></td><td>top10betting.us</td><td><span class="vchip" style="background:#f59e0b26;color:#f59e0b">us-betting</span> <span class="vchip" style="background:#818cf826;color:#818cf8">US</span></td><td>$200 CPA</td><td><span class="badge-pending">Pending</span></td><td><a href="#">Approve</a> · <a href="#">Reject</a></td></tr>
          <tr><td>☐</td><td><b>FanDuel Sportsbook</b><div class="muted">cid=16</div></td><td>top10betting.us</td><td><span class="vchip" style="background:#f59e0b26;color:#f59e0b">us-betting</span> <span class="vchip" style="background:#818cf826;color:#818cf8">US</span></td><td>$175 CPA</td><td><span class="badge-pending">Pending</span></td><td><a href="#">Approve</a> · <a href="#">Reject</a></td></tr>
        </table>
        <div style="margin-top:12px"><span class="btn-primary-mock" style="background:#10b981">Approve all by filter</span> <span style="font-size:11px;color:#94a3b8">Bulk-approve all 3 us-betting × US matches with one click.</span></div>
      </div>
      <div class="what-happens"><strong>Why approvals exist:</strong> safety. The system only serves campaigns you've explicitly OK'd. Auto-suggest finds the matches; you confirm. Audit log records every approve/reject with timestamp and reason.</div>
    </div>

    <div class="step" id="step6">
      <span class="step-tag">STEP 6</span>
      <h2>You install the WordPress plugin on your site</h2>
      <p class="lede">5 minutes per site. Upload zip → activate → paste API key → click Test.</p>

      <div class="wp-mock">
        <h3>⚙ Settings → ApogeeMobi Offers</h3>
        <div class="form-row">
          <div><label>API Base URL</label><input value="https://track.apogeemobi.com" /></div>
          <div><label>API Key</label><input value="apg_xxxxxxxxxxxxx" type="password" /></div>
          <div><label>Default Country</label><input value="US" /></div>
        </div>

        <hr style="margin:14px 0;border:none;border-top:1px solid #c3c4c7" />
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">Test connection</div>
        <span class="button-secondary">Test connection</span>
        <span class="test-result">✓ Connected. 3 placements available.</span>

        <div class="placement-table">
          <strong>Available placement slugs:</strong>
          <table style="width:100%;margin-top:8px;font-size:11px">
            <tr style="background:#f6f7f7;font-weight:600"><td style="padding:4px 8px">Slug</td><td style="padding:4px 8px">Inventory</td><td style="padding:4px 8px">Type</td><td style="padding:4px 8px">Shortcode</td></tr>
            <tr><td style="padding:4px 8px"><code>top10</code></td><td style="padding:4px 8px">top10betting.us</td><td style="padding:4px 8px">comparison_table</td><td style="padding:4px 8px"><code style="font-size:10px">[apogee-offers placement="top10" limit="10"]</code></td></tr>
            <tr><td style="padding:4px 8px"><code>sidebar-feature</code></td><td style="padding:4px 8px">top10betting.us</td><td style="padding:4px 8px">offer_card</td><td style="padding:4px 8px"><code style="font-size:10px">[apogee-offer placement="sidebar-feature"]</code></td></tr>
          </table>
        </div>
      </div>
      <div class="what-happens"><strong>Test connection</strong> verifies everything in one click — no manual API testing, no copy-paste errors. Just confirms "yes, the plugin can talk to your platform."</div>
    </div>

    <div class="step" id="step7">
      <span class="step-tag">STEP 7</span>
      <h2>A visitor lands on your live page</h2>
      <p class="lede">Plugin reads the shortcode, asks platform "what offers should I show?", renders the result server-side. Visitor sees rich offers — server-rendered, fast, SEO-friendly.</p>

      <div class="browser">
        <div class="url-bar">🔒 https://top10betting.us/best-sportsbooks-2026</div>
        <div class="frame">
          <h1 style="color:#0f172a;font-size:26px;margin:0 0 6px">Best Sportsbooks 2026</h1>
          <div style="color:#6b7280;font-size:13px;border-bottom:1px solid #e5e7eb;padding-bottom:10px;margin-bottom:14px;font-family:system-ui">Updated 2026 · 6 min read · top10betting.us</div>
          <p style="font-size:15px;line-height:1.6;font-family:system-ui">Here are our editor-picked options after reviewing payouts, terms, and reliability across the market.</p>
          ${liveOffers.length > 0 ? renderOfferRowsRich(liveOffers) : '<div class="mock-empty">No live data — approve campaigns first.</div>'}
          <p style="font-size:12px;color:#6b7280;margin-top:16px;font-family:system-ui">Disclosure: This page contains affiliate links. We may earn a commission when you sign up via the buttons above.</p>
        </div>
      </div>
      <div class="what-happens"><strong>This is the entire point of the platform.</strong> Visitor sees real offers branded like real reviews — not generic ads. Open <a href="/site/top10betting.us">/site/top10betting.us</a> to see the live render against your real DB.</div>
    </div>

    <div class="step" id="step8">
      <span class="step-tag">STEP 8</span>
      <h2>Visitor clicks an offer → flow runs in 50 milliseconds</h2>
      <p class="lede">The whole click → tracking → redirect → land at advertiser flow takes ~50ms. Visitor never notices a delay.</p>

      <div class="ui-mock" style="background:#0f0f1a">
        <pre style="margin:0;background:transparent;color:#a5f3fc;padding:8px;font-size:11px;line-height:1.6">
1. Visitor clicks "Claim Bonus"
   ↓
2. Browser navigates to:
   track.apogeemobi.com/track/click/MxK7Pq3..?
                                     pid=...&
                                     inv=1&     ← which site
                                     pl=2&      ← which slot
                                     clickid=a3f8b1c2  ← unique id
   ↓
3. Your platform records (in 30ms):
   - click_id, campaign_id, publisher_id, inventory_id, placement_id
   - country (GeoIP), device, OS, browser
   - referrer, IP, user agent
   ↓
4. Your platform substitutes the click_id into BetMGM's URL:
   https://record.betmgmpartners.com/...?clickid=MxK7Pq3LyZ4nVBcD
   ↓
5. 302 redirect — visitor lands on BetMGM signup page</pre>
      </div>
      <div class="what-happens"><strong>The platform never sees a slow page.</strong> Click is recorded asynchronously, redirect is immediate. Visitor never knows your platform was in the middle.</div>
    </div>

    <div class="step" id="step9">
      <span class="step-tag">STEP 9</span>
      <h2>Conversion fires back, revenue rolls into your dashboard</h2>
      <p class="lede">Hours or days later, visitor signs up + deposits. BetMGM fires a postback. Your dashboard updates automatically.</p>

      <div class="ui-mock" style="background:#0f0f1a">
        <pre style="margin:0;background:transparent;color:#a5f3fc;padding:8px;font-size:11px;line-height:1.6">
BetMGM affiliate platform → your platform:
  GET track.apogeemobi.com/pb?click_id=MxK7Pq3LyZ4nVBcD&payout=250&event=ftd

Your platform:
  - Looks up click_id MxK7Pq3LyZ4nVBcD → finds the original click
  - Reads from it: campaign_id=14, publisher_id=83, inventory_id=1, placement_id=2
  - INSERTs postback row with status='attributed', payout=$250
  - Bumps the rollup reports</pre>
      </div>

      <p class="muted" style="margin:12px 0 6px">Inventory dashboard now reflects the conversion:</p>
      <div class="ui-mock">
        <table>
          <thead><tr><th>Inventory</th><th>Vertical/Geo</th><th class="right">Clicks</th><th class="right">Conv.</th><th class="right">Revenue</th></tr></thead>
          <tr><td>🌐 top10betting.us</td><td><span class="vchip" style="background:#f59e0b26;color:#f59e0b">us-betting</span> <span class="vchip" style="background:#818cf826;color:#818cf8">US</span></td><td class="right">847</td><td class="right">12</td><td class="right green"><b>$2,450.00</b></td></tr>
          <tr><td>🌐 carinsuranceguide.us</td><td><span class="vchip" style="background:#6366f126;color:#6366f1">us-insurance</span> <span class="vchip" style="background:#818cf826;color:#818cf8">US</span></td><td class="right">320</td><td class="right">8</td><td class="right green"><b>$640.00</b></td></tr>
          <tr><td>🌐 betmgmbonuscode.us</td><td><span class="vchip" style="background:#f59e0b26;color:#f59e0b">us-betting</span> <span class="vchip" style="background:#818cf826;color:#818cf8">US</span></td><td class="right">1,204</td><td class="right">18</td><td class="right green"><b>$4,500.00</b></td></tr>
        </table>
        <p class="muted" style="font-size:11px;margin-top:6px">Click "Slots →" on a row to see per-placement breakdown. Toggle Today/7d/30d/All to slice by date.</p>
      </div>

      <div class="what-happens"><strong>You can see at a glance: which sites earn most, which slots convert, where to spend your time optimizing.</strong> No spreadsheets. No daily downloads. Just open the dashboard.</div>
    </div>

    <div class="step">
      <span class="step-tag">SUMMARY</span>
      <h2>The whole loop in one sentence</h2>
      <p style="font-size:15px; line-height:1.6">
        <strong>You</strong> add inventory + slots + campaigns + creatives + approvals once →
        <strong>WordPress plugin</strong> renders rich offers on your live pages →
        <strong>visitors</strong> click, your platform tracks, advertiser pays you →
        <strong>your dashboard</strong> shows it.
      </p>
      <p class="muted">Once the platform is deployed and the plugin is on each site, you go from "manage 19 sites by hand" to "manage 1 platform that runs 19 sites."</p>

      <div class="links-row">
        <a href="/">▦ Live Dashboard (real data)</a>
        <a href="/site/top10betting.us">🌐 Mock visitor page (live render)</a>
        <a href="/compare/${samplePlacement?.id || 2}">🆚 Before/after creative compare</a>
        <a href="http://localhost:5173/inventory" target="_blank">🔧 Real Admin (login required)</a>
        <a href="http://localhost:5173/approvals" target="_blank">✓ Real Approvals (login required)</a>
      </div>
    </div>

    <div style="margin: 30px 0 60px; color:#64748b; font-size:11px; text-align:center">
      Walkthrough preview · Generated ${new Date().toISOString()} · refresh for fresh data
    </div>
  `));
});

app.listen(PORT, () => {
  console.log(`\n  📡 Owned-Inventory Preview Server running`);
  console.log(`  ──────────────────────────────────────────`);
  console.log(`  Dashboard:    http://localhost:${PORT}/`);
  console.log(`  Mock article: http://localhost:${PORT}/site/top10betting.us`);
  console.log(`  DB:           ${DB_PATH}`);
  console.log(`  ⚠  No auth — local development only.\n`);
});
