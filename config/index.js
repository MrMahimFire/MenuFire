'use strict';
// Reads and validates environment variables. validate() returns a list of problems (empty = fine).
const path = require('path');
const fs = require('fs');

function load(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const cfg = {
    prod,
    port: +env.PORT || 8080,
    authMode: (env.AUTH_MODE || (prod ? 'firebase' : 'dev')).toLowerCase(),
    firebase: {
      serviceAccountB64: env.FIREBASE_SERVICE_ACCOUNT_B64 || '',
      projectId: env.FIREBASE_PROJECT_ID || '',
      clientEmail: env.FIREBASE_CLIENT_EMAIL || '',
      privateKey: (env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      databaseURL: env.FIREBASE_DATABASE_URL || '',
      webApiKey: env.FIREBASE_WEB_API_KEY || '',
    },
    adminUids: (env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean),
    ice: {
      stun: (env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean),
      turnUrl: env.TURN_URL || '', turnUser: env.TURN_USERNAME || '', turnCred: env.TURN_CREDENTIAL || '',
    },
    antiCheat: env.ANTICHEAT !== '0',             // speed-hack check; switched off only for scripted client tests
    fast: env.FAST === '1',                       // short timers, for tests only
    minBR: +env.MIN_BR || 2,
    minCS: +env.MIN_CS || 2,
    maxConnPerIp: +env.MAX_CONN_PER_IP || 12,
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
    weapons: JSON.parse(fs.readFileSync(path.join(__dirname, 'weapons.json'), 'utf8')),
  };
  return cfg;
}

function hasCredentials(f) {
  return !!(f.serviceAccountB64 || (f.projectId && f.clientEmail && f.privateKey));
}

function validate(cfg) {
  const errs = [];
  if (!['firebase', 'dev'].includes(cfg.authMode)) errs.push('AUTH_MODE must be "firebase" or "dev"');
  if (cfg.prod && cfg.authMode === 'dev') errs.push('AUTH_MODE=dev is not allowed when NODE_ENV=production');
  if (cfg.authMode === 'firebase') {
    if (!hasCredentials(cfg.firebase)) errs.push('Firebase credentials missing: set FIREBASE_SERVICE_ACCOUNT_B64 (or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)');
    if (!/^https:\/\/.+/.test(cfg.firebase.databaseURL)) errs.push('FIREBASE_DATABASE_URL must be the https:// URL of the Realtime Database');
    if (cfg.firebase.serviceAccountB64) {
      try { const j = JSON.parse(Buffer.from(cfg.firebase.serviceAccountB64, 'base64').toString('utf8')); if (!j.private_key || !j.client_email) errs.push('FIREBASE_SERVICE_ACCOUNT_B64 is not a service-account JSON'); }
      catch (e) { errs.push('FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64 JSON'); }
    }
  }
  if (!(cfg.port > 0 && cfg.port < 65536)) errs.push('PORT is not valid');
  return errs;
}

module.exports = { load, validate, hasCredentials };
