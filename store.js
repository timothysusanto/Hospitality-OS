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

  /** @param {string} tenantId @returns {Promise<StaffRecord[]>} */
  async listByTenant(tenantId) {
    return [...this._staff.values()].filter((s) => s.tenantId === tenantId);
  }

  /**
   * Sets recurring weekly availability, e.g. ["mon","tue","fri"].
   * Empty array = explicitly available on no recurring days.
   */
  async setAvailabilityDays(phone, days) {
    const staff = this._staff.get(phone);
    if (!staff) throw new Error("STAFF_NOT_FOUND");
    staff.availability = staff.availability || { days: [], exceptions: [] };
    staff.availability.days = days;
    return staff;
  }

  /**
   * Adds or removes a one-off date exception ("off 3/8" / "on 3/8").
   * @param {string} phone @param {string} dateIso YYYY-MM-DD
   * @param {boolean} available false = mark unavailable, true = clear it
   */
  async setDateException(phone, dateIso, available) {
    const staff = this._staff.get(phone);
    if (!staff) throw new Error("STAFF_NOT_FOUND");
    staff.availability = staff.availability || { days: [], exceptions: [] };
    staff.availability.exceptions = (staff.availability.exceptions || []).filter(
      (e) => e.date !== dateIso
    );
    if (!available) {
      staff.availability.exceptions.push({ date: dateIso, available: false });
    }
    return staff;
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

  /**
   * Single-field equality filter only (no orderBy paired with it), so this
   * does not require a composite index — unlike the shifts queries.
   * @param {string} tenantId @returns {Promise<StaffRecord[]>}
   */
  async listByTenant(tenantId) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs.map((doc) => ({ phone: doc.id, ...doc.data() }));
  }

  async setAvailabilityDays(phone, days) {
    const ref = this.collection.doc(phone);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("STAFF_NOT_FOUND");
    const availability = doc.data().availability || { days: [], exceptions: [] };
    availability.days = days;
    await ref.update({ availability });
    return { phone, ...doc.data(), availability };
  }

  async setDateException(phone, dateIso, available) {
    const ref = this.collection.doc(phone);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("STAFF_NOT_FOUND");
    const availability = doc.data().availability || { days: [], exceptions: [] };
    availability.exceptions = (availability.exceptions || []).filter((e) => e.date !== dateIso);
    if (!available) {
      availability.exceptions.push({ date: dateIso, available: false });
    }
    await ref.update({ availability });
    return { phone, ...doc.data(), availability };
  }
}

module.exports = { InMemoryStaffStore, FirestoreStaffStore };
