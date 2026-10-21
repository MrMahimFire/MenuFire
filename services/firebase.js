'use strict';
// Firebase Admin SDK setup. The private key only ever lives in environment variables on the server.
const { hasCredentials } = require('../config');

function credentialFrom(f) {
  if (f.serviceAccountB64) return JSON.parse(Buffer.from(f.serviceAccountB64, 'base64').toString('utf8'));
  return { project_id: f.projectId, client_email: f.clientEmail, private_key: f.privateKey };
}

/** Returns { auth, db, verify(idToken) -> {uid, claims} } or throws with a readable message. */
function initFirebase(cfg) {
  if (!hasCredentials(cfg.firebase)) throw new Error('Firebase credentials are not set');
  const admin = require('firebase-admin');                 // loaded lazily so dev/test runs work without it
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(credentialFrom(cfg.firebase)), databaseURL: cfg.firebase.databaseURL });
  }
  const auth = admin.auth();
  return {
    auth, db: admin.database(),
    async verify(idToken) {
      const d = await auth.verifyIdToken(String(idToken || ''), true);   // true = also check the account is not revoked
      return { uid: d.uid, claims: d, name: d.name || '' };
    },
  };
}

module.exports = { initFirebase };
