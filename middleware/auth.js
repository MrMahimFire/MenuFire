'use strict';
// Admin authentication: Firebase ID token in "Authorization: Bearer <token>", then a ROLE check on the server.
// The role is never taken from anything the client sends (no "isAdmin=true" flags).
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }

function createAdminAuth({ verify, store, cfg, log }) {
  async function isAdmin(uid, claims) {
    if (cfg.adminUids.includes(uid)) return true;
    if (claims && claims.admin === true) return true;
    try { return await store.isAdminInDb(uid); } catch (e) { return false; }
  }
  return async function requireAdmin(req, res, next) {
    const tok = bearer(req);
    if (!tok) return res.status(401).json({ error: 'login required' });
    let r;
    try { r = await verify(tok, ''); } catch (e) { return res.status(401).json({ error: 'invalid or expired token' }); }
    if (!(await isAdmin(r.uid, r.claims))) { log.warn('admin access denied for ' + r.uid); return res.status(403).json({ error: 'admin role required' }); }
    req.admin = { uid: r.uid };
    next();
  };
}
module.exports = { createAdminAuth, bearer };
