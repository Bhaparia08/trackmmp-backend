#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const dbPath = path.join('/tmp', `trackmmp-api-key-routes-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = 'api-key-route-test-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/init');
const apiKeysRouter = require('../routes/apikeys');
const { requireApiKey } = require('../middleware/apiKeyAuth');
const { hashApiKey } = require('../utils/apiKeySecurity');

let passed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`✓ ${name}`);
    });
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function seed() {
  const adminInfo = {
    email: `api-key-admin-${Date.now()}@example.com`,
    password: 'x',
    name: 'API Key Admin',
    role: 'admin',
    status: 'active',
    postback_token: 'admin-postback-token',
  };
  const pubUserInfo = {
    email: `api-key-pub-${Date.now()}@example.com`,
    password: 'x',
    name: 'API Key Publisher User',
    role: 'publisher',
    status: 'active',
    postback_token: 'publisher-postback-token',
  };
  const otherPubUserInfo = {
    email: `api-key-other-pub-${Date.now()}@example.com`,
    password: 'x',
    name: 'Other Publisher User',
    role: 'publisher',
    status: 'active',
    postback_token: 'other-publisher-postback-token',
  };

  const adminId = db.prepare(`
    INSERT INTO users (email, password, name, role, status, postback_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(adminInfo.email, adminInfo.password, adminInfo.name, adminInfo.role, adminInfo.status, adminInfo.postback_token).lastInsertRowid;

  const pubUserId = db.prepare(`
    INSERT INTO users (email, password, name, role, status, postback_token, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(pubUserInfo.email, pubUserInfo.password, pubUserInfo.name, pubUserInfo.role, pubUserInfo.status, pubUserInfo.postback_token, adminId).lastInsertRowid;

  const otherPubUserId = db.prepare(`
    INSERT INTO users (email, password, name, role, status, postback_token, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(otherPubUserInfo.email, otherPubUserInfo.password, otherPubUserInfo.name, otherPubUserInfo.role, otherPubUserInfo.status, otherPubUserInfo.postback_token, adminId).lastInsertRowid;

  const publisherId = db.prepare(`
    INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(adminId, pubUserId, 'API Key Publisher', pubUserInfo.email, `api-key-pub-${Date.now()}`).lastInsertRowid;

  const otherPublisherId = db.prepare(`
    INSERT INTO publishers (user_id, publisher_user_id, name, email, pub_token, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(adminId, otherPubUserId, 'Other API Key Publisher', otherPubUserInfo.email, `api-key-other-pub-${Date.now()}`).lastInsertRowid;

  return {
    admin: { id: adminId, ...adminInfo },
    pubUser: { id: pubUserId, ...pubUserInfo },
    otherPubUser: { id: otherPubUserId, ...otherPubUserInfo },
    publisherId,
    otherPublisherId,
  };
}

async function main() {
  const seeded = seed();
  const adminToken = makeToken(seeded.admin);
  const pubToken = makeToken(seeded.pubUser);
  const otherPubToken = makeToken(seeded.otherPubUser);

  const app = express();
  app.use(express.json());
  app.use('/api/apikeys', apiKeysRouter);
  app.get('/api/protected', requireApiKey, (req, res) => {
    res.json({ ok: true, publisher_id: req.publisherId, api_key_id: req.apiKey.id });
  });

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    let created;
    await test('POST /api/apikeys returns full key once and stores only hash/redacted value', async () => {
      const res = await request(port, 'POST', '/api/apikeys', {
        publisher_id: seeded.publisherId,
        name: 'Route Test Key',
      }, { Authorization: `Bearer ${adminToken}` });

      assert.strictEqual(res.status, 201);
      assert.ok(res.data.api_key.startsWith('apg_live_'));
      assert.strictEqual(res.data.api_key_masked, false);
      assert.strictEqual(res.data.can_reveal, true);
      assert.strictEqual(res.data.reveal_once, true);
      created = res.data;

      const row = db.prepare('SELECT * FROM publisher_api_keys WHERE id = ?').get(created.id);
      assert.ok(row.api_key_hash);
      assert.notStrictEqual(row.api_key, created.api_key);
      assert.ok(row.api_key.startsWith('redacted:publisher-api-key:'));
      assert.strictEqual(row.api_key_last4, created.api_key.slice(-4));
    });

    await test('GET /api/apikeys returns masked preview, not stored secret', async () => {
      const res = await request(port, 'GET', '/api/apikeys', undefined, { Authorization: `Bearer ${adminToken}` });
      assert.strictEqual(res.status, 200);
      const row = res.data.find(k => k.id === created.id);
      assert.ok(row);
      assert.strictEqual(row.api_key_masked, true);
      assert.strictEqual(row.can_reveal, false);
      assert.notStrictEqual(row.api_key, created.api_key);
      assert.ok(row.api_key.includes('••••'));
      assert.ok(!row.api_key_hash);
    });

    await test('requireApiKey authenticates with hashed key', async () => {
      const res = await request(port, 'GET', '/api/protected', undefined, { 'x-api-key': created.api_key });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.publisher_id, seeded.publisherId);
      assert.strictEqual(res.data.api_key_id, created.id);
      const row = db.prepare('SELECT last_used_at FROM publisher_api_keys WHERE id = ?').get(created.id);
      assert.ok(row.last_used_at);
    });

    await test('requireApiKey also supports legacy query param using hash lookup', async () => {
      const res = await request(port, 'GET', `/api/protected?api_key=${encodeURIComponent(created.api_key)}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.publisher_id, seeded.publisherId);
    });

    await test('plaintext-only active DB row does not authenticate', async () => {
      db.prepare(`
        INSERT INTO publisher_api_keys (publisher_id, user_id, name, api_key, status, created_by)
        VALUES (?, ?, 'Plaintext Only', 'PLAINTEXT_ONLY_SECRET', 'active', ?)
      `).run(seeded.publisherId, seeded.pubUser.id, seeded.admin.id);

      const res = await request(port, 'GET', '/api/protected', undefined, { 'x-api-key': 'PLAINTEXT_ONLY_SECRET' });
      assert.strictEqual(res.status, 401);
    });

    await test('legacy plaintext row can be backfilled to hash/redacted form and then authenticate', async () => {
      const legacyKey = 'LEGACY_BACKFILL_SECRET';
      const insert = db.prepare(`
        INSERT INTO publisher_api_keys (publisher_id, user_id, name, api_key, status, created_by)
        VALUES (?, ?, 'Legacy Backfill', ?, 'active', ?)
      `).run(seeded.publisherId, seeded.pubUser.id, legacyKey, seeded.admin.id);

      const last4 = legacyKey.slice(-4);
      db.prepare(`
        UPDATE publisher_api_keys
        SET api_key_hash = ?,
            api_key_prefix = ?,
            api_key_last4 = ?,
            api_key = ?,
            last_rotated_at = COALESCE(last_rotated_at, created_at)
        WHERE id = ?
      `).run(hashApiKey(legacyKey), legacyKey.slice(0, 6), last4, `redacted:publisher-api-key:${insert.lastInsertRowid}:${last4}`, insert.lastInsertRowid);

      const auth = await request(port, 'GET', '/api/protected', undefined, { 'x-api-key': legacyKey });
      assert.strictEqual(auth.status, 200);
      assert.strictEqual(auth.data.api_key_id, insert.lastInsertRowid);

      const row = db.prepare('SELECT api_key, api_key_hash, api_key_prefix, api_key_last4 FROM publisher_api_keys WHERE id = ?').get(insert.lastInsertRowid);
      assert.notStrictEqual(row.api_key, legacyKey);
      assert.ok(row.api_key.startsWith('redacted:publisher-api-key:'));
      assert.ok(row.api_key_hash);
      assert.strictEqual(row.api_key_prefix, 'LEGACY');
      assert.strictEqual(row.api_key_last4, 'CRET');
    });

    await test('inactive publisher is blocked even with valid key', async () => {
      db.prepare("UPDATE publishers SET status = 'pending' WHERE id = ?").run(seeded.publisherId);
      const res = await request(port, 'GET', '/api/protected', undefined, { 'x-api-key': created.api_key });
      assert.strictEqual(res.status, 403);
      db.prepare("UPDATE publishers SET status = 'active' WHERE id = ?").run(seeded.publisherId);
    });

    await test('inactive publisher user is blocked even with valid key', async () => {
      db.prepare("UPDATE users SET status = 'pending' WHERE id = ?").run(seeded.pubUser.id);
      const res = await request(port, 'GET', '/api/protected', undefined, { 'x-api-key': created.api_key });
      assert.strictEqual(res.status, 403);
      db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(seeded.pubUser.id);
    });

    await test('publisher can list own key but another publisher cannot revoke it', async () => {
      const ownList = await request(port, 'GET', '/api/apikeys', undefined, { Authorization: `Bearer ${pubToken}` });
      assert.strictEqual(ownList.status, 200);
      assert.ok(ownList.data.some(k => k.id === created.id));

      const otherDelete = await request(port, 'DELETE', `/api/apikeys/${created.id}`, undefined, { Authorization: `Bearer ${otherPubToken}` });
      assert.strictEqual(otherDelete.status, 403);
    });

    await test('DELETE /api/apikeys/:id revokes irreversibly by clearing hash', async () => {
      const del = await request(port, 'DELETE', `/api/apikeys/${created.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
      assert.strictEqual(del.status, 200);
      const row = db.prepare('SELECT status, api_key_hash, revoked_at FROM publisher_api_keys WHERE id = ?').get(created.id);
      assert.strictEqual(row.status, 'revoked');
      assert.strictEqual(row.api_key_hash, null);
      assert.ok(row.revoked_at);

      const auth = await request(port, 'GET', '/api/protected', undefined, { 'x-api-key': created.api_key });
      assert.strictEqual(auth.status, 401);
    });

    await test('revoked key cannot be reactivated through PATCH', async () => {
      const res = await request(port, 'PATCH', `/api/apikeys/${created.id}`, { status: 'active' }, { Authorization: `Bearer ${adminToken}` });
      assert.strictEqual(res.status, 400);
      assert.match(res.data.error, /cannot be reactivated/i);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    try { db.close(); } catch {}
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, 0 failed`);
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
