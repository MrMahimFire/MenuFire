'use strict';
const { Router, json } = require('../lib/mini');
const log = require('../services/logger');

module.exports = function adminRoutes({ game, store, requireAdmin, limiter, cfg }) {
  const r = new Router();
  r.use(limiter, requireAdmin, json(4096));
  const uidOk = u => /^[A-Za-z0-9_-]{1,64}$/.test(u);

  r.get('/overview', (req, res) => {
    const s = game.stats(), mem = process.memoryUsage();
    res.json({ uptimeSec: Math.round(process.uptime()), node: process.version, rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576),
      online: s.clients.length, lobbies: s.lobbies, matches: s.matches.length, errorsLogged: log.errorCount(), db: store.backend.kind, authMode: cfg.authMode, config: store.gameConfig() });
  });
  r.get('/players/online', (req, res) => res.json(game.stats().clients));
  r.get('/rooms', (req, res) => { const s = game.stats(); res.json({ lobbies: s.lobbies, matches: s.matches }); });
  r.get('/matches/recent', async (req, res) => res.json(await store.recentMatches(Math.min(50, +req.query.n || 20))));

  r.get('/players/:uid', async (req, res) => {
    if (!uidOk(req.params.uid)) return res.status(400).json({ error: 'bad uid' });
    const p = await store.getPlayer(req.params.uid);
    if (!p) return res.status(404).json({ error: 'not found' });
    await store.refreshBan(req.params.uid);
    res.json({ uid: req.params.uid, profile: p, ban: store.isBanned(req.params.uid) });
  });
  r.post('/players/:uid/ban', async (req, res) => {
    if (!uidOk(req.params.uid)) return res.status(400).json({ error: 'bad uid' });
    if (cfg.adminUids.includes(req.params.uid) || req.params.uid === req.admin.uid) return res.status(400).json({ error: 'cannot ban an admin' });
    await store.setBan(req.params.uid, true, (req.body || {}).reason);
    const kicked = game.kick(req.params.uid, 'banned');
    log.info(`admin ${req.admin.uid} banned ${req.params.uid}`);
    res.json({ ok: true, kicked });
  });
  r.post('/players/:uid/unban', async (req, res) => {
    if (!uidOk(req.params.uid)) return res.status(400).json({ error: 'bad uid' });
    await store.setBan(req.params.uid, false);
    log.info(`admin ${req.admin.uid} unbanned ${req.params.uid}`);
    res.json({ ok: true });
  });
  r.post('/players/:uid/kick', (req, res) => {
    if (!uidOk(req.params.uid)) return res.status(400).json({ error: 'bad uid' });
    res.json({ ok: true, kicked: game.kick(req.params.uid, 'kicked') });
  });

  r.get('/config', (req, res) => res.json(store.gameConfig()));
  r.put('/config', async (req, res) => {
    const b = req.body || {}, patch = {};
    if ('maintenance' in b) { if (typeof b.maintenance !== 'boolean') return res.status(400).json({ error: 'maintenance must be true/false' }); patch.maintenance = b.maintenance; }
    if ('motd' in b) { if (typeof b.motd !== 'string' || b.motd.length > 120) return res.status(400).json({ error: 'motd must be text up to 120 characters' }); patch.motd = b.motd; }
    for (const k of ['minBR', 'minCS']) if (k in b) { if (!Number.isInteger(b[k]) || b[k] < 1 || b[k] > 50) return res.status(400).json({ error: k + ' must be 1-50' }); patch[k] = b[k]; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change (allowed: maintenance, motd, minBR, minCS)' });
    log.info(`admin ${req.admin.uid} changed config ${JSON.stringify(patch)}`);
    res.json(await store.setGameConfig(patch));
  });

  r.get('/logs', (req, res) => {
    const level = ['info', 'warn', 'error'].includes(req.query.level) ? req.query.level : null;
    res.json(log.recent(level, Math.min(300, +req.query.n || 100)));
  });
  return r;
};
