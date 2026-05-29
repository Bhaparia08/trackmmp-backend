require('dotenv').config();

// Global crash handlers — prevent silent process exits
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { errorHandler } = require('./middleware/errorHandler');

// Initialize DB (creates tables on first run)
require('./db/init');

const app = express();
app.disable('x-powered-by');                          // suppress Express fingerprint
app.set('trust proxy', 1);                            // trust Render/Cloudflare X-Forwarded-* for real client IPs
const server = http.createServer(app);

// Socket.io — in production allow same-origin (Express serves the frontend)
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? true  // same origin — Express serves both frontend and backend on :3001
  : (process.env.FRONTEND_ORIGIN || 'http://localhost:5173');

const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  socket.join(socket.userId.toString());
  socket.on('disconnect', () => {});
});

// Make io available to routes
app.set('io', io);

// ── Security headers (helmet) ────────────────────────────────────────────
// HSTS, X-Content-Type-Options, Referrer-Policy, X-DNS-Prefetch-Control, etc.
// CSP is disabled because the SPA bundle uses inline scripts/styles (vite output)
// — flip it on as a separate hardening PR after the build is CSP-friendly.
// Frameguard set to deny so the admin UI cannot be embedded as an iframe (clickjacking).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,                   // SDK is loaded cross-origin on publisher sites
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: { action: 'deny' },
  hsts: { maxAge: 15552000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ── CORS ─────────────────────────────────────────────────────────────────
// PRIOR BUG: in production, origin was `true` which made the cors library
// reflect any request Origin with Access-Control-Allow-Credentials: true.
// Effectively any third-party site could make credentialed cross-origin
// requests on a logged-in user's behalf.
//
// FIX: explicit allowlist + credentials:false. Authentication on this
// platform is JWT-in-Authorization-header (not cookies), so removing
// credentials closes the exposure without breaking the admin dashboard or
// publisher SDK. Non-allowlisted origins (e.g. publisher sites embedding
// the JS SDK) still receive valid CORS headers — they just can't carry
// cookies cross-origin.
const STRICT_ORIGINS = (process.env.CORS_ORIGINS ||
  'https://track.apogeemobi.com,http://localhost:5173,http://localhost:5180'
).split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);               // curl, server-to-server, mobile native — no Origin header
    if (STRICT_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, true);                            // publisher SDK sites — credentials:false below means no cookie reflection
  },
  credentials: false,
}));

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public tracking endpoints (no auth)
app.use('/track', require('./routes/track'));
app.use('/pixel.gif', require('./routes/pixel'));
app.use('/pb', require('./routes/postbacks'));
app.use('/postbacks', require('./routes/postbacks'));   // friendly alias
app.use('/acquisition', require('./routes/acquisition')); // Trackier-compatible

// IAB Sellers.json — public, declares every publisher we monetize.  Premium
// SSPs (Magnite, PubMatic, OpenX, Google AdX) refuse to monetize supply
// without this file at the root of the seller domain.
app.use('/sellers.json', require('./routes/sellersJson'));

// Adjust-compatible S2S endpoints (no auth — token validated per-request)
app.use('/adjust', require('./routes/adjust'));

// OneLink public resolver (no auth — UA-based device routing)
app.use('/go', require('./routes/go'));

// Authenticated API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/apps', require('./routes/apps'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/publishers', require('./routes/publishers'));
app.use('/api/publisher-payouts', require('./routes/publisherPayouts'));
app.use('/api/inventory',  require('./routes/inventory'));
app.use('/api/placements', require('./routes/placements'));
app.use('/api/inventory-approvals', require('./routes/inventoryApprovals'));
app.use('/api/ads-text',   require('./routes/adsText'));
app.use('/api/sites',      require('./routes/sitesHealth'));
app.use('/api/clicks', require('./routes/clicks'));
app.use('/api/s2s', require('./routes/s2s'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/scheduled-reports', require('./routes/scheduledReports'));
app.use('/api/fraud', require('./routes/fraud'));
app.use('/api/campaigns/:campaign_id/goals',          require('./routes/goals'));
app.use('/api/campaigns/:campaign_id/publisher-caps', require('./routes/publisherCaps'));
app.use('/api/campaigns/:campaign_id/landing-pages',  require('./routes/landingPages'));
app.use('/api/campaigns/:campaign_id/creatives',      require('./routes/creatives'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/publisher', require('./routes/publisher'));
app.use('/api/am', require('./routes/am'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/apikeys', require('./routes/apikeys'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/currency', require('./routes/currency'));

// ── OpenAPI spec + Swagger UI ─────────────────────────────────────────────
// Mounted BEFORE /api/v1 so the spec endpoints don't go through requireApiKey.
//   /api/v1/openapi.yaml — raw spec (for Postman/Insomnia/codegen import)
//   /api/v1/openapi.json — parsed spec
//   /api/docs            — interactive Swagger UI (try-it-out enabled)
//
// Spec lives at backend/openapi.yaml (NOT backend/public/openapi.yaml) so
// that `vite build` with emptyOutDir:true cannot wipe it on every frontend
// deploy. See project_trackmmp_pitfalls.md section 2.
{
  const swaggerUi = require('swagger-ui-express');
  const yaml      = require('js-yaml');
  const specPath  = path.join(__dirname, 'openapi.yaml');
  let spec;
  try {
    spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  } catch (e) {
    console.error('[openapi] failed to load spec:', e.message);
  }
  if (spec) {
    app.get('/api/v1/openapi.json', (_, res) => res.json(spec));
    app.get('/api/v1/openapi.yaml', (_, res) => {
      res.type('text/yaml').sendFile(specPath);
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, {
      customSiteTitle: 'TrackMMP Publisher API — Docs',
      swaggerOptions: { persistAuthorization: true },
    }));
  }
}

// /api/v1/links — programmatic OneLink API (JWT-authed; mounted BEFORE /api/v1
// so it isn't swallowed by the publisher x-api-key middleware on /api/v1).
app.use('/api/v1/links', require('./routes/v1Links'));

app.use('/api/v1', require('./routes/v1'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/campaign-access', require('./routes/campaignAccess'));
app.use('/api/smart-links',    require('./routes/smartLinks'));
app.use('/api/automation',     require('./routes/automation'));
app.use('/api/preview',        require('./routes/preview'));
app.use('/api/plan',           require('./routes/plan'));
app.use('/api/preview',        require('./routes/datascape'));
app.use('/api/preview',        require('./routes/incrementality'));
app.use('/api/preview',        require('./routes/predictedLtv'));
app.use('/api/impact',         require('./routes/impact'));
app.use('/api/invoices',          require('./routes/invoices'));
app.use('/api/insertion-orders',  require('./routes/insertionOrders'));
app.use('/api/alerts',            require('./routes/alerts'));
app.use('/api/postbacks', (req, res, next) => {  // alias: GET /api/postbacks → /api/reports/postbacks
  req.url = '/postbacks' + (req.url === '/' ? '' : req.url);
  require('./routes/reports')(req, res, next);
});
app.use('/skan',                  require('./routes/skan'));
app.use('/api/permissions',       require('./routes/permissions'));
app.use('/api/audit-log',         require('./routes/auditLog'));
app.use('/api/ai',                require('./routes/ai'));
app.use('/api/discovery',         require('./routes/discovery'));
app.use('/api/conversions',       require('./routes/conversionHold'));

// Offer Wall / Campaign Marketplace (public — no auth for GET routes)
app.use('/api/offer-wall', require('./routes/offerWall'));

// ── SDK static files ──────────────────────────────────────────────────────
// Serves backend/sdk/ at /sdk/. This is OUTSIDE backend/public/ so Vite's
// build (which empties backend/public/) doesn't wipe the SDK files.
// CORS Allow-Origin: * so the SDK can be loaded by any website.
app.use('/sdk', express.static(path.join(__dirname, 'sdk'), {
  setHeaders(res, filePath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Automation Rules Engine — runs every 60 seconds ───────────────────────
const { runAutomationRules } = require('./utils/automationEngine');
setInterval(() => {
  try { runAutomationRules(); } catch (e) { console.error('[AutomationEngine]', e.message); }
}, 60 * 1000);

// ── Webhook Retry Worker — runs every 30 seconds ───────────────────────────
const { processWebhookQueue, cleanupOldEntries } = require('./utils/webhookRetry');
setInterval(async () => {
  try { await processWebhookQueue(); } catch (e) { console.error('[WebhookRetry]', e.message); }
}, 30 * 1000);
// Daily cleanup of old delivered/failed entries
setInterval(() => {
  try { cleanupOldEntries(); } catch (e) { console.error('[WebhookCleanup]', e.message); }
}, 24 * 60 * 60 * 1000);

// ── Alert Engine — runs every 2 minutes ───────────────────────────────────
const { runAlertChecks } = require('./utils/alertEngine');
setInterval(() => {
  try { runAlertChecks(io); } catch (e) { console.error('[AlertEngine]', e.message); }
}, 2 * 60 * 1000);

// ── eCPM auction recompute — nightly (every 24h) ─────────────────────────
// Recomputes ecpm_estimate on every approval row from the prior 30 days of
// clicks/impressions/conversions data.  /api/v1/serve uses these scores
// to pick the highest-yielding offer for each impression.
const { recomputeForOwner: recomputeEcpm } = require('./utils/ecpmCalculator');
setInterval(() => {
  try {
    const r = recomputeEcpm(null);  // null = recompute for ALL owners
    console.log(`[EcpmRecompute] updated ${r.updated}/${r.evaluated} approval eCPMs`);
  } catch (e) { console.error('[EcpmRecompute]', e.message); }
}, 24 * 60 * 60 * 1000);

// ── Discovery Hub — scan every 6h, process validation queue every 60s ─────
// Kill switch: set DISCOVERY_HUB_ENABLED=false to disable.
const discoveryEngine = require('./utils/discoveryEngine');
if (discoveryEngine.isEnabled()) {
  // Scan all credentials every 6 hours
  setInterval(async () => {
    try { await discoveryEngine.scanAll(); }
    catch (e) { console.error('[DiscoveryScan]', e.message); }
  }, discoveryEngine.DEFAULT_SCAN_INTERVAL_MS);

  // Drain pending landing-page validations every 60 seconds (10 at a time)
  setInterval(async () => {
    try { await discoveryEngine.processValidationQueue(10); }
    catch (e) { console.error('[DiscoveryValidator]', e.message); }
  }, 60 * 1000);

  const scanMin = Math.round(discoveryEngine.DEFAULT_SCAN_INTERVAL_MS / 60000);
  console.log(`[DiscoveryHub] enabled — scan every ${scanMin}min, validator every 60s`);
} else {
  console.log('[DiscoveryHub] disabled via DISCOVERY_HUB_ENABLED=false');
}

// ── Exchange Rate Refresh — runs once on boot + every 24 hours ──────────────
const { refreshRates } = require('./utils/currencyConverter');
refreshRates().catch(e => console.error('[CurrencyRefresh]', e.message));
setInterval(() => {
  refreshRates().catch(e => console.error('[CurrencyRefresh]', e.message));
}, 24 * 60 * 60 * 1000);

// ── In production, serve the built React frontend from Express ────────────────
// Checks multiple candidate paths in priority order:
//   1. backend/public          (our standard build target)
//   2. backend/frontend/dist   (legacy path)
//   3. ../frontend/dist        (monorepo dev path)
const distCandidates = [
  path.join(__dirname, 'public'),
  path.join(__dirname, 'frontend', 'dist'),
  path.join(__dirname, '..', 'frontend', 'dist'),
];
const frontendDist = distCandidates.find(p => fs.existsSync(path.join(p, 'index.html')));
if (frontendDist) {
  console.log(`Serving frontend from: ${frontendDist}`);
  // Assets (JS/CSS) are content-hashed — long cache is fine
  // index.html must never be cached so users always get the latest bundle
  app.use(express.static(frontendDist, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  // robots.txt — explicitly served so crawlers get plain text instead of
  // the SPA HTML shell. Tracking platforms shouldn't be indexed.
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send([
      'User-agent: *',
      'Disallow: /',
      '',
      '# Public surfaces a crawler might still want:',
      '# Allow: /sellers.json',
      '# Allow: /sdk/v1/apogee.js',
    ].join('\n') + '\n');
  });

  // favicon.ico — return 204 No Content rather than serving the 621-byte
  // SPA shell on every page load. (Real favicon can be added later by
  // dropping the .ico into backend/public/ and adding a sendFile here.)
  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  // Serve standalone HTML pages (not part of React SPA)
  app.get('/publisher-preview.html', (req, res) => {
    res.sendFile(path.join(frontendDist, 'publisher-preview.html'));
  });
  app.get('/domain-integration-guide.html', (req, res) => {
    res.sendFile(path.join(frontendDist, 'domain-integration-guide.html'));
  });
  app.get('/offers', (req, res) => {
    res.sendFile(path.join(frontendDist, 'offers.html'));
  });

  // Unmatched /api/* paths return JSON 404 (not the SPA shell).
  // Without this guard, typos like /api/dashbord, wrong HTTP methods, or
  // missing routes return HTTP 200 with the React index.html, which silently
  // masks misconfiguration and integration bugs (pitfall #5 in the project log).
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found', method: req.method, path: req.originalUrl });
  });

  // All other unmatched GETs → React SPA (client-side routing)
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Apogeemobi TrackMMP running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);

  // Keep-alive ping every 4 minutes — uses custom domain so Render doesn't detect it as self-ping
  if (process.env.NODE_ENV === 'production') {
    const fetch = require('node-fetch');
    // Prefer custom domain (Render can't block external domain pings); fall back to internal URL
    const pingUrl = process.env.KEEPALIVE_URL
      || 'https://track.apogeemobi.com/health';
    setInterval(() => {
      fetch(pingUrl, { headers: { 'User-Agent': 'ApogeeMobiKeepAlive/1.0' } })
        .then(r => r.ok ? null : console.warn(`[keepalive] ${r.status}`))
        .catch(e => console.warn('[keepalive] fetch error:', e.message));
    }, 4 * 60 * 1000); // every 4 minutes
    console.log(`Keep-alive pinging ${pingUrl} every 4 minutes`);
  }
});

// deploy trigger Wed Apr 16 2026 — Publishers tab + campaign access routes
// deploy trigger 2026-05-16T01:34:55Z — Phase 3a routes
