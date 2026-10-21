'use strict';
// Menu Fire multiplayer server entry point.  npm start
const http = require('http');
const path = require('path');
const { createApp, serveStatic } = require('./lib/mini');
const config = require('./config');
const log = require('./services/logger');
const { createStore, rtdbBackend, objectBackend } = require('./services/store');
const { createGame } = require('./sockets/game');
const { createAdminAuth } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

/** Builds everything without listening. `overrides` lets tests inject a fake verifier / memory store. */
async function build(cfg, overrides = {}) {
  let verify = overrides.verify, backend = overrides.backend;
  if (!verify || !backend) {
    if (cfg.authMode === 'firebase') {
      const fb = require('./services/firebase').initFirebase(cfg);
      verify = verify || (tok => fb.verify(tok));
      backend = backend || rtdbBackend(fb.db);
    } else {
      // development only: trusts the uid that the client sends
      verify = verify || (async (tok, claimed) => { const uid = String(claimed || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64); if (!uid) throw new Error('uid'); return { uid, claims: {} }; });
      backend = backend || objectBackend(path.join(cfg.dataDir, 'dev-data.json'));
    }
  }
  const store = createStore(backend, log);
  await store.init();
  const game = createGame({ cfg, store, verify, log });

  const app = createApp();
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
  app.use(require('./routes/health')({ game, cfg, store }));
  const requireAdmin = createAdminAuth({ verify, store, cfg, log });
  const limiter = rateLimit({ windowMs: 60000, max: 60 });
  app.use('/api/admin', require('./routes/admin')({ game, store, requireAdmin, limiter, cfg }));
  app.use('/admin', serveStatic(path.join(__dirname, 'public'), 'admin.html'));
  app.onError((err, req, res) => { log.error('http error', err.message); if (!res.writableEnded) res.status(err.status || 500).json({ error: 'server error' }); });

  const server = http.createServer(app);
  game.attach(server);
  return { app, server, game, store, limiter, async close() { game.close(); limiter.stop(); await store.flush(); await new Promise(r => server.close(r)); } };
}

async function main() {
  const cfg = config.load();
  const errs = config.validate(cfg);
  if (errs.length) { for (const e of errs) log.error('config: ' + e); log.error('Fix the settings above (see .env.example) and restart.'); process.exit(1); }
  const s = await build(cfg);
  s.server.listen(cfg.port, () => log.info(`Menu Fire server on :${cfg.port} (auth=${cfg.authMode}, db=${s.store.backend.kind}${cfg.fast ? ', FAST timers' : ''})`));
  const stop = async () => { log.info('shutting down'); try { await s.close(); } catch (e) { /* */ } process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('unhandledRejection', e => log.error('unhandled rejection', String(e && e.message || e)));
}

if (require.main === module) main().catch(e => { log.error('startup failed', e.message); process.exit(1); });
module.exports = { build };
