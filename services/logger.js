'use strict';
// Console logger that also keeps the last N lines in memory for the admin API. Secrets are masked.
const MAX = 500;
const ring = [];
const SECRET = /(private_key|password|authorization|bearer\s+[A-Za-z0-9._-]+|AIza[0-9A-Za-z_-]{20,})/gi;
let silent = false;

function mask(s) { return String(s).replace(SECRET, '[hidden]'); }
function push(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg: mask(msg) + (extra ? ' ' + mask(typeof extra === 'string' ? extra : JSON.stringify(extra)) : '') };
  ring.push(line); if (ring.length > MAX) ring.shift();
  if (!silent) (level === 'error' ? console.error : console.log)(`[${line.t}] ${level.toUpperCase()} ${line.msg}`);
}
module.exports = {
  info: (m, e) => push('info', m, e), warn: (m, e) => push('warn', m, e), error: (m, e) => push('error', m, e),
  recent: (level, n = 100) => ring.filter(l => !level || l.level === level).slice(-n),
  errorCount: () => ring.filter(l => l.level === 'error').length,
  setSilent: v => { silent = v; },
};
