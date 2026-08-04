"use strict";

const {
  BLOCKS, normalizeBlocks, blockFor, weekStartOf, weekDates,
} = require("./availabilityBlocks");

/**
 * Weekly availability — build order step 3 of docs/agencymodelshape.md.
 *
 * Data model:
 *   availability/{tenantId_phone_weekStart} = {
 *     tenantId, phone, weekStart,
 *     days: { "YYYY-MM-DD": ["AM","PM","NIGHT"] },
 *     source, submittedAt, askedAt, chasedAt
 *   }
 *
 * **A document per person per week, not a field on the staff record.** A casual
 * with a second job has a different answer every week, and last month's answer
 * must never be reused as this week's.
 *
 * ## Three states, not two
 *
 * available, unavailable, and unknown:
 *
 *   - `submittedAt` set and the block listed   → **available**
 *   - `submittedAt` set and the block absent   → **unavailable** (they answered)
 *   - no document, or `submittedAt` null       → **unknown**
 *
 * That third state is why `askedAt` and `chasedAt` live on the same document as
 * the answer instead of creating one. Sending the weekly ping must not turn
 * somebody's silence into a declared "unavailable" — **silence is never a yes,
 * and it is never a no either.** Unknown isn't a failure; it just means that
 * person waits for a later wave.
 */

const STATES = { AVAILABLE: "available", UNAVAILABLE: "unavailable", UNKNOWN: "unknown" };

/** Where an answer came from, for the reporting on which capture rung works. */
const SOURCES = ["same-again", "standing-pattern", "grid", "shorthand", "operator"];

function docId(tenantId, phone, weekStart) {
  return `${tenantId}_${phone}_${weekStart}`;
}

function emptyDoc(tenantId, phone, weekStart) {
  return {
    tenantId,
    phone,
    weekStart,
    days: {},
    source: null,
    submittedAt: null,
    askedAt: null,
    chasedAt: null,
  };
}

/** Keeps only real dates of the week, with canonical block lists. */
function normalizeDays(days, weekStart) {
  const valid = new Set(weekDates(weekStart));
  const clean = {};
  for (const [dateIso, blocks] of Object.entries(days || {})) {
    if (!valid.has(dateIso)) continue;
    const normalized = normalizeBlocks(blocks);
    if (normalized.length) clean[dateIso] = normalized;
  }
  return clean;
}

/** True once a human has actually answered for this week. */
function isSubmitted(doc) {
  return Boolean(doc && doc.submittedAt);
}

/**
 * The three-state answer for one cell.
 * @param {object|null} doc @param {string} dateIso @param {string} block
 * @returns {"available"|"unavailable"|"unknown"}
 */
function stateFor(doc, dateIso, block) {
  if (!isSubmitted(doc)) return STATES.UNKNOWN;
  const blocks = normalizeBlocks((doc.days || {})[dateIso]);
  return blocks.includes(block) ? STATES.AVAILABLE : STATES.UNAVAILABLE;
}

/** The same question asked about a shift rather than a cell. */
function stateForShift(doc, startsAt) {
  const { block, dateIso } = blockFor(startsAt);
  return stateFor(doc, dateIso, block);
}

/** How many of the 21 cells this person declared, for the supply grid. */
function declaredCellCount(doc) {
  if (!isSubmitted(doc)) return 0;
  return Object.values(doc.days || {}).reduce((sum, blocks) => sum + normalizeBlocks(blocks).length, 0);
}

/**
 * Shared filter logic for both twins and both stores. Given the staff pool and
 * a request, splits by the three states. The blast engine's wave tiers map onto
 * this directly: wave 1 takes `available`, wave 2 takes `unknown` only.
 */
async function partitionByState(store, pool, request) {
  const { dateIso } = blockFor(request.startsAt);
  const weekStart = weekStartOf(`${dateIso}T12:00:00`);
  const available = [];
  const unavailable = [];
  const unknown = [];

  for (const staff of pool) {
    const doc = await store.find(request.tenantId, staff.phone, weekStart);
    const state = stateForShift(doc, request.startsAt);
    if (state === STATES.AVAILABLE) available.push(staff);
    else if (state === STATES.UNAVAILABLE) unavailable.push(staff);
    else unknown.push(staff);
  }
  return { available, unavailable, unknown };
}

class InMemoryAvailabilityStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._docs = new Map();
  }

  async find(tenantId, phone, weekStart) {
    return this._docs.get(docId(tenantId, phone, weekStart)) || null;
  }

  /** The doc, or a blank one — so callers building a reply never branch. */
  async findOrEmpty(tenantId, phone, weekStart) {
    return (await this.find(tenantId, phone, weekStart)) || emptyDoc(tenantId, phone, weekStart);
  }

  /**
   * Records a human answer. This is the only way `submittedAt` gets set, which
   * is what keeps "we asked" and "they answered" distinguishable.
   */
  async submit(tenantId, phone, weekStart, days, source) {
    const id = docId(tenantId, phone, weekStart);
    const existing = this._docs.get(id) || emptyDoc(tenantId, phone, weekStart);
    existing.days = normalizeDays(days, weekStart);
    existing.source = SOURCES.includes(source) ? source : "operator";
    existing.submittedAt = new Date().toISOString();
    this._docs.set(id, existing);
    return existing;
  }

  /**
   * An explicit "not available at all this week". Distinct from silence: the
   * person answered, and every cell is now a real no.
   */
  async submitNone(tenantId, phone, weekStart, source) {
    return this.submit(tenantId, phone, weekStart, {}, source);
  }

  /** Notes that the weekly ping went out. Never touches `submittedAt`. */
  async markAsked(tenantId, phone, weekStart, field = "askedAt") {
    const id = docId(tenantId, phone, weekStart);
    const existing = this._docs.get(id) || emptyDoc(tenantId, phone, weekStart);
    existing[field] = new Date().toISOString();
    this._docs.set(id, existing);
    return existing;
  }

  async listByWeek(tenantId, weekStart) {
    return [...this._docs.values()].filter(
      (d) => d.tenantId === tenantId && d.weekStart === weekStart
    );
  }

  /**
   * The most recent week this person actually answered for, before `weekStart`.
   * Powers "same again" — the highest-leverage rung of the capture ladder.
   */
  async findPreviousSubmitted(tenantId, phone, weekStart) {
    return [...this._docs.values()]
      .filter(
        (d) =>
          d.tenantId === tenantId && d.phone === phone && d.submittedAt && d.weekStart < weekStart
      )
      .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))[0] || null;
  }

  /** Availability expires with the week — nothing to clean up, just don't read it. */
  async partition(pool, request) {
    return partitionByState(this, pool, request);
  }

  /** Wave 1 of the planned lane: people who said yes to this block. */
  async filterAvailable(pool, request) {
    return (await this.partition(pool, request)).available;
  }

  /**
   * Wave 2: availability unknown. Deliberately NOT "everyone we haven't heard
   * yes from" — somebody who told us they're unavailable has answered, and
   * blasting them again is how a casual pool learns to ignore the messages.
   */
  async filterUnknown(pool, request) {
    return (await this.partition(pool, request)).unknown;
  }
}

/** Firestore-backed twin. Document ID is tenantId_phone_weekStart. */
class FirestoreAvailabilityStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("availability");
  }

  async find(tenantId, phone, weekStart) {
    const doc = await this.collection.doc(docId(tenantId, phone, weekStart)).get();
    return doc.exists ? doc.data() : null;
  }

  async findOrEmpty(tenantId, phone, weekStart) {
    return (await this.find(tenantId, phone, weekStart)) || emptyDoc(tenantId, phone, weekStart);
  }

  async submit(tenantId, phone, weekStart, days, source) {
    const ref = this.collection.doc(docId(tenantId, phone, weekStart));
    const patch = {
      tenantId,
      phone,
      weekStart,
      days: normalizeDays(days, weekStart),
      source: SOURCES.includes(source) ? source : "operator",
      submittedAt: new Date().toISOString(),
    };
    await ref.set(patch, { merge: true });
    const doc = await ref.get();
    return doc.data();
  }

  async submitNone(tenantId, phone, weekStart, source) {
    return this.submit(tenantId, phone, weekStart, {}, source);
  }

  async markAsked(tenantId, phone, weekStart, field = "askedAt") {
    const ref = this.collection.doc(docId(tenantId, phone, weekStart));
    // merge:true so this creates the document without inventing an answer —
    // days stays absent and submittedAt stays null, i.e. still unknown.
    await ref.set(
      { tenantId, phone, weekStart, [field]: new Date().toISOString() },
      { merge: true }
    );
    const doc = await ref.get();
    return doc.data();
  }

  /** Two equality filters — served by merging single-field indexes. */
  async listByWeek(tenantId, weekStart) {
    const snap = await this.collection
      .where("tenantId", "==", tenantId)
      .where("weekStart", "==", weekStart)
      .get();
    return snap.docs.map((doc) => doc.data());
  }

  async findPreviousSubmitted(tenantId, phone, weekStart) {
    // One equality filter plus a JS sort: a person has a few dozen weeks of
    // history at most, so this stays cheap and needs no composite index.
    const snap = await this.collection.where("phone", "==", phone).get();
    return snap.docs
      .map((doc) => doc.data())
      .filter((d) => d.tenantId === tenantId && d.submittedAt && d.weekStart < weekStart)
      .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))[0] || null;
  }

  async partition(pool, request) {
    return partitionByState(this, pool, request);
  }

  async filterAvailable(pool, request) {
    return (await this.partition(pool, request)).available;
  }

  async filterUnknown(pool, request) {
    return (await this.partition(pool, request)).unknown;
  }
}

module.exports = {
  InMemoryAvailabilityStore,
  FirestoreAvailabilityStore,
  stateFor,
  stateForShift,
  isSubmitted,
  normalizeDays,
  declaredCellCount,
  emptyDoc,
  STATES,
  SOURCES,
  BLOCKS,
};
