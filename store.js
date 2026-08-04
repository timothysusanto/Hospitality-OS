"use strict";

const { normalizeReliability, withOfferSent, withOfferAnswered, withShiftResult } = require("./reliability");

/**
 * Staff lookup, behind an interface. Firestore-backed when
 * FIREBASE_SERVICE_ACCOUNT_JSON is configured, in-memory fallback otherwise
 * (see src/firebase.js and src/stores.js for the factory that picks which).
 *
 * Data model (backend-build-scope.md, docs/agencymodelshape.md):
 *   staff/{phoneNumber}: { tenantId, name, role, department, wageRate,
 *                          roles[], reliability{} }
 *
 * Two different meanings of "role" live on this record and must not be
 * conflated:
 *   - `role`  — access level: "owner" | "manager" | "staff". Gates what a
 *               reply may contain. Never a job title.
 *   - `roles` — the jobs this person can be sent to do ("housekeeping",
 *               "porter"). What a staffing request matches against.
 *
 * `reliability` is maintained through the record* methods below rather than
 * written directly, so the counters can only move in ways reliability.js
 * defines. See that module for why the response median is a rolling window.
 */

/** @typedef {{ phone: string, tenantId: string, name: string, role: "owner"|"manager"|"staff", department?: string, roles?: string[], reliability?: object }} StaffRecord */

/**
 * The jobs a person can be sent to do. Falls back to their section when no
 * explicit roles are set, and to "matches anything" when there is neither —
 * over-filtering a 300-person pool down to nobody is worse than offering a
 * shift to someone who declines it.
 * @param {StaffRecord} staff @returns {string[]|null} null means "any role"
 */
function rolesOf(staff) {
  if (Array.isArray(staff.roles) && staff.roles.length) {
    return staff.roles.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  }
  const dept = (staff.department || "").trim().toLowerCase();
  return dept ? [dept] : null;
}

/** Whether this person can work a request for `role`. */
function canWorkRole(staff, role) {
  if (!role) return true;
  const roles = rolesOf(staff);
  if (!roles) return true;
  return roles.includes(String(role).trim().toLowerCase());
}

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

  /* ---- Reliability. See reliability.js for what each counter means. ---- */

  async recordOfferSent(phone) {
    return this._patchReliability(phone, withOfferSent);
  }

  async recordOfferAnswered(phone, answer) {
    return this._patchReliability(phone, (r) => withOfferAnswered(r, answer));
  }

  async recordShiftResult(phone, result) {
    return this._patchReliability(phone, (r) => withShiftResult(r, result));
  }

  /**
   * Reliability writes are best-effort: a missing staff record must not fail
   * a dispatch that is otherwise fine. Blast wave 3 can touch the whole pool,
   * and one stale phone number shouldn't take the request down with it.
   */
  async _patchReliability(phone, fn) {
    const staff = this._staff.get(phone);
    if (!staff) return null;
    staff.reliability = fn(staff.reliability);
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

  /* ---- Reliability. See reliability.js for what each counter means. ---- */

  async recordOfferSent(phone) {
    return this._patchReliability(phone, withOfferSent);
  }

  async recordOfferAnswered(phone, answer) {
    return this._patchReliability(phone, (r) => withOfferAnswered(r, answer));
  }

  async recordShiftResult(phone, result) {
    return this._patchReliability(phone, (r) => withShiftResult(r, result));
  }

  /**
   * Transactional read-modify-write: two offer responses for the same person
   * can land in the same second, and a plain read-then-update would lose one
   * of the counter increments.
   *
   * Best-effort by design — see the in-memory twin.
   */
  async _patchReliability(phone, fn) {
    const docRef = this.collection.doc(phone);
    try {
      return await this.db.runTransaction(async (tx) => {
        const doc = await tx.get(docRef);
        if (!doc.exists) return null;
        const reliability = fn(normalizeReliability(doc.data().reliability));
        tx.update(docRef, { reliability });
        return { phone, ...doc.data(), reliability };
      });
    } catch (err) {
      console.error(`[reliability] failed to update ${phone}:`, err.message);
      return null;
    }
  }
}

module.exports = { InMemoryStaffStore, FirestoreStaffStore, rolesOf, canWorkRole };
