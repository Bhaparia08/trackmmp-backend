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
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { errorHandler } = require('./middleware/errorHandler');

// Initialize DB (creates tables on first run)
require('./db/init');

const app = express();
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

// Middleware
const corsOrigin = process.env.NODE_ENV === 'production' ? true : (process.env.FRONTEND_ORIGIN || 'http://localhost:5173');
app.use(cors({ origin: corsOrigin, credentials: true }));
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

// Authenticated API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/apps', require('./routes/apps'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/publishers', require('./routes/publishers'));
app.use('/api/inventory',  require('./routes/inventory'));
app.use('/api/placements', require('./routes/placements'));
app.use('/api/inventory-approvals', require('./routes/inventoryApprovals'));
app.use('/api/ads-text',   require('./routes/adsText'));
app.use('/api/clicks', require('./routes/clicks'));
app.use('/api/s2s', require('./routes/s2s'));
app.use('/api/reports', require('./routes/reports'));
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

// ── OpenAPI spec + Swagger UI ─────────────────────────────────────────────
// Mounted BEFORE /api/v1 so the spec endpoints don't go through requireApiKey.
//   /api/v1/openapi.yaml — raw spec (for Postman/Insomnia/codegen import)
//   /api/v1/openapi.json — parsed spec
//   /api/docs            — interactive Swagger UI (try-it-out enabled)
{
  const swaggerUi = require('swagger-ui-express');
  const yaml      = require('js-yaml');
  const specPath  = path.join(__dirname, 'public', 'openapi.yaml');
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

app.use('/api/v1', require('./routes/v1'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/campaign-access', require('./routes/campaignAccess'));
app.use('/api/smart-links',    require('./routes/smartLinks'));
app.use('/api/automation',     require('./routes/automation'));
app.use('/api/preview',        require('./routes/preview'));
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
app.use('/api/discovery',         require('./routes/discovery'));

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
  // Serve standalone HTML pages (not part of React SPA)
  app.get('/publisher-preview.html', (req, res) => {
    res.sendFile(path.join(frontendDist, 'publisher-preview.html'));
  });
  app.get('/domain-integration-guide.html', (req, res) => {
    res.sendFile(path.join(frontendDist, 'domain-integration-guide.html'));
  });

  // All unmatched routes → React SPA (client-side routing)
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
