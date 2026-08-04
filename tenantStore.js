"use strict";

/**
 * Tenant lookup — WhatsApp credentials and cost config live here.
 * Data model (backend-build-scope.md):
 *   tenants/{tenantId} = { name, plan, fixedCosts: [...], penaltyRules?,
 *                          phoneNumberId?, whatsappToken?,
 *                          geofence?: {lat,lng,radiusMeters}  // LEGACY }
 *
 * phoneNumberId/whatsappToken are only present once a venue has its own
 * dedicated WhatsApp number (multi-tenant setups) — a single-venue
 * deployment can leave these unset and everything falls back to the
 * WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN env vars, unchanged.
 *
 * `geofence` is LEGACY and must not be read by new code. Locations belong to
 * sites now (siteStore.js), because a tenant is an agency that sends staff to
 * many buildings, not one building — docs/agencymodelshape.md, build order
 * step 1. siteResolver.js still falls back to this field when a tenant has no
 * sites at all, purely so deployments that predate `sites` keep clocking
 * people in; create a site and the fallback stops being consulted.
 */

class InMemoryTenantStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._tenants = new Map();

    // No `geofence` here on purpose — the demo venue's location lives on the
    // "demo-venue-main" site instead (siteStore.js).
    this.upsert("demo-venue", {
      name: "Demo Venue",
      plan: "free",
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
