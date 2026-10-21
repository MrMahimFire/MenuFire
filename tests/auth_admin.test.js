'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, http, Client, player, sleep } = require('./helpers');

test('websocket: bad token is refused, good token gets welcome + starter profile', async () => {
  const s = await start();
  const bad = new Client(s.url); await bad.opened;
  bad.send('hello u1 Bob garbage');
  assert.ok(await bad.until(m => m === 'err auth'), 'err auth');
  const c = new Client(s.url); await c.opened;
  c.send('hello u2 Bob tok:u2');
  assert.ok(await c.until(m => m.startsWith('welcome')));
  const p = await c.until(m => m.startsWith('profile '));
  assert.equal(p, 'profile - 1 0 100 200 20 0 0 0');
  // a token for another account does not work with someone else's uid
  const x = new Client(s.url); await x.opened;
  x.send('hello u3 Eve tok:u2');
  assert.ok(await x.until(m => m === 'err auth'));
  [bad, c, x].forEach(k => k.close());
  await s.close();
});

test('admin API: no token 401, normal user 403, admin 200', async () => {
  const s = await start();
  assert.equal((await http(s, 'GET', '/api/admin/overview')).status, 401);
  assert.equal((await http(s, 'GET', '/api/admin/overview', { token: 'garbage' })).status, 401);
  assert.equal((await http(s, 'GET', '/api/admin/overview', { token: 'tok:normal' })).status, 403);
  const ok = await http(s, 'GET', '/api/admin/overview', { token: 'tok:boss:admin' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.online, 0);
  // role must come from the server: a client-sent flag changes nothing
  const r = await fetch(s.http + '/api/admin/overview?isAdmin=true', { headers: { Authorization: 'Bearer tok:normal', 'X-Is-Admin': 'true' } });
  assert.equal(r.status, 403);
  await s.close();
});

test('admin via ADMIN_UIDS list and via database role', async () => {
  const s = await start({ ADMIN_UIDS: 'listed' });
  assert.equal((await http(s, 'GET', '/api/admin/overview', { token: 'tok:listed' })).status, 200);
  await s.store.backend.set('admins/dbadmin', true);
  assert.equal((await http(s, 'GET', '/api/admin/overview', { token: 'tok:dbadmin' })).status, 200);
  await s.close();
});

test('admin can see players, ban (kicks) and unban', async () => {
  const s = await start();
  const t = 'tok:boss:admin';
  const c = await player(s, 'victim1', 'Victim');
  const online = await http(s, 'GET', '/api/admin/players/online', { token: t });
  assert.equal(online.body.length, 1);
  assert.equal(online.body[0].name, 'Victim');
  const info = await http(s, 'GET', '/api/admin/players/victim1', { token: t });
  assert.equal(info.body.profile.coins, 200);
  const ban = await http(s, 'POST', '/api/admin/players/victim1/ban', { token: t, body: { reason: 'cheating' } });
  assert.equal(ban.body.kicked, 1);
  assert.ok(await c.until(m => m === 'err banned'), 'kicked with banned');
  await sleep(100);
  const again = new Client(s.url); await again.opened;
  again.send('hello victim1 Victim tok:victim1');
  assert.ok(await again.until(m => m === 'err banned'), 'cannot come back');
  assert.equal((await http(s, 'GET', '/api/admin/players/victim1', { token: t })).body.ban.reason, 'cheating');
  await http(s, 'POST', '/api/admin/players/victim1/unban', { token: t, body: {} });
  const back = new Client(s.url); await back.opened;
  back.send('hello victim1 Victim tok:victim1');
  assert.ok(await back.until(m => m.startsWith('welcome')), 'unbanned player is back');
  assert.equal((await http(s, 'POST', '/api/admin/players/bad%20uid!/ban', { token: t, body: {} })).status, 400);
  [c, again, back].forEach(k => k.close());
  await s.close();
});

test('admin config: validation, maintenance mode blocks logins', async () => {
  const s = await start();
  const t = 'tok:boss:admin';
  assert.equal((await http(s, 'PUT', '/api/admin/config', { token: t, body: { maintenance: 'yes' } })).status, 400);
  assert.equal((await http(s, 'PUT', '/api/admin/config', { token: t, body: { minBR: 0 } })).status, 400);
  assert.equal((await http(s, 'PUT', '/api/admin/config', { token: t, body: { hack: 1 } })).status, 400);
  assert.equal((await http(s, 'PUT', '/api/admin/config', { token: t, body: '{not json' })).status, 400);
  const r = await http(s, 'PUT', '/api/admin/config', { token: t, body: { maintenance: true, motd: 'back soon' } });
  assert.equal(r.body.maintenance, true);
  const c = new Client(s.url); await c.opened;
  c.send('hello m1 Maint tok:m1');
  assert.ok(await c.until(m => m === 'err maintenance'));
  assert.equal((await http(s, 'GET', '/api/public-config')).body.maintenance, true);
  await http(s, 'PUT', '/api/admin/config', { token: t, body: { maintenance: false } });
  const logs = await http(s, 'GET', '/api/admin/logs?n=20', { token: t });
  assert.ok(Array.isArray(logs.body) && logs.body.some(l => /changed config/.test(l.msg)));
  c.close(); await s.close();
});

test('admin API is rate limited', async () => {
  const s = await start();
  let last = 0;
  for (let i = 0; i < 70; i++) last = (await http(s, 'GET', '/api/admin/overview')).status;
  assert.equal(last, 429);
  await s.close();
});
