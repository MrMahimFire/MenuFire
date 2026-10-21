'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const config = require('../config');
const { start, http, Client } = require('./helpers');

test('server starts and /health answers', async () => {
  const s = await start();
  const r = await http(s, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.players, 0);
  assert.equal((await http(s, 'GET', '/nope')).status, 404);
  await s.close();
});

test('environment validation catches bad settings', () => {
  const ok = config.validate(config.load({ AUTH_MODE: 'dev', NODE_ENV: 'test' }));
  assert.deepEqual(ok, []);
  const noCreds = config.validate(config.load({ AUTH_MODE: 'firebase', NODE_ENV: 'production' }));
  assert.ok(noCreds.some(e => /credentials/i.test(e)), 'missing credentials reported');
  assert.ok(noCreds.some(e => /DATABASE_URL/.test(e)), 'missing database url reported');
  const devInProd = config.validate(config.load({ AUTH_MODE: 'dev', NODE_ENV: 'production' }));
  assert.ok(devInProd.some(e => /not allowed/.test(e)));
  const badB64 = config.validate(config.load({ AUTH_MODE: 'firebase', FIREBASE_SERVICE_ACCOUNT_B64: '@@@', FIREBASE_DATABASE_URL: 'https://x.firebaseio.com' }));
  assert.ok(badB64.some(e => /not valid/.test(e)));
  const raw = JSON.stringify({ project_id: 'p', client_email: 'a@b', private_key: 'k' });
  const base = { AUTH_MODE: 'firebase', FIREBASE_DATABASE_URL: 'https://x.firebaseio.com' };
  assert.deepEqual(config.validate(config.load({ ...base, FIREBASE_SERVICE_ACCOUNT_B64: raw })), [], 'plain JSON accepted');
  assert.deepEqual(config.validate(config.load({ ...base, FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from(raw).toString('base64') })), [], 'base64 accepted');
  assert.deepEqual(config.validate(config.load({ ...base, FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from(raw).toString('base64').slice(0, 40) })).length, 1, 'truncated value rejected');
  const good = config.validate(config.load({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'p', FIREBASE_CLIENT_EMAIL: 'a@b', FIREBASE_PRIVATE_KEY: 'k', FIREBASE_DATABASE_URL: 'https://x.firebaseio.com' }));
  assert.deepEqual(good, []);
});

test('deployment smoke test: real process, refuses to start misconfigured, serves /health when configured', async () => {
  const dir = path.join(__dirname, '..');
  // production without Firebase settings must exit with an error
  const bad = spawn(process.execPath, ['server.js'], { cwd: dir, env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0' } });
  const code = await new Promise(r => bad.on('exit', r));
  assert.equal(code, 1);
  // dev mode on a fixed port
  const port = 18000 + Math.floor(Math.random() * 1000);
  const ok = spawn(process.execPath, ['server.js'], { cwd: dir, env: { PATH: process.env.PATH, AUTH_MODE: 'dev', PORT: String(port), DATA_DIR: require('os').tmpdir() + '/mf-smoke-' + port } });
  try {
    let body = null;
    for (let i = 0; i < 40 && !body; i++) { try { body = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(body && body.ok, 'health reachable');
    const page = await fetch(`http://127.0.0.1:${port}/admin/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Menu/);
  } finally { ok.kill('SIGTERM'); await new Promise(r => ok.on('exit', r)); }
});
