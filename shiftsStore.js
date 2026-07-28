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

  /**
   * All shifts for a tenant, unsorted — the dashboard/API layer sorts and
   * buckets these (on-shift / flagged / history) in plain JS.
   * @param {string} tenantId @returns {Promise<object[]>}
   */
  async listByTenant(tenantId) {
    return [...this._shifts.values()].filter((s) => s.tenantId === tenantId);
  }

  /** Every open (not clocked out) shift for a tenant, however old. */
  async listOpenByTenant(tenantId) {
    return [...this._shifts.values()].filter((s) => s.tenantId === tenantId && !s.clockOut);
  }

  /** Shifts whose clock-in is on/after sinceIso. */
  async listRecentByTenant(tenantId, sinceIso) {
    return [...this._shifts.values()].filter(
      (s) => s.tenantId === tenantId && s.clockIn && s.clockIn.time >= sinceIso
    );
  }

  /**
   * Manager approves or denies a flagged out-of-radius clock-in.
   * Approve: clears the flag, marks it within radius, leaves the shift open.
   * Deny: closes the shift immediately with a `denied: true` clockOut, so it
   * drops out of "on shift now" and "needs review" but stays in history.
   * @param {string} shiftId @param {boolean} approve
   */
  async reviewFlaggedShift(shiftId, approve) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error(`No shift found with id ${shiftId}`);
    if (approve) {
      shift.clockIn.flaggedForReview = false;
      shift.clockIn.withinRadius = true;
    } else {
      shift.clockOut = { time: new Date().toISOString(), denied: true };
    }
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

  /**
   * Single-field equality filter only (no orderBy paired with it), so this
   * does not require a composite index. The API layer sorts/buckets the
   * results in plain JS instead of asking Firestore to do it.
   * @param {string} tenantId @returns {Promise<object[]>}
   */
  async listByTenant(tenantId) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs.map((doc) => ({ shiftId: doc.id, ...doc.data() }));
  }

  /**
   * Every open shift for a tenant. Two equality filters — Firestore serves
   * these by merging single-field indexes, so no composite index needed.
   */
  async listOpenByTenant(tenantId) {
    const snap = await this.collection
      .where("tenantId", "==", tenantId)
      .where("clockOut", "==", null)
      .get();
    return snap.docs.map((doc) => ({ shiftId: doc.id, ...doc.data() }));
  }

  /**
   * Shifts clocked in on/after sinceIso. Equality + range DOES need a
   * composite index (tenantId asc, clockIn.time asc) — at large-tenant
   * scale, create it via the link Firestore logs. Until then we fall back
   * to the full fetch + JS filter, so small deployments need zero setup.
   */
  async listRecentByTenant(tenantId, sinceIso) {
    try {
      const snap = await this.collection
        .where("tenantId", "==", tenantId)
        .where("clockIn.time", ">=", sinceIso)
        .get();
      return snap.docs.map((doc) => ({ shiftId: doc.id, ...doc.data() }));
    } catch (err) {
      console.warn(
        "[shifts] recent-range query needs a composite index (tenantId + clockIn.time) for large tenants — " +
        "falling back to full fetch. Create the index via the link in this error:", err.message
      );
      const all = await this.listByTenant(tenantId);
      return all.filter((s) => s.clockIn && s.clockIn.time >= sinceIso);
    }
  }

  /**
   * Manager approves or denies a flagged out-of-radius clock-in.
   * @param {string} shiftId @param {boolean} approve
   */
  async reviewFlaggedShift(shiftId, approve) {
    const docRef = this.collection.doc(shiftId);
    if (approve) {
      await docRef.update({
        "clockIn.flaggedForReview": false,
        "clockIn.withinRadius": true,
      });
    } else {
      await docRef.update({
        clockOut: { time: new Date().toISOString(), denied: true },
      });
    }
    const doc = await docRef.get();
    return { shiftId, ...doc.data() };
  }
}

module.exports = { InMemoryShiftsStore, FirestoreShiftsStore };
