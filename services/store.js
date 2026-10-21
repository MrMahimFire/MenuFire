'use strict';
// Player profiles, bans, name index, match results and runtime config.
// Backends: Firebase Realtime Database (production) or a local JSON file / memory (development and tests).
// Layout:  players/<uid>  names/<lowercase name> = uid  bans/<uid>  admins/<uid>  matches/<id>  config/game
const fs = require('fs');
const path = require('path');

// ---- backends: tiny async key/value API on slash paths
function rtdbBackend(db) {
  return {
    kind: 'rtdb',
    get: async p => (await db.ref(p).get()).val(),
    set: (p, v) => db.ref(p).set(v),
    del: p => db.ref(p).remove(),
    // atomically set only if empty; true when we got it (or already ours)
    claim: async (p, v) => { const r = await db.ref(p).transaction(cur => (cur === null || cur === v ? v : undefined)); return r.committed; },
    list: async (p, limit) => { const o = (await db.ref(p).limitToLast(limit).get()).val() || {}; return o; },
  };
}

function objectBackend(file) {
  let root = {};
  if (file) { try { root = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { root = {}; } }
  let timer = null;
  const persist = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(root)); fs.renameSync(file + '.tmp', file); } catch (e) { /* logged by caller */ }
    }, 1000);
    if (timer.unref) timer.unref();
  };
  const walk = (p, create) => {
    const parts = p.split('/').filter(Boolean);
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) { if (!create) return [null, null]; o[parts[i]] = {}; } o = o[parts[i]]; }
    return [o, parts[parts.length - 1]];
  };
  return {
    kind: file ? 'file' : 'memory',
    get: async p => { const [o, k] = walk(p, false); return o && o[k] !== undefined ? JSON.parse(JSON.stringify(o[k])) : null; },
    set: async (p, v) => { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); persist(); },
    del: async p => { const [o, k] = walk(p, false); if (o) delete o[k]; persist(); },
    claim: async (p, v) => { const [o, k] = walk(p, true); if (o[k] === undefined || o[k] === v) { o[k] = v; persist(); return true; } return false; },
    list: async (p, limit) => { const [o, k] = walk(p, false); const v = o ? o[k] : null; if (!v) return {}; const keys = Object.keys(v).slice(-limit); const r = {}; for (const key of keys) r[key] = v[key]; return r; },
    flush: () => { if (file) fs.writeFileSync(file, JSON.stringify(root)); },
  };
}

const DEFAULT_GAME_CONFIG = { maintenance: false, motd: '', minBR: 2, minCS: 2 };

function createStore(backend, log) {
  const cache = new Map();      // uid -> profile
  const dirty = new Set();
  const bans = new Map();       // uid -> { reason, at }
  let gameConfig = { ...DEFAULT_GAME_CONFIG };
  let timer = null;

  const fresh = () => ({ name: '', xp: 0, coins: 200, diamonds: 20, kills: 0, wins: 0, matches: 0, created: Date.now() });
  const clean = o => { const p = Object.assign(fresh(), o || {}); for (const k of ['xp', 'coins', 'diamonds', 'kills', 'wins', 'matches']) p[k] = Math.max(0, Math.floor(+p[k] || 0)); p.name = String(p.name || ''); return p; };

  async function flush() {
    const uids = [...dirty]; dirty.clear();
    for (const uid of uids) { try { await backend.set('players/' + uid, cache.get(uid)); } catch (e) { dirty.add(uid); log.error('profile save failed for ' + uid, e.message); } }
  }
  function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; flush(); }, 1500); if (timer.unref) timer.unref(); }

  return {
    backend,
    async init() {
      const c = await backend.get('config/game');
      gameConfig = { ...DEFAULT_GAME_CONFIG, ...(c || {}) };
    },
    async load(uid) {
      let p = cache.get(uid);
      if (!p) {
        p = clean(await backend.get('players/' + uid));
        cache.set(uid, p);
        if (!(await backend.get('players/' + uid))) { dirty.add(uid); schedule(); }
        const b = await backend.get('bans/' + uid);
        if (b) bans.set(uid, b); else bans.delete(uid);
      }
      return p;
    },
    get: uid => cache.get(uid),
    markDirty(uid) { dirty.add(uid); schedule(); },
    flush,
    release(uid) { if (!dirty.has(uid)) cache.delete(uid); },
    async claimName(uid, name) {
      const key = 'names/' + name.toLowerCase();
      const ok = await backend.claim(key, uid);
      if (!ok) return false;
      const p = cache.get(uid) || await this.load(uid);
      if (p.name && p.name.toLowerCase() !== name.toLowerCase()) await backend.del('names/' + p.name.toLowerCase());
      p.name = name; this.markDirty(uid);
      return true;
    },
    isBanned: uid => bans.get(uid) || null,
    async setBan(uid, banned, reason) {
      if (banned) { const b = { reason: String(reason || '').slice(0, 120), at: Date.now() }; bans.set(uid, b); await backend.set('bans/' + uid, b); }
      else { bans.delete(uid); await backend.del('bans/' + uid); }
    },
    async refreshBan(uid) { const b = await backend.get('bans/' + uid); if (b) bans.set(uid, b); else bans.delete(uid); return b; },
    async isAdminInDb(uid) { return (await backend.get('admins/' + uid)) === true; },
    async getPlayer(uid) { return cache.get(uid) || (await backend.get('players/' + uid)); },
    async saveMatch(result) { try { await backend.set('matches/' + result.id + '_' + result.t, result); } catch (e) { log.error('match save failed', e.message); } },
    async recentMatches(n) { return backend.list('matches', n); },
    gameConfig: () => gameConfig,
    async setGameConfig(patch) { gameConfig = { ...gameConfig, ...patch }; await backend.set('config/game', gameConfig); return gameConfig; },
  };
}

module.exports = { createStore, rtdbBackend, objectBackend, DEFAULT_GAME_CONFIG };
