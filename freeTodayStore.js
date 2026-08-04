"use strict";

const { localDateIso } = require("./availabilityBlocks");

/**
 * The free-today pool — the same-day answer, build order step 3 of
 * docs/agencymodelshape.md.
 *
 * Data model:
 *   freeToday/{tenantId_phone} = { tenantId, phone, declaredAt, expiresAt }
 *
 * A separate, opt-in, self-expiring signal: tap once in the morning and you're a
 * hot lead for about twelve hours, then it decays on its own.
 *
 * Three properties make this worth having as its own collection rather than a
 * flag on the staff record:
 *
 *   - **Opt-in makes it high-signal.** Nobody taps it unless they want a shift
 *     today, and the incentive is real: first refusal on today's work.
 *   - **It expires by itself.** There is no sweep to forget to run and no stale
 *     "free" flag from last Tuesday. Expiry is a timestamp comparison at read
 *     time, so a process that never runs cannot leave bad data behind.
 *   - **It is never edited by an operator.** Only the person themselves can say
 *     they're free today. An operator marking somebody free would recreate
 *     exactly the guesswork this signal exists to remove.
 *
 * Feeds wave 1 of the urgent lane, ranked by median response time.
 */

/** How long a declaration lasts. About a working day, not a calendar day. */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function docId(tenantId, phone) {
  return `${tenantId}_${phone}`;
}

function isLive(doc, now = new Date()) {
  return Boolean(doc && doc.expiresAt && new Date(doc.expiresAt).getTime() > now.getTime());
}

/**
 * When a declaration made now should lapse: twelve hours, but never past the
 * end of the local day plus a little — "free today" should not quietly mean
 * "free tomorrow morning" for somebody who taps it at 9pm.
 */
function expiryFor(now = new Date(), ttlMs = DEFAULT_TTL_MS) {
  const byTtl = new Date(now.getTime() + ttlMs);
  const endOfDay = new Date(now.getTime());
  endOfDay.setHours(23, 59, 59, 999);
  return new Date(Math.min(byTtl.getTime(), endOfDay.getTime())).toISOString();
}

/** Minutes left, for the confirmation message and the by-hour report. */
function minutesRemaining(doc, now = new Date()) {
  if (!isLive(doc, now)) return 0;
  return Math.max(0, Math.round((new Date(doc.expiresAt).getTime() - now.getTime()) / 60000));
}

class InMemoryFreeTodayStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._docs = new Map();
  }

  /**
   * Somebody taps "today". Re-tapping extends rather than duplicating, which is
   * the behaviour a person expects if they tap again at lunchtime.
   */
  async declare(tenantId, phone, now = new Date(), ttlMs = DEFAULT_TTL_MS) {
    const id = docId(tenantId, phone);
    const existing = this._docs.get(id);
    const doc = {
      tenantId,
      phone,
      // The original tap is what the by-hour report is about, so it survives.
      declaredAt: isLive(existing, now) ? existing.declaredAt : now.toISOString(),
      expiresAt: expiryFor(now, ttlMs),
    };
    this._docs.set(id, doc);
    return doc;
  }

  /** Only the person themselves withdraws — see the note at the top. */
  async withdraw(tenantId, phone) {
    this._docs.delete(docId(tenantId, phone));
  }

  async find(tenantId, phone, now = new Date()) {
    const doc = this._docs.get(docId(tenantId, phone));
    return isLive(doc, now) ? doc : null;
  }

  /** Everyone currently in the pool. Expired entries are simply not returned. */
  async listLive(tenantId, now = new Date()) {
    return [...this._docs.values()].filter((d) => d.tenantId === tenantId && isLive(d, now));
  }

  /**
   * Every declaration made on a date, expired or not — the free-today-by-hour
   * report needs the history, not the live pool. Thin at 5am on Saturdays is a
   * recruitment target, months early.
   */
  async listDeclaredOn(tenantId, dateIso) {
    return [...this._docs.values()].filter(
      (d) => d.tenantId === tenantId && localDateIso(new Date(d.declaredAt)) === dateIso
    );
  }

  /**
   * Wave 1 of the urgent lane. Only applies to shifts starting today: "free
   * today" says nothing about Thursday, and treating it as if it did would put
   * the least reliable signal in front of the most reliable one.
   */
  async filterFreeToday(pool, request, now = new Date()) {
    const startsToday = localDateIso(new Date(request.startsAt)) === localDateIso(now);
    if (!startsToday) return [];
    const live = await this.listLive(request.tenantId, now);
    const phones = new Set(live.map((d) => d.phone));
    return pool.filter((s) => phones.has(s.phone));
  }
}

/** Firestore-backed twin. */
class FirestoreFreeTodayStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("freeToday");
  }

  async declare(tenantId, phone, now = new Date(), ttlMs = DEFAULT_TTL_MS) {
    const ref = this.collection.doc(docId(tenantId, phone));
    const existing = await ref.get();
    const previous = existing.exists ? existing.data() : null;
    const doc = {
      tenantId,
      phone,
      declaredAt: isLive(previous, now) ? previous.declaredAt : now.toISOString(),
      expiresAt: expiryFor(now, ttlMs),
    };
    await ref.set(doc);
    return doc;
  }

  async withdraw(tenantId, phone) {
    await this.collection.doc(docId(tenantId, phone)).delete();
  }

  async find(tenantId, phone, now = new Date()) {
    const doc = await this.collection.doc(docId(tenantId, phone)).get();
    if (!doc.exists) return null;
    return isLive(doc.data(), now) ? doc.data() : null;
  }

  /**
   * One equality filter plus a JS expiry check. Filtering on expiresAt in the
   * query would need a composite index for no benefit: this collection has at
   * most one row per staff member.
   */
  async listLive(tenantId, now = new Date()) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs.map((d) => d.data()).filter((d) => isLive(d, now));
  }

  async listDeclaredOn(tenantId, dateIso) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs
      .map((d) => d.data())
      .filter((d) => localDateIso(new Date(d.declaredAt)) === dateIso);
  }

  async filterFreeToday(pool, request, now = new Date()) {
    const startsToday = localDateIso(new Date(request.startsAt)) === localDateIso(now);
    if (!startsToday) return [];
    const live = await this.listLive(request.tenantId, now);
    const phones = new Set(live.map((d) => d.phone));
    return pool.filter((s) => phones.has(s.phone));
  }
}

module.exports = {
  InMemoryFreeTodayStore,
  FirestoreFreeTodayStore,
  isLive,
  expiryFor,
  minutesRemaining,
  DEFAULT_TTL_MS,
};
