"use strict";

/**
 * Tenant/venue lookup — geofence and fixed-cost config live here.
 * Data model (backend-build-scope.md):
 *   tenants/{tenantId} = { name, plan, geofence: {lat,lng,radiusMeters},
 *                          fixedCosts: [...], phoneNumberId?, whatsappToken? }
 *
 * phoneNumberId/whatsappToken are only present once a venue has its own
 * dedicated WhatsApp number (multi-tenant setups) — a single-venue
 * deployment can leave these unset and everything falls back to the
 * WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN env vars, unchanged.
 */

class InMemoryTenantStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._tenants = new Map();

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

  /**
   * Finds the venue that owns a given WhatsApp phone_number_id — this is
   * how an incoming message is matched to a venue in a multi-tenant setup,
   * before any staff lookup happens.
   * @param {string} phoneNumberId @returns {Promise<object|null>}
   */
  async findByPhoneNumberId(phoneNumberId) {
    for (const [tenantId, data] of this._tenants.entries()) {
      if (data.phoneNumberId === phoneNumberId) return { tenantId, ...data };
    }
    return null;
  }

  /** Merge partial settings (e.g. penaltyRules) into the tenant document. */
  async updateSettings(tenantId, partial) {
    const existing = this._tenants.get(tenantId);
    if (!existing) throw new Error("TENANT_NOT_FOUND");
    Object.assign(existing, partial);
    return existing;
  }
}

/**
 * Firestore-backed implementation. Same tenantId-scoping discipline applies
 * as the other stores.
 */
class FirestoreTenantStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("tenants");
  }

  async findById(tenantId) {
    const doc = await this.collection.doc(tenantId).get();
    return doc.exists ? doc.data() : null;
  }

  /**
   * Single-field equality filter — no composite index required.
   * @param {string} phoneNumberId @returns {Promise<object|null>}
   */
  async findByPhoneNumberId(phoneNumberId) {
    const snap = await this.collection.where("phoneNumberId", "==", phoneNumberId).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { tenantId: doc.id, ...doc.data() };
  }

  /** Merge partial settings (e.g. penaltyRules) into the tenant document. */
  async updateSettings(tenantId, partial) {
    await this.collection.doc(tenantId).set(partial, { merge: true });
    const doc = await this.collection.doc(tenantId).get();
    return doc.exists ? doc.data() : null;
  }
}

module.exports = { InMemoryTenantStore, FirestoreTenantStore };
