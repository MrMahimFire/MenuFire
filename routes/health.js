'use strict';
const { Router } = require('../lib/mini');
module.exports = function healthRoutes({ game, cfg, store }) {
  const r = new Router();
  const started = Date.now();
  r.get('/health', (req, res) => {
    const s = game.stats();
    res.json({ ok: true, uptime: Math.round((Date.now() - started) / 1000), players: s.clients.length, matches: s.matches.length, db: store.backend.kind, auth: cfg.authMode });
  });
  // values the admin page / app needs that are safe to be public
  r.get('/api/public-config', (req, res) => res.json({ firebaseWebApiKey: cfg.firebase.webApiKey, motd: store.gameConfig().motd, maintenance: !!store.gameConfig().maintenance }));
  return r;
};
