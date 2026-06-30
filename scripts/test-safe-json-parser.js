#!/usr/bin/env node
/**
 * No-dependency integration test for utils/safeJsonParser.
 * Mounts a minimal express app with the wrapper on /test, makes real HTTP
 * requests, asserts behavior. Does NOT load routes/postbacks.js or the DB
 * chain — keeps the test surface tight to the wrapper itself.
 *
 * Run:  node scripts/test-safe-json-parser.js
 */
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { safeJsonParser } = require('../utils/safeJsonParser');

let pass = 0, fail = 0;
const results = [];

async function check(name, fn) {
  try { await fn(); pass++; results.push(['✓', name]); }
  catch (err) { fail++; results.push(['✗', name, err.message]); }
}

function post(port, body, contentType) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = http.request({
      port, method: 'POST', path: '/test',
      headers: { 'Content-Type': contentType, 'Content-Length': buf.length },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

(async () => {
  const app = express();
  let lastBody;
  app.post('/test', safeJsonParser(), (req, res) => {
    lastBody = req.body;
    res.status(200).send('OK');
  });

  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const { port } = server.address();

  await check('valid JSON body → 200, body parsed', async () => {
    lastBody = undefined;
    const r = await post(port, '{"clickid":"abc","payout":1.5}', 'application/json');
    assert.equal(r.status, 200);
    assert.deepEqual(lastBody, { clickid: 'abc', payout: 1.5 });
  });

  await check('malformed JSON body → 200, body is empty object (THE BLOCKER FIX)', async () => {
    lastBody = undefined;
    const r = await post(port, '{not valid json', 'application/json');
    assert.equal(r.status, 200, `expected 200 but got ${r.status} — express.json() short-circuited`);
    assert.deepEqual(lastBody, {});
  });

  await check('truncated JSON body → 200, empty object', async () => {
    lastBody = undefined;
    const r = await post(port, '{"clickid":"abc"', 'application/json');
    assert.equal(r.status, 200);
    assert.deepEqual(lastBody, {});
  });

  await check('JSON array root (also valid) → 200, parsed', async () => {
    lastBody = undefined;
    const r = await post(port, '[{"x":1}]', 'application/json');
    assert.equal(r.status, 200);
    assert.deepEqual(lastBody, [{ x: 1 }]);
  });

  await check('empty body + JSON content-type → 200, empty object', async () => {
    lastBody = undefined;
    const r = await post(port, '', 'application/json');
    assert.equal(r.status, 200);
    assert.deepEqual(lastBody, {});
  });

  await check('non-JSON content-type → 200, body untouched (skip-parsing path)', async () => {
    lastBody = undefined;
    const r = await post(port, 'clickid=abc&payout=1.5', 'application/x-www-form-urlencoded');
    assert.equal(r.status, 200);
    // express.json() skips bodies whose Content-Type isn't json — req.body stays at the express default ({}).
    assert.deepEqual(lastBody, {});
  });

  server.close();

  for (const r of results) {
    if (r[0] === '✓') console.log(`  ${r[0]}  ${r[1]}`);
    else console.log(`  ${r[0]}  ${r[1]}\n     → ${r[2]}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
