'use strict';
// WebRTC signalling for voice/video inside a match. The server only RELAYS small messages (SDP / ICE) between
// players of the same match. Audio and video themselves travel peer-to-peer (STUN) or through a TURN server.
//
// Client -> server                     Server -> client
//   rtc config                           rtc config <base64 json of iceServers>
//   rtc join                             rtc peer_join <id>        (to the other players of the match)
//   rtc leave                            rtc peer_leave <id>
//   rtc offer  <toId> <base64 sdp>       rtc offer  <fromId> <base64 sdp>
//   rtc answer <toId> <base64 sdp>       rtc answer <fromId> <base64 sdp>
//   rtc ice    <toId> <base64 json>      rtc ice    <fromId> <base64 json>
//   rtc mute   <0|1>                     rtc mute   <fromId> <0|1>
const MAX_PAYLOAD = 8000;
const B64 = /^[A-Za-z0-9+/=_-]*$/;

function iceServers(ice) {
  const list = [];
  if (ice.stun.length) list.push({ urls: ice.stun });
  if (ice.turnUrl) list.push({ urls: ice.turnUrl.split(',').map(s => s.trim()), username: ice.turnUser, credential: ice.turnCred });
  return list;
}

function handle({ c, a, send, ice, find }) {
  const m = c.match;
  if (!m || m.over) return;
  const type = a[1];
  const others = () => m.players.filter(p => p !== c);
  switch (type) {
    case 'config': send(c, 'rtc config ' + Buffer.from(JSON.stringify(iceServers(ice))).toString('base64')); break;
    case 'join': c.inCall = true; for (const p of others()) send(p, 'rtc peer_join ' + c.id); break;
    case 'leave': c.inCall = false; for (const p of others()) send(p, 'rtc peer_leave ' + c.id); break;
    case 'mute': for (const p of others()) send(p, `rtc mute ${c.id} ${a[2] === '1' ? 1 : 0}`); break;
    case 'offer': case 'answer': case 'ice': {
      const to = find(+a[2]);
      const data = a[3] || '';
      if (!to || to === c || !data || data.length > MAX_PAYLOAD || !B64.test(data)) return;
      send(to, `rtc ${type} ${c.id} ${data}`);
      break; }
    default: break;
  }
}

module.exports = { handle, iceServers };
