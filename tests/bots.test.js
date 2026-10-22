'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, player, sleep } = require('./helpers');
const botsLib = require('../sockets/bots');

test('bots: an empty lobby is filled after the wait and the match starts with bots in the roster', async () => {
  const s = await start({ MIN_BR: '5' });
  const a = await player(s, 'b1', 'Solo');
  a.send('queue BR 0');
  assert.ok(await a.until(m => m.startsWith('lobby BR 1 ')));
  const st = await a.until(m => m.startsWith('start BR'), 15000);
  assert.ok(st, 'match started although nobody else joined');
  const total = +st.split(' ')[5];
  assert.ok(total >= 15 && total <= 50, 'many players: ' + total);
  const roster = a.msgs.filter(m => m.startsWith('p '));
  const bots = roster.filter(m => +m.split(' ')[1] >= botsLib.BOT_BASE);
  assert.equal(roster.length, total);
  assert.equal(bots.length, total - 1);
  a.send('ready');
  assert.ok(await a.until(m => m.startsWith('snap ') && m.includes(String(botsLib.BOT_BASE)), 8000), 'bots appear in snapshots');
  a.close(); await s.close();
});

test('bots: a bot never kills a real player (light damage only) and bots never run when nobody is alive', () => {
  const log = [];
  const m = { mode: 'BR', phase: 'fight', t0: Date.now() - 10000, players: [], stages: [], plane: null };
  const human = { id: 1, alive: true, air: false, x: 10, y: 30, z: 10, hp: 100, team: 0 };
  const bot = { id: 900001, bot: true, alive: true, dropped: true, air: false, x: 10, y: 0, z: 12, team: 1, hp: 100, nextShot: 0 };
  m.players = [human, bot];
  const lib = botsLib.create({ T: 1, ISL: { cx: 48, cz: 48, r: 450 }, PLANE_DUR: 40, ZONE_START: 1e9, zoneAt: () => ({ cx: 48, cz: 48, r: 450 }),
    damage: (mm, v, a, amt) => { v.hp -= amt; if (!v.bot) log.push(amt); }, bcast: () => {}, f1: v => v });
  for (let i = 0; i < 5000; i++) { bot.nextShot = 0; lib.tick(m, Date.now() + i * 100); }
  assert.ok(log.length >= 5 && human.hp < 100, 'the bot does shoot');
  assert.ok(human.hp >= 35, 'player is not killed: ' + human.hp);
  assert.ok(log.every(a => a >= 1 && a <= 5), 'every hit is small');
  human.alive = false;
  assert.equal(lib.tick(m, Date.now()), 'no-humans');
});
