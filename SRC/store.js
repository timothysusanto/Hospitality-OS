"use strict";

/**
 * Staff lookup, behind an interface. Firestore-backed when
 * FIREBASE_SERVICE_ACCOUNT_JSON is configured, in-memory fallback otherwise
 * (see src/firebase.js and src/stores.js for the factory that picks which).
 *
 * Data model (backend-build-scope.md):
 *   staff/{phoneNumber}: { tenantId, name, role, department, wageRate }
 */

/** @typedef {{ phone: string, tenantId: string, name: string, role: "owner"|"manager"|"staff", department?: string }} StaffRecord */

class InMemoryStaffStore {
  constructor() {
    /** @type {Map<string, StaffRecord>} */
    this._staff = new Map();

    // Seed data for local/dev testing — replace the phone number with your
    // own (international format, no "+") to test the recognised-sender path.
    this.upsert({
      phone: "61400000000",
      tenantId: "demo-venue",
      name: "Mothy",
      role: "owner",
      department: "kitchen",
    });
  }

  /** @param {StaffRecord} record */
  upsert(record) {
    this._staff.set(record.phone, record);
  }

  /** @param {string} phone @returns {Promise<StaffRecord|null>} */
  async findByPhone(phone) {
    return this._staff.get(phone) || null;
  }
}

/**
 * Firestore-backed implementation. Document ID = phone number.
 *
 * IMPORTANT — role-based access control (see decisions log): this store only
 * returns identity/role data, never financial fields. Financial data lives
 * in separate collections (dailyPnl, etc.) and every reply-building function
 * must check staff.role before including anything from those collections in
 * a WhatsApp message. That check does not live here — it must happen at the
 * point a reply is composed, for every handler, every time.
 */
class FirestoreStaffStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("staff");
  }

  async upsert(record) {
    const { phone, ...data } = record;
    await this.collection.doc(phone).set(data, { merge: true });
  }

  async findByPhone(phone) {
    const doc = await this.collection.doc(phone).get();
    return doc.exists ? { phone, ...doc.data() } : null;
  }
}

module.exports = { InMemoryStaffStore, FirestoreStaffStore };
