'use strict';
// Small in-memory fixed-window rate limiter (per IP). Good enough for a single Render instance.
function rateLimit({ windowMs = 60000, max = 60, message = 'too many requests' } = {}) {
  const hits = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs);
  if (timer.unref) timer.unref();
  const mw = (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(ip, h); }
    if (++h.n > max) { res.set('Retry-After', String(Math.ceil((windowMs - (now - h.t)) / 1000))); return res.status(429).json({ error: message }); }
    next();
  };
  mw.stop = () => clearInterval(timer);
  return mw;
}
module.exports = { rateLimit };
