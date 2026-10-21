'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, player, sleep } = require('./helpers');

async function pair(s) {
  const a = await player(s, 'va', 'Voa'), b = await player(s, 'vb', 'Vob'), out = await player(s, 'vc', 'Voc');
  a.send('queue DUEL 0'); b.send('queue DUEL 0');
  await a.until(m => m.startsWith('start')); await b.until(m => m.startsWith('start'));
  return { a, b, out, idA: +a.last('start').split(' ')[3], idB: +b.last('start').split(' ')[3] };
}

test('voice/video signalling: config, join, offer/answer/ice relay inside a match only', async () => {
  const s = await start({ TURN_URL: 'turn:turn.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  const { a, b, out, idA, idB } = await pair(s);
  a.send('rtc config');
  const cfg = await a.until(m => m.startsWith('rtc config '));
  const ice = JSON.parse(Buffer.from(cfg.split(' ')[2], 'base64').toString());
  assert.ok(ice.some(x => /stun/.test(JSON.stringify(x.urls))) && ice.some(x => x.username === 'u'), 'STUN + TURN listed');
  a.send('rtc join'); assert.ok(await b.until(m => m === 'rtc peer_join ' + idA));
  const sdp = Buffer.from('v=0 fake sdp').toString('base64');
  a.send(`rtc offer ${idB} ${sdp}`); assert.ok(await b.until(m => m === `rtc offer ${idA} ${sdp}`));
  b.send(`rtc answer ${idA} ${sdp}`); assert.ok(await a.until(m => m === `rtc answer ${idB} ${sdp}`));
  a.send(`rtc ice ${idB} ${Buffer.from('{"c":1}').toString('base64')}`); assert.ok(await b.until(m => m.startsWith('rtc ice ' + idA)));
  a.send('rtc mute 1'); assert.ok(await b.until(m => m === `rtc mute ${idA} 1`));
  // outsiders and bad payloads are not relayed
  out.send(`rtc offer ${idB} ${sdp}`); a.send(`rtc offer ${idB} not*base64!`); a.send(`rtc offer ${idB} ${'A'.repeat(9000)}`); a.send(`rtc offer ${idA} ${sdp}`);
  await sleep(200);
  assert.equal(b.msgs.filter(m => m.startsWith('rtc offer')).length, 1);
  a.send('rtc leave'); assert.ok(await b.until(m => m === 'rtc peer_leave ' + idA));
  [a, b, out].forEach(c => c.close()); await s.close();
});
