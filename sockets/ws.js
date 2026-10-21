'use strict';
// Minimal RFC 6455 WebSocket server side (text frames only), attached to an http.Server 'upgrade' event.
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const accept = key => crypto.createHash('sha1').update(key + GUID).digest('base64');

function frame(str, op = 1) {
  const b = Buffer.from(str);
  let h;
  if (b.length < 126) h = Buffer.from([0x80 | op, b.length]);
  else if (b.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(b.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); }
  return Buffer.concat([h, b]);
}

function parseFrames(c, chunk, onText, onPong) {
  c.buf = Buffer.concat([c.buf, chunk]);
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, masked = (b1 & 128) !== 0;
    let len = b1 & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 65536) { c.sock.destroy(); return; }
    const need = off + (masked ? 4 : 0) + len;
    if (c.buf.length < need) return;
    const mask = masked ? c.buf.subarray(off, off + 4) : null;
    const data = Buffer.from(c.buf.subarray(off + (masked ? 4 : 0), need));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(need);
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { if (data.length < 126) c.sock.write(Buffer.concat([Buffer.from([0x8A, data.length]), data])); continue; }
    if (op === 10) { onPong(); continue; }
    if (op === 1) onText(data.toString('utf8'));
  }
}

/** Handshake. Returns true if the connection was upgraded. */
function handshake(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return false; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n');
  sock.setNoDelay(true);
  return true;
}

module.exports = { frame, parseFrames, handshake };
