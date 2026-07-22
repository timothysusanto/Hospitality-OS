"use strict";

/**
 * Tenant/venue lookup — geofence and fixed-cost config live here.
 * Data model (backend-build-scope.md): tenants/{tenantId} = { name, plan, geofence: {lat,lng,radiusMeters}, fixedCosts: [...] }
 */

class InMemoryTenantStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._tenants = new Map();

    // Matches the demo-venue tenantId seeded in store.js.
    // Replace lat/lng with your actual venue's coordinates before real testing
    // (right-click your venue in Google Maps -> the coordinates are the first
    // thing in the context menu — copy them straight in).
    this.upsert("demo-venue", {
      name: "Demo Venue",
      plan: "free",
      geofence: { lat: -33.8568, lng: 151.2153, radiusMeters: 75 }, // Sydney Opera House, as a placeholder
      fixedCosts: [],
    });
  }

  upsert(tenantId, data) {
    this._tenants.set(tenantId, data);
  }

  /** @param {string} tenantId @returns {Promise<object|null>} */
  async findById(tenantId) {
    return this._tenants.get(tenantId) || null;
  }
}

/**
 * Placeholder — wire up alongside FirestoreStaffStore once the Firebase
 * project exists. Same tenantId-scoping discipline applies.
 */
class FirestoreTenantStore {
  constructor(db) {
    this.db = db;
  }

  async findById(tenantId) {
    const doc = await this.db.collection("tenants").doc(tenantId).get();
    return doc.exists ? doc.data() : null;
  }
}

module.exports = { InMemoryTenantStore, FirestoreTenantStore };
