"use strict";

const { getFirestoreDb } = require("./firebase");
const { InMemoryStaffStore, FirestoreStaffStore } = require("./store");
const { InMemoryTenantStore, FirestoreTenantStore } = require("./tenantStore");
const { InMemoryShiftsStore, FirestoreShiftsStore } = require("./shiftsStore");

/**
 * One place that decides: real Firestore, or in-memory for early testing.
 * Everything else in the app just calls staffStore.findByPhone(), etc.,
 * and doesn't care which implementation is behind it.
 */
function buildStores() {
  const db = getFirestoreDb();

  if (db) {
    return {
      staffStore: new FirestoreStaffStore(db),
      tenantStore: new FirestoreTenantStore(db),
      shiftsStore: new FirestoreShiftsStore(db),
      backend: "firestore",
    };
  }

  return {
    staffStore: new InMemoryStaffStore(),
    tenantStore: new InMemoryTenantStore(),
    shiftsStore: new InMemoryShiftsStore(),
    backend: "in-memory",
  };
}

module.exports = { buildStores };
