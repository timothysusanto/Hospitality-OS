"use strict";

/**
 * Staffing requests — a hotel asking for N people, of a role, at a site, for
 * a window of time.
 *
 * Data model (docs/agencymodelshape.md):
 *   requests/{requestId} = { tenantId, siteId, role, startsAt, endsAt,
 *                            headcount, filled, requestedBy, lane,
 *                            createdAt, confirmedAt, filledAt, outcome,
 *                            wave, waveSentAt, backfillFor }
 *
 * **The lane is derived from the shift start time, never declared.** Nobody at
 * the hotel picks a priority; under twelve hours out is urgent, otherwise
 * planned. Storing it is still worth doing: every report splits by lane, and
 * recomputing it later from `startsAt` would silently reclassify history as
 * the clock moves.
 *
 * `wave` and `waveSentAt` are dispatch state, deliberately on the request
 * document rather than in memory. The blast engine is a tick loop that reads
 * this state back on every pass (see dispatch.js), so a redeploy mid-blast
 * resumes where it left off instead of abandoning a half-filled request.
 */

const crypto = require("crypto");

/** Twelve hours out is the line between the two lanes. */
const URGENT_WINDOW_MS = 12 * 60 * 60 * 1000;

const LANES = { PLANNED: "planned", URGENT: "urgent" };

/**
 * Terminal unless stated: `open` is being worked, `filled` got everyone,
 * `partial` ran out of waves with some seats filled, `unfilled` got nobody,
 * `cancelled` was pulled by the operator or the hotel.
 */
const OUTCOMES = ["open", "filled", "partial", "unfilled", "cancelled"];

/**
 * A short code a staff member can type back ("yes H7K2"). Excludes the
 * characters people misread aloud or in a WhatsApp font — 0/O, 1/I/L, 5/S —
 * because these get relayed over the phone when the app is playing up.
 */
const REF_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";

function shortRef() {
  const bytes = crypto.randomBytes(4);
  let out = "";
  for (const byte of bytes) out += REF_ALPHABET[byte % REF_ALPHABET.length];
  return out;
}

/**
 * Which lane a shift starting at `startsAt` belongs to.
 * @param {string|Date} startsAt @param {Date} [now]
 * @returns {"planned"|"urgent"}
 */
function laneFor(startsAt, now = new Date()) {
  const startMs = new Date(startsAt).getTime();
  return startMs - now.getTime() < URGENT_WINDOW_MS ? LANES.URGENT : LANES.PLANNED;
}

/** Seats still to fill. Never negative, even if data is somehow inconsistent. */
function seatsRemaining(request) {
  return Math.max(0, (request.headcount || 0) - (request.filled || 0));
}

function isLive(request) {
  return request.outcome === "open";
}

/**
 * `fields.now` lets a caller state what "now" is instead of reading the wall
 * clock. The backfill sweep and the tests both need that: a lane derived from
 * the real clock while the rest of the decision used an injected one produces a
 * request that says "planned" about a shift starting in ten minutes.
 *
 * It is never stored — the lane it produces is.
 */
function newRequest(fields) {
  const at = fields.now ? new Date(fields.now) : new Date();
  const now = at.toISOString();
  return {
    tenantId: fields.tenantId,
    ref: fields.ref || shortRef(),
    siteId: fields.siteId,
    siteName: fields.siteName || null,
    role: fields.role || null,
    startsAt: fields.startsAt,
    endsAt: fields.endsAt,
    headcount: Math.max(1, Number(fields.headcount) || 1),
    filled: 0,
    requestedBy: fields.requestedBy || null,
    lane: fields.lane || laneFor(fields.startsAt, at),
    createdAt: now,
    // Free text in, structured confirmation back: a request is only dispatched
    // once someone confirmed the parse. Requests raised from the dashboard are
    // confirmed on creation; ones parsed from a chat message are not.
    confirmedAt: fields.confirmedAt !== undefined ? fields.confirmedAt : now,
    filledAt: null,
    outcome: "open",
    wave: 0,
    waveSentAt: null,
    // Set when this request exists because somebody didn't turn up, so the
    // backfill sweep can tell "already handled" from "not yet noticed".
    backfillFor: fields.backfillFor || null,
  };
}

class InMemoryRequestsStore {
  constructor() {
    /** @type {Map<string, object>} keyed by requestId */
    this._requests = new Map();
    this._nextId = 1;
  }

  async create(fields) {
    const requestId = `req_${this._nextId++}`;
    const request = { requestId, ...newRequest(fields) };
    this._requests.set(requestId, request);
    return request;
  }

  async findById(requestId) {
    return this._requests.get(requestId) || null;
  }

  /** Lookup by the short code staff type back. Live requests only. */
  async findByRef(tenantId, ref) {
    const wanted = String(ref || "").toUpperCase();
    for (const request of this._requests.values()) {
      if (request.tenantId === tenantId && request.ref === wanted && isLive(request)) return request;
    }
    return null;
  }

  /** Everything the dispatcher has to look at on a tick. */
  async listOpen(tenantId) {
    return [...this._requests.values()]
      .filter((r) => r.tenantId === tenantId && isLive(r) && r.confirmedAt)
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  }

  async listRecent(tenantId, sinceIso) {
    return [...this._requests.values()].filter(
      (r) => r.tenantId === tenantId && r.createdAt >= sinceIso
    );
  }

  /** Already-handled backfills, so a tick can't fire the same one twice. */
  async findByBackfillKey(tenantId, backfillFor) {
    for (const request of this._requests.values()) {
      if (request.tenantId === tenantId && request.backfillFor === backfillFor) return request;
    }
    return null;
  }

  /**
   * Take one seat, or fail. This is the atomic first-come claim — the whole
   * race between two people answering the same blast lives here.
   *
   * Safe in memory because JavaScript runs this body to completion without
   * interleaving; the Firestore twin needs a real transaction to get the same
   * guarantee across instances.
   *
   * @returns {Promise<{claimed: boolean, request: object, reason?: string}>}
   */
  async claimSeat(requestId) {
    const request = this._requests.get(requestId);
    if (!request) return { claimed: false, request: null, reason: "REQUEST_NOT_FOUND" };
    // Seats before liveness, so filling up reports ALREADY_FULL rather than
    // REQUEST_CLOSED. "Closed" has to keep meaning withdrawn or given up on —
    // it's what the person who just missed out gets told.
    if (seatsRemaining(request) === 0) return { claimed: false, request, reason: "ALREADY_FULL" };
    if (!isLive(request)) return { claimed: false, request, reason: "REQUEST_CLOSED" };

    request.filled += 1;
    if (seatsRemaining(request) === 0) {
      request.outcome = "filled";
      request.filledAt = new Date().toISOString();
    }
    return { claimed: true, request };
  }

  /** Hands a seat back — an accepted offer that later fell through. */
  async releaseSeat(requestId) {
    const request = this._requests.get(requestId);
    if (!request) return null;
    request.filled = Math.max(0, request.filled - 1);
    if (request.outcome === "filled" && seatsRemaining(request) > 0) {
      request.outcome = "open";
      request.filledAt = null;
    }
    return request;
  }

  async setDispatchState(requestId, { wave, waveSentAt }) {
    const request = this._requests.get(requestId);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    request.wave = wave;
    request.waveSentAt = waveSentAt;
    return request;
  }

  async close(requestId, outcome) {
    const request = this._requests.get(requestId);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (!OUTCOMES.includes(outcome)) throw new Error("INVALID_OUTCOME");
    request.outcome = outcome;
    return request;
  }

  async confirm(requestId) {
    const request = this._requests.get(requestId);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    request.confirmedAt = request.confirmedAt || new Date().toISOString();
    return request;
  }
}

/**
 * Firestore-backed twin. Same tenantId-scoping discipline as the other stores,
 * and single-field equality filters only so no composite index is needed.
 */
class FirestoreRequestsStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("requests");
  }

  async create(fields) {
    const ref = await this.collection.add(newRequest(fields));
    const doc = await ref.get();
    return { requestId: ref.id, ...doc.data() };
  }

  async findById(requestId) {
    const doc = await this.collection.doc(requestId).get();
    return doc.exists ? { requestId: doc.id, ...doc.data() } : null;
  }

  async findByRef(tenantId, ref) {
    const snap = await this.collection
      .where("tenantId", "==", tenantId)
      .where("ref", "==", String(ref || "").toUpperCase())
      .where("outcome", "==", "open")
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { requestId: doc.id, ...doc.data() };
  }

  async listOpen(tenantId) {
    const snap = await this.collection
      .where("tenantId", "==", tenantId)
      .where("outcome", "==", "open")
      .get();
    return snap.docs
      .map((doc) => ({ requestId: doc.id, ...doc.data() }))
      .filter((r) => r.confirmedAt)
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  }

  /**
   * Equality + range needs a composite index (tenantId asc, createdAt asc).
   * Falls back to a full tenant fetch and a JS filter until it exists, so a
   * small deployment needs zero setup — same pattern as shiftsStore.
   */
  async listRecent(tenantId, sinceIso) {
    try {
      const snap = await this.collection
        .where("tenantId", "==", tenantId)
        .where("createdAt", ">=", sinceIso)
        .get();
      return snap.docs.map((doc) => ({ requestId: doc.id, ...doc.data() }));
    } catch (err) {
      console.warn(
        "[requests] recent-range query needs a composite index (tenantId + createdAt) — " +
          "falling back to full fetch. Create it via the link in this error:", err.message
      );
      const snap = await this.collection.where("tenantId", "==", tenantId).get();
      return snap.docs
        .map((doc) => ({ requestId: doc.id, ...doc.data() }))
        .filter((r) => r.createdAt >= sinceIso);
    }
  }

  async findByBackfillKey(tenantId, backfillFor) {
    const snap = await this.collection
      .where("tenantId", "==", tenantId)
      .where("backfillFor", "==", backfillFor)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { requestId: doc.id, ...doc.data() };
  }

  /**
   * The atomic first-come claim. A real transaction, because two people can
   * answer the same blast from two Railway instances in the same second and
   * a read-then-write would hand out the same seat twice.
   */
  async claimSeat(requestId) {
    const docRef = this.collection.doc(requestId);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      if (!doc.exists) return { claimed: false, request: null, reason: "REQUEST_NOT_FOUND" };
      const request = { requestId, ...doc.data() };
      // Seats before liveness — see the in-memory twin.
      if (seatsRemaining(request) === 0) return { claimed: false, request, reason: "ALREADY_FULL" };
      if (!isLive(request)) return { claimed: false, request, reason: "REQUEST_CLOSED" };

      const filled = (request.filled || 0) + 1;
      const full = filled >= request.headcount;
      const patch = full
        ? { filled, outcome: "filled", filledAt: new Date().toISOString() }
        : { filled };
      tx.update(docRef, patch);
      return { claimed: true, request: { ...request, ...patch } };
    });
  }

  async releaseSeat(requestId) {
    const docRef = this.collection.doc(requestId);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      if (!doc.exists) return null;
      const request = { requestId, ...doc.data() };
      const filled = Math.max(0, (request.filled || 0) - 1);
      const patch = { filled };
      if (request.outcome === "filled" && filled < request.headcount) {
        patch.outcome = "open";
        patch.filledAt = null;
      }
      tx.update(docRef, patch);
      return { ...request, ...patch };
    });
  }

  async setDispatchState(requestId, { wave, waveSentAt }) {
    await this.collection.doc(requestId).update({ wave, waveSentAt });
    return this.findById(requestId);
  }

  async close(requestId, outcome) {
    if (!OUTCOMES.includes(outcome)) throw new Error("INVALID_OUTCOME");
    await this.collection.doc(requestId).update({ outcome });
    return this.findById(requestId);
  }

  async confirm(requestId) {
    const request = await this.findById(requestId);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    if (request.confirmedAt) return request;
    await this.collection.doc(requestId).update({ confirmedAt: new Date().toISOString() });
    return this.findById(requestId);
  }
}

module.exports = {
  InMemoryRequestsStore,
  FirestoreRequestsStore,
  laneFor,
  seatsRemaining,
  isLive,
  shortRef,
  LANES,
  OUTCOMES,
  URGENT_WINDOW_MS,
};
