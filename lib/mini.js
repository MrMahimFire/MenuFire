'use strict';
// Tiny Express-style HTTP layer (routing, :params, JSON body, static files, error handling) with no dependencies.
// Handlers use the familiar (req, res, next) shape, so moving to Express later is a drop-in change.
const fs = require('fs');
const path = require('path');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function decorate(req, res) {
  const u = new URL(req.url, 'http://x');
  req.path = u.pathname; req.query = Object.fromEntries(u.searchParams); req.params = {};
  res.status = n => { res.statusCode = n; return res; };
  res.set = (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) res.setHeader(a, b); else res.setHeader(k, v); return res; };
  res.json = o => { const s = JSON.stringify(o); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Length', Buffer.byteLength(s)); res.end(s); };
}

function compile(pattern) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z0-9_]+)/g, (m, n) => { names.push(n); return '/([^/]+)'; }) + '/?$');
  return { re, names };
}

class Router {
  constructor() { this.stack = []; }
  use(...args) { const prefix = typeof args[0] === 'string' ? args.shift() : ''; for (const fn of args) this.stack.push({ prefix, fn }); return this; }
  route(method, pattern, handlers) { const c = compile(pattern); for (const h of handlers) this.stack.push({ method, ...c, fn: h }); return this; }
  get(p, ...h) { return this.route('GET', p, h); }
  post(p, ...h) { return this.route('POST', p, h); }
  put(p, ...h) { return this.route('PUT', p, h); }
  // run the stack for req/res; calls done() when nothing handled it
  handle(req, res, done) {
    let i = 0;
    const basePath = req.path, baseUrlPath = req._sub || '';
    const next = err => {
      if (err) return done(err);
      const l = this.stack[i++];
      if (!l) { req.path = basePath; return done(); }
      try {
        let r;
        if (l.method) {
          if (req.method !== l.method) return next();
          const m = l.re.exec(req.path);
          if (!m) return next();
          l.names.forEach((n, k) => { req.params[n] = decodeURIComponent(m[k + 1]); });
          r = l.fn(req, res, next);
        } else if (l.prefix) {
          if (req.path !== l.prefix && !req.path.startsWith(l.prefix + '/')) return next();
          const saved = req.path; req.path = req.path.slice(l.prefix.length) || '/';
          const after = e => { req.path = saved; next(e); };
          if (l.fn instanceof Router) l.fn.handle(req, res, after); else r = l.fn(req, res, after);
        } else if (l.fn instanceof Router) l.fn.handle(req, res, next);
        else r = l.fn(req, res, next);
        if (r && typeof r.catch === 'function') r.catch(next);
      } catch (e) { next(e); }
    };
    next();
  }
}

function createApp() {
  const root = new Router();
  const errHandlers = [];
  const app = (req, res) => {
    decorate(req, res);
    root.handle(req, res, err => {
      if (err) { for (const h of errHandlers) return h(err, req, res); res.status(500).json({ error: 'server error' }); return; }
      res.status(404).json({ error: 'not found' });
    });
  };
  app.use = (...a) => root.use(...a);
  app.onError = h => errHandlers.push(h);
  return app;
}

function json(limit = 4096) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    let n = 0; const parts = [];
    req.on('data', d => { n += d.length; if (n > limit) { res.status(413).json({ error: 'body too large' }); req.destroy(); } else parts.push(d); });
    req.on('end', () => {
      if (res.writableEnded) return;
      if (!parts.length) { req.body = {}; return next(); }
      try { req.body = JSON.parse(Buffer.concat(parts).toString('utf8')); next(); } catch (e) { res.status(400).json({ error: 'invalid JSON' }); }
    });
  };
}

function serveStatic(dir, index = 'index.html') {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const rel = req.path === '/' ? index : req.path.replace(/^\/+/, '');
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(path.normalize(dir))) return res.status(403).json({ error: 'forbidden' });
    fs.readFile(file, (e, data) => {
      if (e) return next();
      res.set({ 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
    });
  };
}

module.exports = { createApp, Router, json, serveStatic };
