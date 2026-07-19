"use strict";

/**
 * Initializes firebase-admin exactly once, from a service account JSON
 * pasted whole into an environment variable (browser-friendly — no key
 * files to manage on a machine you can't install things on).
 *
 * Returns null if not configured, so the rest of the app can fall back to
 * in-memory stores during early development. Once FIREBASE_SERVICE_ACCOUNT_JSON
 * is set (in Railway's Variables tab), Firestore takes over automatically —
 * see store.js / shiftsStore.js / tenantStore.js factory functions.
 */

let _db = null;
let _attempted = false;

function getFirestoreDb() {
  if (_attempted) return _db;
  _attempted = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn(
      "[firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — using in-memory stores (fine for early testing, not for real data)."
    );
    return null;
  }

  try {
    const admin = require("firebase-admin");
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    _db = admin.firestore();
    console.log("[firebase] connected to Firestore project:", serviceAccount.project_id);
    return _db;
  } catch (err) {
    console.error("[firebase] failed to initialize — check FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON:", err.message);
    return null;
  }
}

module.exports = { getFirestoreDb };
