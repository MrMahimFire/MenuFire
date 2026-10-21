'use strict';
const config = require('../config');
const { build } = require('../server');
const { objectBackend } = require('../services/store');
const log = require('../services/logger');
log.setSilent(true);

// fake Firebase: token "tok:<uid>" is valid for that uid; "tok:<uid>:admin" carries the admin claim
async function fakeVerify(tok, claimed) {
  const m = /^tok:([A-Za-z0-9_-]+)(:admin)?$/.exec(String(tok));
  if (!m) { const e = new Error('bad token'); e.code = 'auth/argument-error'; throw e; }
  if (claimed && claimed !== m[1]) throw new Error('uid mismatch');
  return { uid: m[1], claims: m[2] ? { admin: true } : {} };
}

async function start(extraEnv = {}) {
  const cfg = config.load({ AUTH_MODE: 'dev', FAST: '1', NODE_ENV: 'test', MIN_BR: '2', ...extraEnv });
  const s = await build(cfg, { verify: fakeVerify, backend: objectBackend(null) });
  await new Promise(r => s.server.listen(0, '127.0.0.1', r));
  s.port = s.server.address().port;
  s.url = `ws://127.0.0.1:${s.port}`;
  s.http = `http://127.0.0.1:${s.port}`;
  return s;
}

class Client {
  constructor(url) {
    this.msgs = []; this.closed = false;
    this.ws = new WebSocket(url);
    this.opened = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
    this.ws.onmessage = e => { this.msgs.push(String(e.data)); if (this.onmsg) this.onmsg(String(e.data)); };
    this.ws.onclose = () => { this.closed = true; };
  }
  send(s) { this.ws.send(s); }
  async until(pred, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = this.msgs.find(pred); if (m !== undefined) return m; await new Promise(r => setTimeout(r, 15)); }
    return null;
  }
  has(prefix) { return this.msgs.some(m => m.startsWith(prefix)); }
  last(prefix) { return [...this.msgs].reverse().find(m => m.startsWith(prefix)); }
  close() { try { this.ws.close(); } catch (e) { /* */ } }
}

/** Connects, logs in as uid and picks a name. */
async function player(s, uid, name, admin) {
  const c = new Client(s.url);
  await c.opened;
  c.send(`hello ${uid} ${name} tok:${uid}${admin ? ':admin' : ''}`);
  await c.until(m => m.startsWith('welcome'));
  if (name) { c.send('setname ' + name); await c.until(m => m.startsWith('profile ' + name)); }
  return c;
}

async function http(s, method, path, { token, body } = {}) {
  const r = await fetch(s.http + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { start, Client, player, http, sleep, fakeVerify };
