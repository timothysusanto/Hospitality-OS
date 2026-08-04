"use strict";

const { getFirestoreDb } = require("./firebase");
const { InMemoryStaffStore, FirestoreStaffStore } = require("./store");
const { InMemoryTenantStore, FirestoreTenantStore } = require("./tenantStore");
const { InMemoryShiftsStore, FirestoreShiftsStore } = require("./shiftsStore");
const { InMemoryRosterStore, FirestoreRosterStore } = require("./rosterStore");
const { InMemoryPurchasesStore, FirestorePurchasesStore } = require("./purchasesStore");
const { InMemorySiteStore, FirestoreSiteStore } = require("./siteStore");

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
      siteStore: new FirestoreSiteStore(db),
      shiftsStore: new FirestoreShiftsStore(db),
      rosterStore: new FirestoreRosterStore(db),
      purchasesStore: new FirestorePurchasesStore(db),
      backend: "firestore",
    };
  }

  return {
    staffStore: new InMemoryStaffStore(),
    tenantStore: new InMemoryTenantStore(),
    siteStore: new InMemorySiteStore(),
    shiftsStore: new InMemoryShiftsStore(),
    rosterStore: new InMemoryRosterStore(),
    purchasesStore: new InMemoryPurchasesStore(),
    backend: "in-memory",
  };
}

module.exports = { buildStores };
