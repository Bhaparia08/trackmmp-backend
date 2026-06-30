/**
 * safeJsonParser — express.json() that NEVER short-circuits to 400.
 *
 * MMP postback receivers (the /pb endpoint) must acknowledge every request
 * with 200 OK. Express's default body-parser, on a malformed JSON body, calls
 * next(err); the default error handler then responds 400, which upstream
 * networks (AppsFlyer, Adjust, partner S2S) retry on for hours. This wrapper
 * intercepts that error, sets req.body to an empty object, and lets the route
 * handler run normally.
 *
 * Behavior:
 *   - Valid JSON body         → req.body parsed (express.json() default)
 *   - Malformed JSON body     → req.body = {}, parse error logged
 *   - Empty body              → req.body = {} (express.json() default)
 *   - Non-JSON content-type   → express.json() skips parsing, req.body stays {}
 *
 * In every case, next() is called clean — no error propagates downstream.
 */
const express = require('express');

function safeJsonParser(options) {
  const parser = express.json(options);
  return function safeJsonParserMiddleware(req, res, next) {
    parser(req, res, (err) => {
      if (err) {
        console.error('[safeJsonParser] body parse failed:', err.message);
        req.body = {};
      }
      next();
    });
  };
}

module.exports = { safeJsonParser };
