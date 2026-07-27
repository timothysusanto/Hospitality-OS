"use strict";

/**
 * Shift records — clock in/out events, plus mid-shift breaks.
 * Data model (backend-build-scope.md):
 *   shifts/{shiftId} = { tenantId, staffId, department,
 *                        clockIn: {time, lat, lng, withinRadius, distanceMeters},
 *                        clockOut: {...} | null,
 *                        breaks: [{ start, end }],
 *                        overridden: boolean }
 *
 * breaks is always an array (possibly empty). Each entry has `start` (ISO
 * string) and `end` (ISO string, or null while the break is still active).
 * Only one break can be active at a time per shift — startBreak() rejects
 * if the last entry has no `end` yet.
 */

class InMemoryShiftsStore {
  constructor() {
    /** @type {Map<string, object>} keyed by shiftId */
    this._shifts = new Map();
    this._nextId = 1;
  }

  async openShift({ tenantId, staffPhone, department, clockIn }) {
    const shiftId = `shift_${this._nextId++}`;
    this._shifts.set(shiftId, {
      shiftId,
      tenantId,
      staffPhone,
      department,
      clockIn,
      clockOut: null,
      breaks: [],
    });
    return { shiftId };
  }

  async findOpenShift(staffPhone) {
    let latest = null;
    for (const shift of this._shifts.values()) {
      if (shift.staffPhone === staffPhone && !shift.clockOut) {
        if (!latest || shift.clockIn.time > latest.clockIn.time) latest = shift;
      }
    }
    return latest;
  }

  async closeShift(shiftId, clockOut) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error(`No shift found with id ${shiftId}`);
    shift.clockOut = clockOut;
    return shift;
  }

  async startBreak(shiftId, startIso) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error(`No shift found with id ${shiftId}`);
    const breaks = shift.breaks || [];
    const active = breaks[breaks.length - 1];
    if (active && !active.end) throw new Error("BREAK_ALREADY_ACTIVE");
    breaks.push({ start: startIso, end: null });
    shift.breaks = breaks;
    return shift;
  }

  async endBreak(shiftId, endIso) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error(`No shift found with id ${shiftId}`);
    const breaks = shift.breaks || [];
    const active = breaks[breaks.length - 1];
    if (!active || active.end) throw new Error("NO_ACTIVE_BREAK");
    active.end = endIso;
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
      breaks: [],
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

  async startBreak(shiftId, startIso) {
    const docRef = this.collection.doc(shiftId);
    const doc = await docRef.get();
    if (!doc.exists) throw new Error(`No shift found with id ${shiftId}`);
    const breaks = doc.data().breaks || [];
    const active = breaks[breaks.length - 1];
    if (active && !active.end) throw new Error("BREAK_ALREADY_ACTIVE");
    breaks.push({ start: startIso, end: null });
    await docRef.update({ breaks });
    return { shiftId, ...doc.data(), breaks };
  }

  async endBreak(shiftId, endIso) {
    const docRef = this.collection.doc(shiftId);
    const doc = await docRef.get();
    if (!doc.exists) throw new Error(`No shift found with id ${shiftId}`);
    const breaks = doc.data().breaks || [];
    const active = breaks[breaks.length - 1];
    if (!active || active.end) throw new Error("NO_ACTIVE_BREAK");
    active.end = endIso;
    await docRef.update({ breaks });
    return { shiftId, ...doc.data(), breaks };
  }
}

module.exports = { InMemoryShiftsStore, FirestoreShiftsStore };
