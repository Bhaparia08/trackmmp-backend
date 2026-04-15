require('dotenv').config();
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
if (process.env.NODE_ENV === 'production' && frontendDist) {
  console.log(`Serving frontend from: ${frontendDist}`);
  app.use(express.static(frontendDist));
  // All unmatched routes → React SPA (client-side routing)
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Apogeemobi TrackMMP running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);

  // Keep-alive self-ping every 4 minutes so Render free tier never sleeps
  if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
    const fetch = require('node-fetch');
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
    setInterval(() => {
      fetch(pingUrl).catch(() => {});
    }, 4 * 60 * 1000); // every 4 minutes
    console.log(`Keep-alive pinging ${pingUrl} every 4 minutes`);
  }
});
