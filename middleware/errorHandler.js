const crypto = require('crypto');

/**
 * Centralised error handler.
 *
 * - Generates a short request ID for every error so operators can grep logs
 *   to find the exact incident from a customer's "I got an error" report.
 * - Logs the full stack server-side (always).
 * - In production, hides raw `err.message` for 5xx responses to avoid leaking
 *   internal details (SQL errors, schema info, file paths). 4xx errors keep
 *   their message because they're typically validation feedback the client
 *   needs to act on.
 * - Always returns the request ID in the response so the client can quote it
 *   when reporting the issue.
 */
function errorHandler(err, req, res, next) {
  const errorId = crypto.randomBytes(4).toString('hex');
  const status  = err.status || 500;
  const isProd  = process.env.NODE_ENV === 'production';

  // Server-side log — always full detail so operators can debug.
  const ip      = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim();
  const user    = req?.user?.email || req?.user?.id || 'anon';
  const route   = `${req.method} ${req.originalUrl || req.url}`;
  console.error(
    `[err:${errorId}] [${status}] [${user}] [${ip}] ${route}\n` +
    (err.stack || err.message || String(err))
  );

  // Client response — sanitise 5xx in production.
  const safeMessage = isProd && status >= 500
    ? `Internal server error (id: ${errorId})`
    : (err.message || 'Internal server error');

  res.status(status).json({
    error:    safeMessage,
    error_id: errorId,
  });
}

module.exports = { errorHandler };
