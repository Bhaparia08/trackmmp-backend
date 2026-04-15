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
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public tracking endpoints (no auth)
app.use('/track', require('./routes/track'));
app.use('/pixel.gif', require('./routes/pixel'));
app.use('/pb', require('./routes/postbacks'));
app.use('/postbacks', require('./routes/postbacks'));   // friendly alias
app.use('/acquisition', require('./routes/acquisition')); // Trackier-compatible

// Adjust-compatible S2S endpoints (no auth — token validated per-request)
app.use('/adjust', require('./routes/adjust'));

// Authenticated API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/apps', require('./routes/apps'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/publishers', require('./routes/publishers'));
app.use('/api/clicks', require('./routes/clicks'));
app.use('/api/s2s', require('./routes/s2s'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/fraud', require('./routes/fraud'));
app.use('/api/campaigns/:campaign_id/goals', require('./routes/goals'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/publisher', require('./routes/publisher'));
app.use('/api/am', require('./routes/am'));
app.use('/api/apikeys', require('./routes/apikeys'));
app.use('/api/v1', require('./routes/v1'));
app.use('/api/integrations', require('./routes/integrations'));
app.use('/api/campaign-access', require('./routes/campaignAccess'));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

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
