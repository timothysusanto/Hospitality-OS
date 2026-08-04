"use strict";

/**
 * Shift records — clock in/out events, plus mid-shift breaks.
 * Data model (backend-build-scope.md, docs/agencymodelshape.md):
 *   shifts/{shiftId} = { tenantId, staffId, department, siteId, siteName,
 *                        clockIn: {time, lat, lng, withinRadius, distanceMeters},
 *                        clockOut: {...} | null,
 *                        breaks: [{ start, end }],
 *                        overridden: boolean }
 *
 * breaks is always an array (possibly empty). Each entry has `start` (ISO
 * string) and `end` (ISO string, or null while the break is still active).
 * Only one break can be active at a time per shift — startBreak() rejects
 * if the last entry has no `end` yet.
 *
 * `siteId` is the building this shift was worked at, stamped at clock-in from
 * the resolved site (see siteResolver.js) and never inferred afterwards — a
 * clock-out, a manager review, or an invoice three months later all have to
 * agree on which hotel this was. `siteName` is denormalized alongside it so a
 * shift record still reads correctly after a site is renamed or deactivated.
 * Both are null for shifts recorded before sites existed, and for the legacy
 * tenant-geofence fallback where there genuinely is no site document.
 */

/**
 * A rate, or null for "we don't have one".
 *
 * Not `Number.isFinite(Number(x))`: `Number(null)` and `Number("")` are both 0,
 * which would store an absent rate as a real rate of zero — a shift that then
 * looks like free labour in a margin report instead of one nobody has priced.
 */
function rateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

class InMemoryShiftsStore {
  constructor() {
    /** @type {Map<string, object>} keyed by shiftId */
    this._shifts = new Map();
    this._nextId = 1;
  }

  async openShift({ tenantId, staffPhone, department, siteId, siteName, role, payRate, billRate, lane, requestId, clockIn }) {
    const shiftId = `shift_${this._nextId++}`;
    this._shifts.set(shiftId, {
      shiftId,
      tenantId,
      staffPhone,
      department,
      siteId: siteId || null,
      siteName: siteName || null,
      role: role || null,
      // Stamped, never looked up later: rate cards change, and an invoice from
      // three months ago must not silently reprice when somebody edits a site.
      payRate: rateOrNull(payRate),
      billRate: rateOrNull(billRate),
      lane: lane || null,
      requestId: requestId || null,
      approvedBy: null,
      approvedAt: null,
      queriedAt: null,
      queryNote: null,
      signoffAskedAt: null,
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

  /**
   * One-tap sign-off from the supervisor's phone (docs/agencymodelshape.md
   * step 6). `approve` records who and when; a query records the note instead
   * and leaves the shift unapproved so it shows up in the operator's worklist
   * rather than on an invoice.
   *
   * Idempotent: a second Approve on an already-approved shift is a no-op rather
   * than a second audit entry with a later timestamp.
   */
  async signOffShift(shiftId, { approve, by, note }) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error("SHIFT_NOT_FOUND");
    if (shift.approvedAt) return shift;
    if (approve) {
      shift.approvedBy = by || null;
      shift.approvedAt = new Date().toISOString();
      shift.queriedAt = null;
      shift.queryNote = null;
    } else {
      shift.queriedAt = new Date().toISOString();
      shift.queryNote = note || null;
    }
    return shift;
  }

  /** Notes that the sign-off request went out, so it isn't sent every tick. */
  async markSignoffAsked(shiftId) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error("SHIFT_NOT_FOUND");
    shift.signoffAskedAt = new Date().toISOString();
    return shift;
  }

  /**
   * Timesheet amendment — audit-trail style: the original clockIn/clockOut/
   * breaks are never touched; corrections live in `amended` and every
   * consumer (dashboard, reports) uses amended values when present, while
   * always able to show the original for comparison.
   */
  async amendShift(shiftId, { clockInTime, clockOutTime, breakMinutes }) {
    const shift = this._shifts.get(shiftId);
    if (!shift) throw new Error(`No shift found with id ${shiftId}`);
    shift.amended = {
      clockInTime: clockInTime || null,
      clockOutTime: clockOutTime || null,
      breakMinutes: breakMinutes != null ? breakMinutes : null,
      at: new Date().toISOString(),
    };
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

  async openShift({ tenantId, staffPhone, department, siteId, siteName, role, payRate, billRate, lane, requestId, clockIn }) {
    const ref = await this.collection.add({
      tenantId,
      staffPhone,
      department,
      siteId: siteId || null,
      siteName: siteName || null,
      role: role || null,
      // Stamped, never looked up later: rate cards change, and an invoice from
      // three months ago must not silently reprice when somebody edits a site.
      payRate: rateOrNull(payRate),
      billRate: rateOrNull(billRate),
      lane: lane || null,
      requestId: requestId || null,
      approvedBy: null,
      approvedAt: null,
      queriedAt: null,
      queryNote: null,
      signoffAskedAt: null,
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
   * One-tap sign-off — see the in-memory twin. Transactional so two taps from
   * two supervisors can't both write an approval.
   */
  async signOffShift(shiftId, { approve, by, note }) {
    const docRef = this.collection.doc(shiftId);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      if (!doc.exists) throw new Error("SHIFT_NOT_FOUND");
      const shift = { shiftId, ...doc.data() };
      if (shift.approvedAt) return shift;
      const patch = approve
        ? { approvedBy: by || null, approvedAt: new Date().toISOString(), queriedAt: null, queryNote: null }
        : { queriedAt: new Date().toISOString(), queryNote: note || null };
      tx.update(docRef, patch);
      return { ...shift, ...patch };
    });
  }

  async markSignoffAsked(shiftId) {
    await this.collection.doc(shiftId).update({ signoffAskedAt: new Date().toISOString() });
    const doc = await this.collection.doc(shiftId).get();
    return { shiftId, ...doc.data() };
  }

  /** Timesheet amendment — see the in-memory twin for semantics. */
  async amendShift(shiftId, { clockInTime, clockOutTime, breakMinutes }) {
    const docRef = this.collection.doc(shiftId);
    await docRef.update({
      amended: {
        clockInTime: clockInTime || null,
        clockOutTime: clockOutTime || null,
        breakMinutes: breakMinutes != null ? breakMinutes : null,
        at: new Date().toISOString(),
      },
    });
    const doc = await docRef.get();
    return { shiftId, ...doc.data() };
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
