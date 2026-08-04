"use strict";

/**
 * Weekly rosters. One document per venue per week.
 *
 * Data model:
 *   rosters/{tenantId_weekStart} = {
 *     tenantId,
 *     weekStart: "YYYY-MM-DD" (a Monday),
 *     assignments: { "YYYY-MM-DD": { [staffPhone]: { slot, siteId } } },
 *     published: boolean,
 *     publishedAt: ISO string | null,
 *   }
 *
 * Assignments are day-level slots, not timed shifts — deliberate v1
 * simplification matching how kitchens think in services (lunch/dinner).
 * Timed shifts and named service presets are a later step.
 *
 * An assignment carries the **site** it's for, because that is what makes the
 * geofence shift-level rather than tenant-level (docs/agencymodelshape.md,
 * build order step 1): a casual sent to the Hilton on Monday and the Sofitel
 * on Tuesday must be checked against two different buildings.
 *
 * Rosters written before sites existed store a bare slot string
 * (`"AM"` instead of `{slot: "AM", siteId: "hilton-sydney"}`). Every read goes
 * through normalizeAssignment(), so both shapes are legible forever and no
 * migration is required to keep an existing week working.
 */

const PRESET_SLOTS = ["AM", "PM", "ALL", "NIGHT"];
/** Custom shift times painted from the dashboard's time editor, e.g. "09:00-17:00". */
const CUSTOM_SLOT_RE = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

/**
 * Local clock hours each preset covers, from docs/agencymodelshape.md's three
 * blocks. NIGHT runs past midnight; a night belongs to the date it starts on.
 * ALL is the venue's trading day, not 24 hours.
 */
const PRESET_HOURS = {
  AM: [6, 14],
  PM: [14, 22],
  NIGHT: [22, 30], // 22:00 to 06:00 the next day
  ALL: [6, 22],
};

/**
 * The real time window a roster slot covers on a given date, so two shifts can
 * be tested for overlap. Returns Date objects in local time — the roster is
 * keyed in the venue's own days.
 * @param {string} slot @param {string} dateIso YYYY-MM-DD
 * @returns {{startsAt: Date, endsAt: Date}|null}
 */
function slotWindow(slot, dateIso) {
  const canonical = canonicalSlot(slot);
  if (!canonical) return null;
  const base = new Date(`${dateIso}T00:00:00`);
  if (Number.isNaN(base.getTime())) return null;

  let startHours;
  let endHours;
  const custom = canonical.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (custom) {
    startHours = Number(custom[1]) + Number(custom[2]) / 60;
    endHours = Number(custom[3]) + Number(custom[4]) / 60;
    if (endHours <= startHours) endHours += 24; // overnight, e.g. 18:00-02:00
  } else {
    [startHours, endHours] = PRESET_HOURS[canonical];
  }

  const startsAt = new Date(base.getTime() + startHours * 3600 * 1000);
  const endsAt = new Date(base.getTime() + endHours * 3600 * 1000);
  return { startsAt, endsAt };
}

/** Do two [start, end) windows overlap at all? */
function windowsOverlap(a, b) {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/**
 * @typedef {{slot: string, siteId: string|null}} Assignment
 *   `slot` is "AM" | "PM" | "ALL" | "HH:MM-HH:MM".
 */

/** Presets are case-normalized; a custom range is already canonical. */
function canonicalSlot(raw) {
  const text = String(raw || "").trim();
  if (CUSTOM_SLOT_RE.test(text)) return text;
  const upper = text.toUpperCase();
  return PRESET_SLOTS.includes(upper) ? upper : null;
}

/**
 * Reads either shape of stored assignment. Returns null for anything that
 * isn't an assignment at all (empty cell, unknown slot, junk) so callers can
 * treat "no shift" and "unreadable shift" the same way.
 * @param {any} raw @returns {Assignment|null}
 */
function normalizeAssignment(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    const slot = canonicalSlot(raw);
    return slot ? { slot, siteId: null } : null;
  }
  if (typeof raw !== "object") return null;
  const slot = canonicalSlot(raw.slot);
  if (!slot) return null;
  const assignment = { slot, siteId: raw.siteId ? String(raw.siteId) : null };
  // The job being done, when it's known — set when an offer is accepted from a
  // request that named a role. Clock-in reads it to pick the site's bill rate,
  // so a shift can be priced without guessing from the person's department.
  if (raw.role) assignment.role = String(raw.role).trim().toLowerCase();
  return assignment;
}

/**
 * The write-side counterpart: takes whatever the dashboard sent for one cell
 * and returns the canonical stored shape, or null to clear the cell. Keeping
 * this strict matters more than usual — a typo'd siteId here becomes a
 * geofence that can never match, and the staff member gets flagged.
 * @param {any} raw @param {(siteId: string) => boolean} [isKnownSite]
 *   Optional guard; when supplied, an unrecognised siteId is dropped rather
 *   than stored, so a stale picker can't write a dangling reference.
 * @returns {Assignment|null}
 */
function normalizeAssignmentForWrite(raw, isKnownSite) {
  const assignment = normalizeAssignment(raw);
  if (!assignment) return null;
  if (assignment.siteId && isKnownSite && !isKnownSite(assignment.siteId)) {
    return { slot: assignment.slot, siteId: null };
  }
  return assignment;
}

/**
 * Cleans a whole week's assignments map in one pass. Invalid cells are
 * dropped, and a day left with no valid cells is dropped with them.
 * @param {object} assignments @param {(siteId: string) => boolean} [isKnownSite]
 */
function normalizeAssignments(assignments, isKnownSite) {
  const clean = {};
  for (const [date, day] of Object.entries(assignments || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day || typeof day !== "object") continue;
    const cleanDay = {};
    for (const [phone, raw] of Object.entries(day)) {
      const assignment = normalizeAssignmentForWrite(raw, isKnownSite);
      if (assignment) cleanDay[phone] = assignment;
    }
    if (Object.keys(cleanDay).length) clean[date] = cleanDay;
  }
  return clean;
}

function docId(tenantId, weekStart) {
  return `${tenantId}_${weekStart}`;
}

/** Monday of the week containing `date`, as YYYY-MM-DD. */
function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function emptyWeek(tenantId, weekStart) {
  return { tenantId, weekStart, assignments: {}, published: false, publishedAt: null, revenueForecast: null, openingStock: null, closingStock: null };
}

/**
 * Shared by both twins: one person's assignment on one date, normalized.
 *
 * Deliberately does NOT require the week to be published. A draft assignment
 * is still the best available statement of which building someone was sent
 * to, and the geofence is guarding against clocking in from home — not
 * against an unpublished roster.
 */
function assignmentFromWeek(week, dateIso, phone) {
  const day = (week && week.assignments && week.assignments[dateIso]) || null;
  return day ? normalizeAssignment(day[phone]) : null;
}

class InMemoryRosterStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._rosters = new Map();
  }

  async getWeek(tenantId, weekStart) {
    return this._rosters.get(docId(tenantId, weekStart)) || emptyWeek(tenantId, weekStart);
  }

  async saveWeek(tenantId, weekStart, assignments, extras = {}) {
    const id = docId(tenantId, weekStart);
    const existing = this._rosters.get(id) || emptyWeek(tenantId, weekStart);
    existing.assignments = assignments;
    for (const key of ["revenueForecast", "openingStock", "closingStock"]) {
      if (extras[key] !== undefined) existing[key] = extras[key];
    }
    this._rosters.set(id, existing);
    return existing;
  }

  async markPublished(tenantId, weekStart) {
    const id = docId(tenantId, weekStart);
    const existing = this._rosters.get(id) || emptyWeek(tenantId, weekStart);
    existing.published = true;
    existing.publishedAt = new Date().toISOString();
    this._rosters.set(id, existing);
    return existing;
  }

  /**
   * The published week docs covering "now" — used by the WhatsApp "roster"
   * command so staff can see their upcoming shifts. Returns current week +
   * next week if published.
   */
  async getPublishedWeeks(tenantId, weekStarts) {
    return weekStarts
      .map((ws) => this._rosters.get(docId(tenantId, ws)))
      .filter((r) => r && r.published);
  }

  /**
   * One person's assignment on one date — the lookup the geofence resolver
   * needs at clock-in time. Returns null when they aren't rostered.
   * @returns {Promise<Assignment|null>}
   */
  async findAssignment(tenantId, dateIso, phone) {
    const week = await this.getWeek(tenantId, mondayOf(dateIso + "T12:00:00"));
    return assignmentFromWeek(week, dateIso, phone);
  }

  /**
   * Books one person into one cell. This is how accepting a staffing offer
   * becomes a real shift: the roster is what the clock-in geofence resolves
   * against (siteResolver.js), so writing the assignment here is what makes
   * step 1 and step 2 fit together without a second placement collection.
   *
   * Passing null clears the cell.
   */
  async setAssignment(tenantId, dateIso, phone, assignment) {
    const weekStart = mondayOf(dateIso + "T12:00:00");
    const id = docId(tenantId, weekStart);
    const existing = this._rosters.get(id) || emptyWeek(tenantId, weekStart);
    const day = (existing.assignments[dateIso] = existing.assignments[dateIso] || {});
    const clean = assignment ? normalizeAssignment(assignment) : null;
    if (clean) day[phone] = clean;
    else delete day[phone];
    if (!Object.keys(day).length) delete existing.assignments[dateIso];
    this._rosters.set(id, existing);
    return existing;
  }
}

class FirestoreRosterStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("rosters");
  }

  async getWeek(tenantId, weekStart) {
    const doc = await this.collection.doc(docId(tenantId, weekStart)).get();
    return doc.exists ? doc.data() : emptyWeek(tenantId, weekStart);
  }

  async saveWeek(tenantId, weekStart, assignments, extras = {}) {
    const ref = this.collection.doc(docId(tenantId, weekStart));
    const doc = await ref.get();
    const existing = doc.exists ? doc.data() : emptyWeek(tenantId, weekStart);
    existing.assignments = assignments;
    for (const key of ["revenueForecast", "openingStock", "closingStock"]) {
      if (extras[key] !== undefined) existing[key] = extras[key];
    }
    await ref.set(existing);
    return existing;
  }

  async markPublished(tenantId, weekStart) {
    const ref = this.collection.doc(docId(tenantId, weekStart));
    const doc = await ref.get();
    const existing = doc.exists ? doc.data() : emptyWeek(tenantId, weekStart);
    existing.published = true;
    existing.publishedAt = new Date().toISOString();
    await ref.set(existing);
    return existing;
  }

  async getPublishedWeeks(tenantId, weekStarts) {
    const docs = await Promise.all(
      weekStarts.map((ws) => this.collection.doc(docId(tenantId, ws)).get())
    );
    return docs.filter((d) => d.exists && d.data().published).map((d) => d.data());
  }

  /** One person's assignment on one date — see the in-memory twin. */
  async findAssignment(tenantId, dateIso, phone) {
    const week = await this.getWeek(tenantId, mondayOf(dateIso + "T12:00:00"));
    return assignmentFromWeek(week, dateIso, phone);
  }

  /**
   * Books one person into one cell — see the in-memory twin for why this is
   * the join between steps 1 and 2.
   *
   * Transactional whole-document read-modify-write. Two people accepting
   * different shifts in the same week land in the same document, and a plain
   * update would drop one of them. Dotted field paths aren't an option here:
   * the keys are dates and phone numbers, not identifiers.
   */
  async setAssignment(tenantId, dateIso, phone, assignment) {
    const weekStart = mondayOf(dateIso + "T12:00:00");
    const ref = this.collection.doc(docId(tenantId, weekStart));
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const week = doc.exists ? doc.data() : emptyWeek(tenantId, weekStart);
      week.assignments = week.assignments || {};
      const day = (week.assignments[dateIso] = week.assignments[dateIso] || {});
      const clean = assignment ? normalizeAssignment(assignment) : null;
      if (clean) day[phone] = clean;
      else delete day[phone];
      if (!Object.keys(day).length) delete week.assignments[dateIso];
      tx.set(ref, week);
      return week;
    });
  }
}

module.exports = {
  InMemoryRosterStore,
  FirestoreRosterStore,
  normalizeAssignment,
  normalizeAssignmentForWrite,
  normalizeAssignments,
  canonicalSlot,
  slotWindow,
  windowsOverlap,
  mondayOf,
  PRESET_SLOTS,
  PRESET_HOURS,
  CUSTOM_SLOT_RE,
};
