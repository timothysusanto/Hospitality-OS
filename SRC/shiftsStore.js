"use strict";

/**
 * Shift records — clock in/out events.
 * Data model (backend-build-scope.md):
 *   shifts/{shiftId} = { tenantId, staffId, department,
 *                        clockIn: {time, lat, lng, withinRadius, distanceMeters},
 *                        clockOut: {...} | null,
 *                        overridden: boolean }
 */

class InMemoryShiftsStore {
  constructor() {
    /** @type {Map<string, object>} keyed by shiftId */
    this._shifts = new Map();
    this._nextId = 1;
  }

  /**
   * @returns {Promise<{shiftId: string}>}
   */
  async openShift({ tenantId, staffPhone, department, clockIn }) {
    const shiftId = `shift_${this._nextId++}`;
    this._shifts.set(shiftId, {
      shiftId,
      tenantId,
      staffPhone,
      department,
      clockIn,
      clockOut: null,
    });
    return { shiftId };
  }

  /**
   * Finds the most recent open shift (no clockOut) for this phone number.
   * @returns {Promise<object|null>}
   */
  async findOpenShift(staffPhone) {
    let latest = null;
    for (const shift of this._shifts.values()) {
      if (shift.staffPhone === staffPhone && !shift.clockOut) {
        if (!latest || shift.clockIn.time > latest.clockIn.time) latest = shift;
      }
    }
    return latest;
  }

  /**
   * @param {string} shiftId
   * @param {object} clockOut
   */
  async closeShift(shiftId, clockOut) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error(`No shift found with id ${shiftId}`);
    shift.clockOut = clockOut;
    return shift;
  }
}

/**
 * Firestore-backed implementation. Same shape, real persistence.
 * Every write includes tenantId — security rules (not written yet, that's
 * a Firebase Console step) must enforce that a request's auth token tenantId
 * matches the document's tenantId. See decisions log, "Data safety & RBAC".
 */
class FirestoreShiftsStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("shifts");
  }

  async openShift({ tenantId, staffPhone, department, clockIn }) {
    const ref = await this.collection.add({
      tenantId,
      staffPhone,
      department,
      clockIn,
      clockOut: null,
    });
    return { shiftId: ref.id };
  }

  async findOpenShift(staffPhone) {
    const snap = await this.collection
      .where("staffPhone", "==", staffPhone)
      .where("clockOut", "==", null)
      .orderBy("clockIn.time", "desc")
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { shiftId: doc.id, ...doc.data() };
  }

  async closeShift(shiftId, clockOut) {
    await this.collection.doc(shiftId).update({ clockOut });
    const doc = await this.collection.doc(shiftId).get();
    return { shiftId, ...doc.data() };
  }
}

module.exports = { InMemoryShiftsStore, FirestoreShiftsStore };
