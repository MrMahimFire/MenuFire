'use strict';
// Server-side bots: they fill an empty lobby after a wait, move around, and pester real players with
// light damage. A bot can never kill a real player (damage stops while the player has 35 HP or less).
const NAMES = ['Rafi_BD', 'Sakib77', 'NoorX', 'Tanvir09', 'Mahi_Pro', 'Shuvo22', 'Arif_FF', 'Jisan1', 'Rakib_X', 'Sabbir88', 'Nayeem5', 'Fahim_Z',
  'Imran07', 'Tamim_K', 'Hridoy3', 'Sohan_Y', 'Riyad12', 'Anik_BD', 'Mehedi9', 'Zubayer', 'Nirob44', 'Emon_FF', 'Shakil6', 'Rony_X', 'Masum31',
  'Parvez8', 'Alamin2', 'Joy_Pro', 'Sumon55', 'Habib_BD', 'Robin17', 'Tuhin_Z', 'Raihan4', 'Faisal_K', 'Munna90', 'Babu_FF', 'Opu_X', 'Shamim6', 'Naim_Pro', 'Rubel21'];
const BOT_BASE = 900000;
const MIN_HP_FOR_HUMANS = 35;

function create({ T, ISL, PLANE_DUR, ZONE_START, zoneAt, damage, bcast, f1 }) {
  let seq = 0;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function makeBots(n, used) {
    const out = [];
    const pool = NAMES.filter(x => !used.has(x.toLowerCase()));
    for (let i = 0; i < n; i++) {
      const name = pool.length ? pool.splice(Math.floor(Math.random() * pool.length), 1)[0] : 'Bot' + (seq + 1);
      out.push({ id: BOT_BASE + (seq++), bot: true, name, uid: '', authed: true, ready: true, kills: 0, last: {}, w: 1 });
    }
    return out;
  }

  function lightHit(m, h, b) {
    if (h.hp <= MIN_HP_FOR_HUMANS) return;
    const amt = Math.min(Math.round(rand(2, 5)), h.hp - MIN_HP_FOR_HUMANS);
    if (amt > 0) damage(m, h, b, amt, 0, 1);
  }

  function walkTo(b, tx, tz, speed, dt) {
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz);
    if (d < 0.5) return true;
    const s = Math.min(d, speed * dt);
    b.x += dx / d * s; b.z += dz / d * s; b.yaw = Math.atan2(dx, -dz);
    return false;
  }

  /** called from the match tick every 100 ms */
  function tick(m, now) {
    const dt = 0.1, t = (now - m.t0) / 1000;
    const humans = m.players.filter(p => !p.bot && p.alive);
    for (const b of m.players) {
      if (!b.bot || !b.alive) continue;
      const br = m.mode === 'BR';
      if (br && m.phase === 'plane') {
        const k = clamp(t / PLANE_DUR, 0, 1), pl = m.plane;
        if (b.dropAt === undefined) { b.dropAt = rand(0.28, 0.9) * PLANE_DUR; const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 330; b.land = [ISL.cx + Math.cos(a) * r, ISL.cz + Math.sin(a) * r]; }
        if (!b.dropped) {
          b.x = pl.x0 + (pl.x1 - pl.x0) * k; b.z = pl.z0 + (pl.z1 - pl.z0) * k; b.y = 130; b.air = true;
          if (t >= b.dropAt) { b.dropped = true; b.dropT = now; b.fx = b.x; b.fz = b.z; }
        }
      }
      if (br && b.dropped && b.air) {
        const e = (now - b.dropT) / 1000, k = clamp(e / 14, 0, 1);
        b.x = b.fx + (b.land[0] - b.fx) * k; b.z = b.fz + (b.land[1] - b.fz) * k; b.y = 130 - 126 * k;
        if (k >= 1) { b.air = false; b.y = 0; }
        continue;
      }
      if (br && !b.dropped) continue;
      if (!br) b.y = 31.01;
      if (m.phase === 'freeze' || m.phase === 'between' || m.phase === 'loading') continue;
      // find the nearest living, grounded human
      let near = null, nd = 1e9;
      for (const h of humans) { if (h.air) continue; const d = Math.hypot(h.x - b.x, h.z - b.z); if (d < nd) { nd = d; near = h; } }
      let zx = ISL.cx, zz = ISL.cz, zr = ISL.r;
      if (br && t >= ZONE_START && m.stages) { const z = zoneAt(m, t - ZONE_START); zx = z.cx; zz = z.cz; zr = z.r; }
      const outZone = br && Math.hypot(b.x - zx, b.z - zz) > zr * 0.85;
      let sp = 3.4;
      if (outZone) { walkTo(b, zx, zz, 4.5, dt); }
      else if (near && nd < (br ? 130 : 60) && nd > 14) { walkTo(b, near.x, near.z, sp, dt); }
      else if (near && nd <= 14) { b.yaw = Math.atan2(near.x - b.x, -(near.z - b.z)); const s = Math.sin(now / 700 + b.id) * 2 * dt; b.x += Math.cos(b.yaw) * s; b.z += Math.sin(b.yaw) * s; }
      else {
        if (!b.wp || Math.random() < 0.01) { const a = Math.random() * 6.283, r = br ? Math.sqrt(Math.random()) * Math.min(zr * 0.8, 330) : rand(0, 22); b.wp = br ? [zx + Math.cos(a) * r, zz + Math.sin(a) * r] : [Math.cos(a) * r, (b.team === 0 ? -1 : 1) * rand(4, 26)]; }
        if (walkTo(b, b.wp[0], b.wp[1], 2.2, dt)) b.wp = null;
      }
      if (!br) { b.x = clamp(b.x, -30, 30); b.z = clamp(b.z, -30, 30); }
      else { const d = Math.hypot(b.x - ISL.cx, b.z - ISL.cz); if (d > 380) { b.x = ISL.cx + (b.x - ISL.cx) * 380 / d; b.z = ISL.cz + (b.z - ISL.cz) * 380 / d; } }
      // light shooting at the nearest human
      const range = br ? 55 : 45;
      if (near && nd < range && m.phase === 'fight' && now >= (b.nextShot || 0)) {
        b.nextShot = now + rand(1100, 2200);
        const oy = near.y + 1.6, dx = near.x - b.x, dy = (near.y + 1.3) - oy, dz = near.z - b.z, l = Math.hypot(dx, dy, dz) || 1;
        bcast(m, `shot ${b.id} 1 ${f1(b.x)} ${f1(oy)} ${f1(b.z)} ${(dx / l).toFixed(3)} ${(dy / l).toFixed(3)} ${(dz / l).toFixed(3)}`);
        if (Math.random() < 0.55) lightHit(m, near, b);
      }
      // battle royale: bots drop out over time so a real player can win
      if (br && m.phase === 'fight') {
        if (b.dieAt === undefined) b.dieAt = t + rand(70, 360) * T;
        if (t >= b.dieAt) damage(m, b, null, 999, 0, -1);
      }
    }
    // everyone human is dead: the match is over
    if (m.players.some(p => p.bot) && !m.players.some(p => !p.bot && p.alive) && m.mode === 'BR' && m.phase === 'fight') return 'no-humans';
    return null;
  }

  return { makeBots, tick, BOT_BASE };
}

module.exports = { create, BOT_BASE };
