'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, player, http, sleep, Client } = require('./helpers');

async function duel(s, an = 'Alice', bn = 'Bobby') {
  const a = await player(s, 'ua_' + an, an), b = await player(s, 'ub_' + bn, bn);
  a.send('queue DUEL 0'); b.send('queue DUEL 0');
  await a.until(m => m.startsWith('start DUEL')); await b.until(m => m.startsWith('start DUEL'));
  a.send('ready'); b.send('ready');
  await a.until(m => m === 'phase fight', 8000); await b.until(m => m === 'phase fight', 8000);
  const idA = +a.last('start').split(' ')[3], idB = +b.last('start').split(' ')[3];
  return { a, b, idA, idB };
}

test('profile + name: required before queueing, unique, validated', async () => {
  const s = await start();
  const c = await player(s, 'n1', '');
  c.send('queue DUEL 0');
  await sleep(150);
  assert.ok(!c.has('lobby'), 'no queue without a name');
  c.send('setname ab'); assert.ok(await c.until(m => m === 'err name_invalid'));
  c.send('setname bad-name!'); assert.ok(await c.until(m => m === 'err name_invalid'));
  c.send('setname ThirteenChars'); assert.ok((await c.until(m => m === 'err name_invalid')));
  c.send('setname Neo99'); assert.ok(await c.until(m => m.startsWith('profile Neo99')));
  c.send('setname Other'); assert.ok(await c.until(m => m === 'err name_locked'));
  const d = await player(s, 'n2', '');
  d.send('setname neo99'); assert.ok(await d.until(m => m === 'err name_taken'), 'case-insensitive unique');
  const p = await s.store.getPlayer('n1');
  assert.equal(p.name, 'Neo99');
  c.close(); d.close(); await s.close();
});

test('room: two players queue, match starts, teams differ, lobby counts', async () => {
  const s = await start();
  const a = await player(s, 'r1', 'Aaa'), b = await player(s, 'r2', 'Bbb');
  a.send('queue DUEL 0');
  assert.ok(await a.until(m => m.startsWith('lobby DUEL 1 2')));
  b.send('queue DUEL 0');
  const sa = await a.until(m => m.startsWith('start DUEL')), sb = await b.until(m => m.startsWith('start DUEL'));
  assert.ok(sa && sb);
  assert.equal(sa.split(' ')[2], sb.split(' ')[2], 'same seed');
  assert.notEqual(sa.split(' ')[4], sb.split(' ')[4], 'different teams');
  assert.ok(await a.until(m => m.startsWith('p ') && m.endsWith('Bbb')), 'roster lists the other player');
  const rooms = await http(s, 'GET', '/api/admin/rooms', { token: 'tok:boss:admin' });
  assert.equal(rooms.body.matches.length, 1);
  a.close(); b.close(); await s.close();
});

test('multiplayer events: positions sync, shots relay, server validates damage', async () => {
  const s = await start();
  const { a, b, idA, idB } = await duel(s);
  a.send('pos 1 31 -30 0 0 2 0'); b.send('pos 1 31 -20 0 0 2 0');
  assert.ok(await b.until(m => m.startsWith('snap') && m.includes(`${idA},1,31,-30`)), 'B sees A position in snapshots');
  a.send('shot 2 1 31 -30 0 0 1'); assert.ok(await b.until(m => m.startsWith('shot ' + idA)), 'shot tracer relayed');
  a.send(`hit ${idB} 2 0 10 1`);
  assert.ok(await b.until(m => m === `dmg ${idB} 78 ${idA} 0`), 'rifle body hit = 22 damage');
  a.send(`hit ${idB} 2 0 10 1`); await sleep(50);
  assert.ok(!b.msgs.includes(`dmg ${idB} 56 ${idA} 0`), 'instant repeat ignored (fire rate)');
  await sleep(200);
  a.send(`hit ${idB} 2 1 10 1`);
  assert.ok(await b.until(m => m === `dmg ${idB} 38 ${idA} 1`), 'headshot x1.8');
  // client cannot damage itself / unknown ids / garbage
  a.send(`hit ${idA} 2 0 1 1`); a.send('hit 999 2 0 1 1'); a.send('hit x y z'); await sleep(100);
  assert.ok(!a.msgs.some(m => m.startsWith(`dmg ${idA}`)));
  a.close(); b.close(); await s.close();
});

test('server uses its own positions: a shotgun hit from 60 blocks away is rejected', async () => {
  const s = await start();
  const { a, b, idA, idB } = await duel(s, 'Faraa', 'Farbb');
  a.send('pos 1 31 -30 0 0 3 0'); b.send('pos 1 31 30 0 0 3 0');
  await sleep(250);
  a.send(`hit ${idB} 3 0 5 8`); await sleep(200);
  assert.ok(!b.msgs.some(m => m.startsWith(`dmg ${idB}`)), 'out of range (client claimed 5 blocks)');
  a.close(); b.close(); await s.close();
});

test('match result: winner gets coins/xp saved, result stored, quitters get nothing', async () => {
  const s = await start();
  const { a, b, idA, idB } = await duel(s, 'Winner', 'Loser');
  for (let r = 0; r < 4; r++) {
    a.send('pos 1 31 -30 0 0 2 0'); b.send('pos 1 31 -20 0 0 2 0');
    await sleep(120);
    for (let i = 0; i < 6; i++) { a.send(`hit ${idB} 2 0 10 1`); await sleep(160); }
    if (a.has('end')) break;
    await a.until(m => m === 'phase fight' && a.msgs.lastIndexOf(m) > a.msgs.lastIndexOf('phase freeze'), 9000);
  }
  assert.ok(await a.until(m => m.startsWith('end '), 15000), 'match ends');
  const rw = await a.until(m => m.startsWith('reward '));
  assert.ok(rw, 'winner receives a reward line');
  await sleep(300);
  const pa = await s.store.getPlayer('ua_Winner');
  assert.ok(pa.coins > 200 && pa.wins === 1 && pa.kills >= 2 && pa.matches === 1, JSON.stringify(pa));
  const pb = await s.store.getPlayer('ub_Loser');
  assert.equal(pb.wins, 0); assert.equal(pb.matches, 1);
  await sleep(100);
  const saved = await s.store.recentMatches(5);
  assert.equal(Object.keys(saved).length, 1);
  assert.equal(Object.values(saved)[0].players.length, 2);
  a.close(); b.close(); await s.close();
});

test('invalid input: garbage, huge lines, floods and NaN positions do not break the server', async () => {
  const s = await start();
  const c = new Client(s.url); await c.opened;
  const h = new Client(s.url); await h.opened;
  for (const g of ['hello', 'hello ' + 'x'.repeat(5000), 'hello a b']) h.send(g);   // bad logins are refused, not crashed on
  assert.ok(await h.until(m => m === 'err auth'));
  for (const g of ['', ' ', 'queue', 'rtc', '\u0000\u0001', 'pos NaN NaN NaN', 'drop', 'ready', 'hit', 'setname', 'ping']) c.send(g);
  c.send('x'.repeat(20000));
  for (let i = 0; i < 400; i++) c.send('ping ' + i);
  await sleep(300);
  assert.ok(c.has('pong'), 'still responding');
  assert.ok(!c.closed);
  assert.equal((await http(s, 'GET', '/health')).status, 200);
  const d = await player(s, 'iv1', 'Valid');
  d.send('queue NOPE 0'); assert.ok(await d.until(m => m === 'err mode'));
  d.send('pos 1 2 3'); d.send('queue DUEL 0'); d.send('queue DUEL 0'); d.send('leave'); d.send('leave');
  await sleep(150);
  c.close(); d.close(); await s.close();
});

test('heartbeat: ping returns the same token (latency measurement)', async () => {
  const s = await start();
  const c = new Client(s.url); await c.opened;
  c.send('ping 12345');
  assert.ok(await c.until(m => m === 'pong 12345'));
  c.close(); await s.close();
});

test('reconnection: dropped player gets the slot back with match state', async () => {
  const s = await start();
  const { a, b, idA } = await duel(s, 'Rejoin', 'Stays');
  const startMsg = a.last('start');
  a.close();
  await sleep(200);
  const st = s.game.stats();
  assert.equal(st.matches.length, 1, 'match continues');
  assert.equal(st.clients.find(c => c.uid === 'ua_Rejoin').connected, false, 'slot marked disconnected');
  const a2 = new Client(s.url); await a2.opened;
  a2.send('hello ua_Rejoin Rejoin tok:ua_Rejoin');
  const w = await a2.until(m => m.startsWith('welcome'));
  assert.equal(w, 'welcome ' + idA, 'same player id');
  assert.ok(await a2.until(m => m.startsWith('start DUEL')), 'match start info resent');
  assert.equal(a2.last('start').split(' ')[2], startMsg.split(' ')[2], 'same seed');
  assert.ok(await a2.until(m => m.startsWith('rejoin ')));
  a2.send('pos 1 31 -30 0 0 2 0');
  assert.ok(await b.until(m => m.startsWith('snap') && m.includes(`${idA},1,31,-30`)), 'other player sees the returned player');
  assert.equal(s.game.stats().clients.find(c => c.uid === 'ua_Rejoin').connected, true);
  a2.close(); b.close(); await s.close();
});

test('reconnection: slot is freed after the grace period', async () => {
  const s = await start();
  const { a, b } = await duel(s, 'Gone', 'Left');
  a.close();
  await sleep(3500);                       // FAST timers: grace = 3 s
  assert.equal(s.game.stats().clients.some(c => c.uid === 'ua_Gone'), false);
  assert.ok(await b.until(m => m.startsWith('end ')), 'remaining player wins when the other never returns');
  b.close(); await s.close();
});

test('same account logged in twice: newer connection wins', async () => {
  const s = await start();
  const a = await player(s, 'dup1', 'Dupe');
  const a2 = new Client(s.url); await a2.opened;
  a2.send('hello dup1 Dupe tok:dup1');
  assert.ok(await a.until(m => m === 'err replaced'));
  assert.ok(await a2.until(m => m.startsWith('welcome')));
  assert.equal(s.game.stats().clients.length, 1);
  a.close(); a2.close(); await s.close();
});

test('anti-cheat: teleporting is ignored, walking is accepted', async () => {
  const s = await start();
  const { a, b, idA } = await duel(s, 'Tele', 'Watch');
  a.send('pos 0 31 -30 0 0 2 0'); await sleep(150);
  a.send('pos 0 31 -29 0 0 2 0'); await sleep(150);
  a.send('pos 400 31 400 0 0 2 0'); await sleep(250);
  const snap = b.last('snap');
  assert.ok(!snap.includes(`${idA},400,`), 'teleport not applied: ' + snap);
  assert.ok(snap.includes(`${idA},0,31,-29`) || snap.includes(`${idA},0.0,31`) , 'last valid position kept: ' + snap);
  a.close(); b.close(); await s.close();
});

test('CS: no friendly fire, enemies can be hurt', async () => {
  const s = await start({ MIN_CS: '4' });
  const ps = [];
  for (let i = 0; i < 4; i++) ps.push(await player(s, 'cs' + i, 'Csp' + i));
  ps.forEach(p => p.send('queue CS 0'));
  for (const p of ps) await p.until(m => m.startsWith('start CS'), 6000);
  ps.forEach(p => p.send('ready'));
  for (const p of ps) await p.until(m => m === 'phase fight', 9000);
  const info = ps.map(p => p.last('start').split(' ')); // start CS seed id team total
  const id = i => +info[i][3], team = i => info[i][4];
  const mate = [1, 2, 3].find(j => team(j) === team(0)), foe = [1, 2, 3].find(j => team(j) !== team(0));
  ps.forEach((p, i) => p.send(`pos ${i} 31 ${team(i) === '0' ? -30 : 30} 0 0 2 0`));
  await sleep(200);
  ps[0].send(`hit ${id(mate)} 2 0 5 1`); await sleep(150);
  assert.ok(!ps[mate].msgs.some(m => m.startsWith(`dmg ${id(mate)}`)), 'teammate unharmed');
  ps[0].send(`hit ${id(foe)} 2 0 5 1`);
  assert.ok(await ps[foe].until(m => m.startsWith(`dmg ${id(foe)} 78`)) || await ps[foe].until(m => m.startsWith(`dmg ${id(foe)}`)), 'enemy hurt');
  ps.forEach(p => p.close()); await s.close();
});

test('battle royale: plane, drop, no damage while parachuting, zone announced', async () => {
  const s = await start({ MIN_BR: '3' });
  const ps = [];
  for (let i = 0; i < 3; i++) ps.push(await player(s, 'br' + i, 'Brp' + i));
  ps.forEach(p => p.send('queue BR 0'));
  for (const p of ps) await p.until(m => m.startsWith('start BR'), 8000);
  ps.forEach(p => p.send('ready'));
  assert.ok(await ps[0].until(m => m.startsWith('plane '), 6000), 'plane route');
  ps[0].send('drop');
  const id1 = +ps[1].last('start').split(' ')[3];
  ps[1].send('drop'); await sleep(100);
  ps[0].send(`hit ${id1} 2 0 5 1`); await sleep(100);
  assert.ok(!ps[1].msgs.some(m => m.startsWith(`dmg ${id1}`)), 'no damage during plane phase / parachute');
  assert.ok(await ps[0].until(m => m.startsWith('zone '), 12000), 'zone broadcast');
  ps.forEach(p => p.close()); await s.close();
});
