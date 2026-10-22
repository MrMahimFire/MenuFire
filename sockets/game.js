'use strict';
// Menu Fire game server core: lobbies, matches, battle-royale zone, rounds, combat validation, rewards, reconnection.
// Text protocol over WebSocket (see README). Created with createGame({cfg, store, verify, log}).
const { frame, parseFrames, handshake } = require('./ws');
const voice = require('./voice');
const botsLib = require('./bots');

function createGame({ cfg: C, store, verify, log }) {
  const WEAPONS = C.weapons;
  const T = C.fast ? 0.1 : 1;           // timer scale (tests use short timers)
  const gc = () => store.gameConfig();
  const CFG = {
    BR:   { max: 50, get min() { return +gc().minBR || C.minBR; }, countdown: 30 * T, teamSize: 1 },
    CS:   { max: 8,  get min() { return +gc().minCS || C.minCS; }, countdown: 12 * T, teamSize: 4, rounds: 4 },
    DUEL: { max: 2,  min: 2, countdown: 3 * T, teamSize: 1, rounds: 3 },
  };
  const GRACE = 30000 * T;              // how long a disconnected player's slot is kept
  const ISL = { cx: 48, cz: 48, r: 450 };
  const ZONES = [ // radius, hold s, shrink s, damage per s
    { r: 300, hold: 60, shrink: 40, dmg: 1 }, { r: 190, hold: 45, shrink: 30, dmg: 2 },
    { r: 110, hold: 45, shrink: 30, dmg: 4 }, { r: 50, hold: 40, shrink: 25, dmg: 7 },
    { r: 15, hold: 30, shrink: 20, dmg: 10 }, { r: 3, hold: 20, shrink: 15, dmg: 12 }];
  const PLANE_DUR = 40 * T, ZONE_START = 65 * T;

  function levelOf(xp) { let l = 1, need = 100; while (xp >= need && l < 99) { xp -= need; l++; need = 100 + l * 20; } return { level: l, into: xp, need }; }
  function profileLine(p) { const l = levelOf(p.xp); return `profile ${p.name || '-'} ${l.level} ${l.into} ${l.need} ${p.coins} ${p.diamonds} ${p.kills} ${p.wins} ${p.matches}`; }
  function award(c, win, place) {
    if (c.rewarded || !c.prof) return;
    c.rewarded = true;
    const kills = c.kills || 0;
    let xp = 10 + kills * 15 + (win ? 50 : 0), coins = 20 + kills * 10 + (win ? 50 : 0);
    if (c.match && c.match.mode === 'BR' && place > 0 && place <= 5 && !win) { xp += 20; coins += 15; }
    c.prof.xp += xp; c.prof.coins += coins; c.prof.kills += kills; c.prof.matches += 1; if (win) c.prof.wins += 1;
    store.markDirty(c.uid);
    send(c, `reward ${xp} ${coins}`);
    send(c, profileLine(c.prof));
  }

  let nextId = 1, nextMatch = 1;
  let bots = null;
  const clients = new Map();    // id -> client
  const lobbies = new Map();    // key -> { mode, squad, list: [client], startAt }
  const matches = new Map();
  const graceByUid = new Map(); // uid -> disconnected player waiting to come back
  const ipCount = new Map();
  const timers = new Set();

  function send(c, s) {
    if (c.bot) return; if (c.sock && !c.sock.destroyed) c.sock.write(frame(s)); }
  function sendRaw(c, s) { send(c, s); }

  bots = botsLib.create({ T, ISL, PLANE_DUR, ZONE_START, zoneAt: (m, t) => zoneAt(m, t), damage: (...a) => damage(...a), bcast: (...a) => bcast(...a), f1: v => (Math.round(v * 10) / 10) });

  // ---------------------------------------------------------------- connections
  function attach(server) {
    server.on('upgrade', (req, sock) => {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const n = ipCount.get(ip) || 0;
      if (n >= C.maxConnPerIp) { sock.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); sock.destroy(); return; }
      if (!handshake(req, sock)) return;
      ipCount.set(ip, n + 1);
      const c = newClient(sock, ip);
      const holder = { c };
      c.holder = holder;
      sock.on('data', d => { holder.c.seen = Date.now(); parseFrames(holder.c, d, t => onMessage(holder.c, t), () => { holder.c.seen = Date.now(); }); });
      let closed = false;
      const gone = () => { if (closed) return; closed = true; ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1)); if (holder.c.sock === sock) drop(holder.c); };
      sock.on('close', gone);
      sock.on('error', gone);
    });
    const hb = setInterval(() => {
      const now = Date.now();
      for (const c of clients.values()) {
        if (!c.sock || c.sock.destroyed) continue;
        if (now - c.seen > 60000) { c.sock.destroy(); continue; }
        c.sock.write(frame('', 9));
      }
    }, 20000);
    timers.add(hb);
    const lt = setInterval(() => { for (const l of lobbies.values()) lobbyTick(l); }, 1000 * Math.max(T, 0.2));
    timers.add(lt);
  }

  function newClient(sock, ip) {
    const c = { id: nextId++, sock, ip, buf: Buffer.alloc(0), authed: false, authing: false, name: 'PLAYER', uid: '', mode: null, lobby: null, match: null, msgs: 0, msgT: 0, seen: Date.now() };
    clients.set(c.id, c);
    return c;
  }

  function fail(c, why) { send(c, 'err ' + why); if (c.sock) setTimeout(() => { try { c.sock.end(); } catch (e) { /* closed */ } }, 50); }

  async function onHello(c, a) {
    if (c.authing || c.authed) return;
    c.authing = true;
    try {
      const claimed = String(a[1] || '').slice(0, 64);
      let r;
      try { r = await verify(a[3] || '', claimed); } catch (e) { log.warn('auth rejected', e.code || e.message); return fail(c, 'auth'); }
      const uid = r.uid;
      const prof = await store.load(uid);
      const ban = store.isBanned(uid);
      if (ban) { log.info('banned player tried to connect ' + uid); return fail(c, 'banned'); }
      if (gc().maintenance) return fail(c, 'maintenance');
      // came back after a drop: take the old slot over
      const old = graceByUid.get(uid);
      if (old && old.match && !old.match.over) return rejoin(c, old);
      // same account connected twice: the newer connection wins
      for (const o of clients.values()) if (o !== c && o.uid === uid && o.authed) { send(o, 'err replaced'); const s = o.sock; leave(o); o.authed = false; o.uid = ''; if (s) setTimeout(() => { try { s.end(); } catch (e) { /* */ } }, 50); }
      c.uid = uid; c.authed = true; c.prof = prof;
      c.name = prof.name || String(a[2] || 'PLAYER').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'PLAYER';
      send(c, 'welcome ' + c.id); send(c, profileLine(prof));
      log.info(`player in: ${c.name} (${uid.slice(0, 6)}...)`);
    } finally { c.authing = false; }
  }

  function rejoin(n, old) {
    graceByUid.delete(old.uid);
    clearTimeout(old.graceTimer);
    const sock = n.sock, holder = n.holder;
    clients.delete(n.id);
    old.sock = sock; old.buf = n.buf; old.holder = holder; holder.c = old; old.seen = Date.now(); old.gone = false;
    const m = old.match;
    send(old, 'welcome ' + old.id); send(old, profileLine(old.prof));
    send(old, `start ${m.mode} ${m.seed} ${old.id} ${old.team} ${m.players.length}`);
    for (const q of m.players) send(old, `p ${q.id} ${q.team} ${q.name}`);
    if (m.plane) send(old, `plane ${f1(m.plane.x0)} ${f1(m.plane.z0)} ${f1(m.plane.x1)} ${f1(m.plane.z1)} ${PLANE_DUR}`);
    if (m.round) send(old, `round ${m.round} ${m.score[0]} ${m.score[1]} 0`);
    send(old, `phase ${m.phase === 'loading' ? 'plane' : m.phase}`);
    send(old, `rejoin ${Math.round(old.hp)}`);
    log.info('player rejoined: ' + old.name);
  }

  // ---------------------------------------------------------------- messages
  async function onSetName(c, a) {
    if (!c.authed) return;
    const nm = String(a[1] || '');
    if (c.prof.name) return send(c, 'err name_locked');
    if (!/^[A-Za-z0-9]{3,12}$/.test(nm)) return send(c, 'err name_invalid');
    const ok = await store.claimName(c.uid, nm);
    if (!ok) return send(c, 'err name_taken');
    c.name = nm;
    send(c, profileLine(c.prof));
  }

  function onMessage(c, line) {
    const now = Date.now();
    if (now - c.msgT > 1000) { c.msgT = now; c.msgs = 0; }
    if (++c.msgs > 120) return;                       // flood guard
    if (line.length > 9000) return;
    const a = line.split(' ');
    switch (a[0]) {
      case 'hello': onHello(c, a).catch(e => { log.error('hello failed', e.message); fail(c, 'server'); }); break;
      case 'setname': onSetName(c, a).catch(e => { log.error('setname failed', e.message); send(c, 'err server'); }); break;
      case 'ping': send(c, 'pong ' + String(a[1] || '').slice(0, 20)); break;
      case 'queue':
        if (c.authed && c.prof && c.prof.name && !c.match && !c.lobby) {
          if (gc().maintenance) send(c, 'err maintenance'); else enqueue(c, a[1], a[2] === '1');
        } break;
      case 'leave': leave(c); break;
      case 'rtc': if (c.authed && c.match) voice.handle({ c, a, send, ice: C.ice, find: id => clientsInMatch(c.match, id), log }); break;
      default: if (c.match) onMatchMessage(c, a);
    }
  }

  function enqueue(c, mode, squad) {
    if (!CFG[mode]) { send(c, 'err mode'); return; }
    squad = squad && mode === 'BR';
    const key = mode + (squad ? 'S' : '');
    let l = lobbies.get(key);
    if (!l) { l = { key, mode, squad, list: [], startAt: 0 }; lobbies.set(key, l); }
    l.list.push(c); c.lobby = l; c.mode = mode;
    lobbyTick(l);
  }

  function leave(c) {
    if (c.lobby) { const l = c.lobby; l.list = l.list.filter(x => x !== c); c.lobby = null; lobbyTick(l); }
    if (c.match) removeFromMatch(c);
  }
  function drop(c) {
      if (!clients.has(c.id)) return;
      // in a running match: keep the slot for a while so the player can reconnect
      if (c.match && c.authed && !c.match.over && c.alive) {
        c.gone = true; c.sock = null; graceByUid.set(c.uid, c);
        c.graceTimer = setTimeout(() => { graceByUid.delete(c.uid); leave(c); clients.delete(c.id); }, GRACE);
        if (c.graceTimer.unref) c.graceTimer.unref();
        log.info('player disconnected, slot kept: ' + c.name);
        return;
      }
      leave(c); clients.delete(c.id);
    }

  function lobbyTick(l) {
    const cfg = CFG[l.mode];
    const humans = l.list.filter(c => !c.bot);
    if (humans.length === 0) { l.list = []; l.startAt = 0; l.botAt = 0; return; }
    // nobody else came: after 30 - 72 seconds the lobby is filled with bots
    if (!l.botFilled && humans.length < cfg.min) {
      if (!l.botAt) l.botAt = Date.now() + (30 + Math.random() * 42) * 1000 * T;
      if (Date.now() >= l.botAt && C.bots) {
        const used = new Set(l.list.map(c => String(c.name).toLowerCase()));
        const target = l.mode === 'BR' ? Math.min(cfg.max, 14 + Math.floor(Math.random() * 14) + humans.length) : cfg.max;
        l.list.push(...bots.makeBots(Math.max(0, target - l.list.length), used));
        l.botFilled = true;
        l.startAt = Date.now() + 4000 * T;
      }
    } else if (humans.length >= cfg.min && !l.botFilled) l.botAt = 0;
    const n = l.list.length;
    if (n >= cfg.max) l.startAt = Date.now();
    else if (n >= cfg.min) { if (!l.startAt) l.startAt = Date.now() + cfg.countdown * 1000; }
    else l.startAt = 0;
    const left = l.startAt ? Math.max(0, Math.ceil((l.startAt - Date.now()) / 1000)) : -1;
    for (const c of l.list) send(c, `lobby ${l.mode} ${n} ${cfg.max} ${left}`);
    if (l.startAt && Date.now() >= l.startAt) {
      const players = l.list.splice(0, cfg.max);
      for (const c of players) c.lobby = null;
      l.startAt = 0; l.botAt = 0; l.botFilled = false;
      startMatch(l.mode, l.squad, players);
      if (l.list.length) lobbyTick(l);
    }
  }

  // ---------------------------------------------------------------- match
  function bcast(m, s) { for (const p of m.players) send(p, s); }
  const f1 = v => (Math.round(v * 10) / 10);

  function startMatch(mode, squad, players) {
    const cfg = CFG[mode];
    const m = { id: nextMatch++, mode, squad, cfg, seed: Math.floor(Math.random() * 1000000), players, phase: 'start', t0: Date.now(),
      round: 0, score: [0, 0], roundT: 0, zone: null, over: false, placed: 0 };
    matches.set(m.id, m);
    players.forEach((p, i) => {
      p.match = m; p.hp = 100; p.alive = true; p.kills = 0; p.air = false; p.w = 0; p.x = 0; p.y = 0; p.z = 0; p.yaw = 0; p.pitch = 0;
      p.last = {}; p.dropped = false; p.ready = !!p.bot; p.rewarded = false; p.posAt = 0; p.strikes = 0; p.gone = false;
      if (mode === 'BR') p.team = squad ? Math.floor(i / cfg.teamSize / (squad ? 4 : 1)) : i;
      else p.team = i % 2;
      if (mode === 'BR' && squad) p.team = Math.floor(i / 4);
      p.slot = mode === 'BR' ? i : Math.floor(i / 2);
    });
    for (const p of players) {
      send(p, `start ${mode} ${m.seed} ${p.id} ${p.team} ${players.length}`);
      for (const q of players) send(p, `p ${q.id} ${q.team} ${q.name}`);
    }
    m.phase = 'loading'; m.waiting = true; m.readyBy = Date.now() + 25000 * T;
    m.timer = setInterval(() => tick(m), 100);
  }

  // begins the match once every client has loaded the map (or after a timeout)
  function beginMatch(m) {
    m.waiting = false; m.t0 = Date.now();
    const mode = m.mode;
    if (mode === 'BR') {
      const th = Math.random() * Math.PI * 2, off = (Math.random() - 0.5) * 200, dx = Math.cos(th), dz = Math.sin(th);
      const R = ISL.r + 70;
      m.plane = { x0: ISL.cx + dx * R - dz * off, z0: ISL.cz + dz * R + dx * off, x1: ISL.cx - dx * R - dz * off, z1: ISL.cz - dz * R + dx * off };
      m.phase = 'plane'; m.phaseT = Date.now();
      bcast(m, `plane ${f1(m.plane.x0)} ${f1(m.plane.z0)} ${f1(m.plane.x1)} ${f1(m.plane.z1)} ${PLANE_DUR}`);
      bcast(m, `phase plane`);
      buildZones(m);
    } else {
      newRound(m);
    }
  }

  function buildZones(m) {
    let cx = ISL.cx, cz = ISL.cz, r = ISL.r;
    m.stages = [];
    for (const z of ZONES) {
      const maxOff = Math.max(0, r - z.r) * 0.85, a = Math.random() * Math.PI * 2, d = Math.random() * maxOff;
      const ncx = cx + Math.cos(a) * d, ncz = cz + Math.sin(a) * d;
      m.stages.push({ fromCx: cx, fromCz: cz, fromR: r, toCx: ncx, toCz: ncz, toR: z.r, hold: z.hold * T, shrink: z.shrink * T, dmg: z.dmg });
      cx = ncx; cz = ncz; r = z.r;
    }
  }
  function zoneAt(m, t) { // t seconds since zone start; returns {cx,cz,r,tcx,tcz,tr,dmg,stage}
    let s = 0;
    for (let i = 0; i < m.stages.length; i++) {
      const st = m.stages[i];
      if (t < s + st.hold) return { cx: st.fromCx, cz: st.fromCz, r: st.fromR, tcx: st.toCx, tcz: st.toCz, tr: st.toR, dmg: st.dmg, stage: i };
      if (t < s + st.hold + st.shrink) {
        const k = (t - s - st.hold) / st.shrink;
        return { cx: st.fromCx + (st.toCx - st.fromCx) * k, cz: st.fromCz + (st.toCz - st.fromCz) * k, r: st.fromR + (st.toR - st.fromR) * k, tcx: st.toCx, tcz: st.toCz, tr: st.toR, dmg: st.dmg, stage: i };
      }
      s += st.hold + st.shrink;
    }
    const l = m.stages[m.stages.length - 1];
    return { cx: l.toCx, cz: l.toCz, r: l.toR, tcx: l.toCx, tcz: l.toCz, tr: l.toR, dmg: l.dmg, stage: m.stages.length - 1 };
  }

  function spawnFor(m, p) {
    const teamIdx = m.players.filter(q => q.team === p.team).indexOf(p);
    const x = -3 + teamIdx * 2 + (m.mode === 'DUEL' ? 3 : 0);
    return p.team === 0 ? { x, y: 31.01, z: -30.5, yaw: Math.PI } : { x, y: 31.01, z: 30.5, yaw: 0 };
  }

  function newRound(m) {
    m.round++;
    m.phase = 'freeze'; m.phaseT = Date.now();
    for (const p of m.players) {
      p.hp = 100; p.alive = true;
      const s = spawnFor(m, p);
      p.x = s.x; p.y = s.y; p.z = s.z; p.posAt = 0;
      send(p, `spawn ${s.x} ${s.y} ${s.z} ${s.yaw.toFixed(3)}`);
    }
    bcast(m, `round ${m.round} ${m.score[0]} ${m.score[1]} ${Math.round(5 * T)}`);
    bcast(m, 'phase freeze');
  }

  function aliveTeams(m) { const s = new Set(); for (const p of m.players) if (p.alive) s.add(p.team); return s; }

  function tick(m) {
    if (m.over) return;
    if (m.waiting) {
      if (m.players.every(p => p.ready) || Date.now() > m.readyBy) beginMatch(m);
      return;
    }
    const now = Date.now(), sec = (now - m.phaseT) / 1000;
    m.ticks = (m.ticks || 0) + 1;
    if (bots.tick(m, now) === 'no-humans') return endMatch(m);
    if (m.ticks % 2 === 0) { // 10 Hz snapshot
      const parts = m.players.map(p => `${p.id},${f1(p.x)},${f1(p.y)},${f1(p.z)},${f1(p.yaw)},${f1(p.pitch)},${p.w},${Math.round(p.hp)},${p.air ? 1 : 0},${p.alive ? 1 : 0}`);
      bcast(m, 'snap ' + parts.join(';'));
    }
    if (m.mode === 'BR') {
      const t = (now - m.t0) / 1000;
      if (m.phase === 'plane') {
        if (t > PLANE_DUR * 0.95) { for (const p of m.players) if (!p.dropped) { p.dropped = true; p.air = true; } }
        if (t >= PLANE_DUR) { m.phase = 'fight'; m.phaseT = now; bcast(m, 'phase fight'); }
      }
      if (m.ticks % 10 === 0 && t >= ZONE_START) {
        const z = zoneAt(m, t - ZONE_START);
        bcast(m, `zone ${f1(z.cx)} ${f1(z.cz)} ${f1(z.r)} ${f1(z.tcx)} ${f1(z.tcz)} ${f1(z.tr)} ${z.stage}`);
        for (const p of m.players) {
          if (!p.alive) continue;
          const d = Math.hypot(p.x - z.cx, p.z - z.cz);
          if (d > z.r) damage(m, p, null, z.dmg, 0, -1);
        }
      }
      if (t > PLANE_DUR && !m.over && aliveTeams(m).size <= 1) endMatch(m, [...aliveTeams(m)][0]);
    } else {
      if (m.phase === 'freeze' && sec >= 5 * T) { m.phase = 'fight'; m.phaseT = now; bcast(m, 'phase fight'); }
      else if (m.phase === 'fight') {
        const at = aliveTeams(m);
        if (at.size <= 1 || sec > 100 * T) {
          let win = -1;
          if (at.size === 1) win = [...at][0];
          else { const hp = [0, 0]; for (const p of m.players) if (p.alive) hp[p.team] += p.hp; win = hp[0] === hp[1] ? -1 : (hp[0] > hp[1] ? 0 : 1); }
          if (win >= 0) m.score[win]++;
          bcast(m, `roundend ${win} ${m.score[0]} ${m.score[1]}`);
          m.phase = 'between'; m.phaseT = now;
          if (m.score[0] >= m.cfg.rounds || m.score[1] >= m.cfg.rounds) endMatch(m, m.score[0] > m.score[1] ? 0 : 1);
        }
      } else if (m.phase === 'between' && sec >= 4 * T) newRound(m);
    }
  }

  function endMatch(m, winnerTeam) {
    if (m.over) return;
    m.over = true;
    for (const p of m.players) award(p, winnerTeam !== undefined && p.team === winnerTeam, winnerTeam !== undefined && p.team === winnerTeam ? 1 : (p.place || 0));
    bcast(m, `end ${winnerTeam === undefined ? -1 : winnerTeam}`);
    store.saveMatch({ id: m.id, t: Date.now(), mode: m.mode, seconds: Math.round((Date.now() - m.t0) / 1000), winnerTeam: winnerTeam === undefined ? -1 : winnerTeam,
      players: m.players.filter(p => !p.bot).map(p => ({ uid: p.uid, name: p.name, team: p.team, kills: p.kills || 0, place: p.place || 0 })) });
    clearInterval(m.timer);
    const t = setTimeout(() => { for (const p of m.players) p.match = null; matches.delete(m.id); timers.delete(t); }, 500); timers.add(t);
  }

  function removeFromMatch(c) {
    const m = c.match; c.match = null;
    if (!m) return;
    m.players = m.players.filter(p => p !== c);
    if (c.alive) { c.alive = false; bcast(m, `kill ${c.id} -1 0 0`); }
    if (m.players.length === 0 || !m.players.some(p => !p.bot)) { m.over = true; clearInterval(m.timer); matches.delete(m.id); return; }
    if (m.mode === 'BR' && m.phase !== 'plane' && aliveTeams(m).size <= 1) endMatch(m, [...aliveTeams(m)][0]);
    else if (m.mode !== 'BR' && new Set(m.players.map(p => p.team)).size < 2) endMatch(m, m.players[0].team);
  }

  function damage(m, victim, attacker, amount, head, weapon) {
    if (!victim.alive) return;
    victim.hp -= amount;
    bcast(m, `dmg ${victim.id} ${Math.max(0, Math.round(victim.hp))} ${attacker ? attacker.id : -1} ${head}`);
    if (victim.hp <= 0) {
      victim.alive = false; victim.hp = 0;
      if (attacker) attacker.kills++;
      bcast(m, `kill ${victim.id} ${attacker ? attacker.id : -1} ${weapon} ${head}`);
      if (m.mode === 'BR') { victim.place = aliveTeams(m).size + 1; send(victim, `place ${victim.place}`); award(victim, false, victim.place); }
    }
  }

  function onMatchMessage(c, a) {
    const m = c.match;
    if (m.over) return;
    switch (a[0]) {
      case 'pos': // pos x y z yaw pitch weapon air
        if (!c.alive) return;
        if (m.phase === 'freeze' || m.phase === 'between') return;
        { const x = +a[1], y = +a[2], z = +a[3];
          if (![x, y, z].every(Number.isFinite) || Math.abs(x) > 2000 || Math.abs(z) > 2000 || y < -50 || y > 400) return;
          // anti-cheat: no teleporting. Walking/sprinting is limited; flying with the plane or parachute is exempt.
          const now = Date.now(), airNow = a[7] === '1';
          if (C.antiCheat && c.posAt && !airNow && !c.prevAir && m.phase !== 'plane') {
            const dt = Math.min(2, (now - c.posAt) / 1000), d = Math.hypot(x - c.x, z - c.z);
            if (d > 24 * dt + 8) {
              if (now - (c.strikeT || 0) > 10000) { c.strikes = 0; c.strikeT = now; }
              if (++c.strikes > 20) { log.warn('speed hack suspected: ' + c.name); fail(c, 'cheat'); }
              return;
            }
          }
          c.posAt = now; c.prevAir = airNow;
          c.x = x; c.y = y; c.z = z; c.yaw = +a[4] || 0; c.pitch = +a[5] || 0; c.w = (+a[6] | 0) % WEAPONS.length; c.air = a[7] === '1'; }
        break;
      case 'ready': c.ready = true; break;
      case 'drop':
        if (m.mode === 'BR' && m.phase === 'plane' && !c.dropped) { c.dropped = true; c.air = true; }
        break;
      case 'shot': // shot weapon ox oy oz dx dy dz   (tracer for others)
        if (!c.alive || m.phase === 'freeze' || m.phase === 'between') return;
        for (const p of m.players) if (p !== c) send(p, `shot ${c.id} ${a.slice(1, 8).join(' ')}`);
        break;
      case 'hit': { // hit victim weapon head dist pellets
        const v = clientsInMatch(m, +a[1]), w = WEAPONS[+a[2] | 0];
        if (!v || !w || !c.alive || !v.alive || v === c) return;
        if (m.phase === 'freeze' || m.phase === 'between' || (m.mode === 'BR' && m.phase === 'plane')) return;
        if (v.team === c.team) return;                                  // no friendly fire
        if (c.air || v.air) return;                                     // nobody is hurt while parachuting
        const pel = Math.max(1, Math.min(w.pellets, +a[5] | 0 || 1));
        const dist = v.bot ? Math.hypot(c.x - v.x, c.z - v.z) : Math.hypot(c.x - v.x, c.y - v.y, c.z - v.z);
        if (dist > w.range + 8) return;                                 // too far for this weapon (server-known positions)
        const now = Date.now(), last = c.last[w.id] || 0;
        if (now - last < 1000 / w.rate * 0.6) return;                   // fire-rate limit
        c.last[w.id] = now;
        const head = a[3] === '1' ? 1 : 0;
        damage(m, v, c, Math.round(w.dmg * pel * (head ? 1.8 : 1)), head, w.id);
        break; }
      default: break;
    }
  }
  function clientsInMatch(m, id) { return m.players.find(p => p.id === id); }


  // ---------------------------------------------------------------- admin helpers
  function stats() {
    return {
      clients: [...clients.values()].filter(c => c.authed).map(c => ({ id: c.id, uid: c.uid, name: c.name, mode: c.match ? c.match.mode : c.lobby ? 'queue:' + c.lobby.mode : 'menu', matchId: c.match ? c.match.id : null, connected: !c.gone, ip: c.ip })),
      lobbies: [...lobbies.values()].map(l => ({ key: l.key, mode: l.mode, squad: l.squad, players: l.list.length })),
      matches: [...matches.values()].map(m => ({ id: m.id, mode: m.mode, phase: m.phase, players: m.players.length, alive: m.players.filter(p => p.alive).length, seconds: Math.round((Date.now() - m.t0) / 1000), round: m.round, score: m.score })),
    };
  }
  function kick(uid, why) {
    let n = 0;
    for (const c of clients.values()) if (c.uid === uid) { n++; send(c, 'err ' + (why || 'kicked')); const s = c.sock; leave(c); if (s) setTimeout(() => { try { s.end(); } catch (e) { /* */ } }, 50); c.authed = false; }
    return n;
  }
  function close() {
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    for (const m of matches.values()) clearInterval(m.timer);
    for (const c of clients.values()) { clearTimeout(c.graceTimer); if (c.sock) c.sock.destroy(); }
  }

  return { attach, stats, kick, close, CFG, _clients: clients };
}

module.exports = { createGame };
