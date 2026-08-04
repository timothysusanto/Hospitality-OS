"use strict";

/**
 * Offers — one row per person per blast wave.
 *
 * Data model (docs/agencymodelshape.md):
 *   offers/{offerId} = { tenantId, requestId, requestRef, phone, wave,
 *                        sentAt, respondedAt, outcome }
 *
 * outcome: "pending" | "accepted" | "declined" | "expired" | "lost"
 *   - `expired` — the wave's accept window closed before they answered
 *   - `lost`    — they answered yes, but the last seat had already gone
 *
 * This collection exists for one reason above all others: **median response
 * time only exists if every offer records when it was sent and when it was
 * answered.** A person with flawless availability data who replies in three
 * hours is worthless at 5:30am, and there is no way to know that after the
 * fact unless both timestamps were written at the time.
 *
 * `lost` is kept distinct from `declined` deliberately. Someone who answered
 * fast and lost the race is one of your best people; folding them into
 * "declined" would rank them alongside the person who said no.
 *
 * **An expired offer is still answerable.** Expiry stops the clock and moves
 * the blast on; it does not stop a human replying. Two cases depend on it:
 * someone who answers late while seats are still open should get the shift, and
 * someone who answers three seconds after the last seat went must be recorded
 * as `lost` with their real response time — not as a non-response. Only a real
 * answer is final.
 */

const PENDING = "pending";
const RESPONSE_OUTCOMES = ["accepted", "declined", "expired", "lost"];

/** Outcomes that represent a human having answered. These can't be overwritten. */
const FINAL_OUTCOMES = ["accepted", "declined", "lost"];

/** Outcomes a late reply is still allowed to resolve. */
const ANSWERABLE_OUTCOMES = [PENDING, "expired"];

/** How long after an offer went out a reply is still treated as an answer. */
const LATE_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Seconds between an offer going out and being answered, or null. */
function responseSeconds(offer) {
  if (!offer.sentAt || !offer.respondedAt) return null;
  const ms = new Date(offer.respondedAt).getTime() - new Date(offer.sentAt).getTime();
  return ms >= 0 ? Math.round(ms / 1000) : null;
}

function newOffer({ tenantId, requestId, requestRef, phone, wave }) {
  return {
    tenantId,
    requestId,
    requestRef: requestRef || null,
    phone,
    wave,
    sentAt: new Date().toISOString(),
    respondedAt: null,
    outcome: PENDING,
  };
}

class InMemoryOffersStore {
  constructor() {
    /** @type {Map<string, object>} keyed by offerId */
    this._offers = new Map();
    this._nextId = 1;
  }

  async create(fields) {
    const offerId = `offer_${this._nextId++}`;
    const offer = { offerId, ...newOffer(fields) };
    this._offers.set(offerId, offer);
    return offer;
  }

  /** One write per person per wave — the caller sends the messages. */
  async createMany(phones, fields) {
    const out = [];
    for (const phone of phones) out.push(await this.create({ ...fields, phone }));
    return out;
  }

  async findById(offerId) {
    return this._offers.get(offerId) || null;
  }

  /**
   * A person's unanswered offers, newest first. Drives the "yes" reply: with
   * exactly one pending offer, "yes" is unambiguous.
   */
  async listPendingByPhone(phone) {
    return [...this._offers.values()]
      .filter((o) => o.phone === phone && o.outcome === PENDING)
      .sort((a, b) => (a.sentAt > b.sentAt ? -1 : 1));
  }

  async findPendingFor(phone, requestId) {
    return (
      [...this._offers.values()].find(
        (o) => o.phone === phone && o.requestId === requestId && o.outcome === PENDING
      ) || null
    );
  }

  /**
   * What a "yes" could be answering: still pending, or expired recently enough
   * that a reply is plainly a reply. See the note at the top of this file.
   */
  async listAnswerableByPhone(phone, now = new Date()) {
    const cutoff = new Date(now.getTime() - LATE_ANSWER_WINDOW_MS).toISOString();
    return [...this._offers.values()]
      .filter(
        (o) =>
          o.phone === phone &&
          ANSWERABLE_OUTCOMES.includes(o.outcome) &&
          o.sentAt >= cutoff
      )
      .sort((a, b) => (a.sentAt > b.sentAt ? -1 : 1));
  }

  async listByRequest(requestId) {
    return [...this._offers.values()]
      .filter((o) => o.requestId === requestId)
      .sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));
  }

  /** Who has already been offered this request, so waves never double-send. */
  async phonesOfferedFor(requestId) {
    const offers = await this.listByRequest(requestId);
    return new Set(offers.map((o) => o.phone));
  }

  /**
   * Records an answer. Returns null when the offer already carries a real
   * answer, so a duplicate "yes" can't overwrite the first response time with a
   * later one. An expired offer is not a real answer, so a late reply resolves
   * it normally.
   */
  async respond(offerId, outcome) {
    if (!RESPONSE_OUTCOMES.includes(outcome)) throw new Error("INVALID_OUTCOME");
    const offer = this._offers.get(offerId);
    if (!offer || FINAL_OUTCOMES.includes(offer.outcome)) return null;
    offer.outcome = outcome;
    offer.respondedAt = new Date().toISOString();
    return offer;
  }

  /**
   * Closes out every still-pending offer on a request — the wave's window has
   * passed, or the request filled and the rest no longer have anything to
   * accept. `respondedAt` stays null: nobody answered, and writing a timestamp
   * here would poison the median with non-responses.
   *
   * This stops the clock, not the conversation: someone who replies afterwards
   * is still recorded properly. See respond().
   */
  async expirePending(requestId) {
    const expired = [];
    for (const offer of this._offers.values()) {
      if (offer.requestId !== requestId || offer.outcome !== PENDING) continue;
      offer.outcome = "expired";
      expired.push(offer);
    }
    return expired;
  }

  async listRecent(tenantId, sinceIso) {
    return [...this._offers.values()].filter(
      (o) => o.tenantId === tenantId && o.sentAt >= sinceIso
    );
  }
}

/** Firestore-backed twin. Single-field equality filters, no composite indexes. */
class FirestoreOffersStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("offers");
  }

  async create(fields) {
    const ref = await this.collection.add(newOffer(fields));
    const doc = await ref.get();
    return { offerId: ref.id, ...doc.data() };
  }

  /**
   * A batched write, because wave 3 of an urgent blast can touch the whole
   * pool and 300 sequential round-trips would outlast the accept window.
   * Firestore caps a batch at 500 operations.
   */
  async createMany(phones, fields) {
    const created = [];
    const CHUNK = 400;
    for (let i = 0; i < phones.length; i += CHUNK) {
      const chunk = phones.slice(i, i + CHUNK);
      const batch = this.db.batch();
      const refs = chunk.map((phone) => {
        const ref = this.collection.doc();
        batch.set(ref, newOffer({ ...fields, phone }));
        return { ref, phone };
      });
      await batch.commit();
      for (const { ref, phone } of refs) {
        created.push({ offerId: ref.id, ...newOffer({ ...fields, phone }) });
      }
    }
    return created;
  }

  async findById(offerId) {
    const doc = await this.collection.doc(offerId).get();
    return doc.exists ? { offerId: doc.id, ...doc.data() } : null;
  }

  async listPendingByPhone(phone) {
    const snap = await this.collection
      .where("phone", "==", phone)
      .where("outcome", "==", "pending")
      .get();
    return snap.docs
      .map((doc) => ({ offerId: doc.id, ...doc.data() }))
      .sort((a, b) => (a.sentAt > b.sentAt ? -1 : 1));
  }

  async findPendingFor(phone, requestId) {
    const snap = await this.collection
      .where("phone", "==", phone)
      .where("requestId", "==", requestId)
      .where("outcome", "==", "pending")
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { offerId: doc.id, ...doc.data() };
  }

  /**
   * Pending or recently expired — see the note at the top of this file. One
   * equality filter plus a JS filter, so no composite index: a person has a
   * handful of offers, not thousands.
   */
  async listAnswerableByPhone(phone, now = new Date()) {
    const cutoff = new Date(now.getTime() - LATE_ANSWER_WINDOW_MS).toISOString();
    const snap = await this.collection.where("phone", "==", phone).get();
    return snap.docs
      .map((doc) => ({ offerId: doc.id, ...doc.data() }))
      .filter((o) => ANSWERABLE_OUTCOMES.includes(o.outcome) && o.sentAt >= cutoff)
      .sort((a, b) => (a.sentAt > b.sentAt ? -1 : 1));
  }

  async listByRequest(requestId) {
    const snap = await this.collection.where("requestId", "==", requestId).get();
    return snap.docs
      .map((doc) => ({ offerId: doc.id, ...doc.data() }))
      .sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));
  }

  async phonesOfferedFor(requestId) {
    const offers = await this.listByRequest(requestId);
    return new Set(offers.map((o) => o.phone));
  }

  /**
   * Transactional, so two "yes" messages arriving together can't both see an
   * unanswered offer and both be treated as the winning response.
   */
  async respond(offerId, outcome) {
    if (!RESPONSE_OUTCOMES.includes(outcome)) throw new Error("INVALID_OUTCOME");
    const docRef = this.collection.doc(offerId);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      if (!doc.exists) return null;
      const offer = { offerId, ...doc.data() };
      if (FINAL_OUTCOMES.includes(offer.outcome)) return null;
      const patch = { outcome, respondedAt: new Date().toISOString() };
      tx.update(docRef, patch);
      return { ...offer, ...patch };
    });
  }

  async expirePending(requestId) {
    const snap = await this.collection
      .where("requestId", "==", requestId)
      .where("outcome", "==", "pending")
      .get();
    if (snap.empty) return [];
    const batch = this.db.batch();
    for (const doc of snap.docs) batch.update(doc.ref, { outcome: "expired" });
    await batch.commit();
    return snap.docs.map((doc) => ({ offerId: doc.id, ...doc.data(), outcome: "expired" }));
  }

  /** See requestsStore.listRecent on the composite-index fallback. */
  async listRecent(tenantId, sinceIso) {
    try {
      const snap = await this.collection
        .where("tenantId", "==", tenantId)
        .where("sentAt", ">=", sinceIso)
        .get();
      return snap.docs.map((doc) => ({ offerId: doc.id, ...doc.data() }));
    } catch (err) {
      console.warn(
        "[offers] recent-range query needs a composite index (tenantId + sentAt) — " +
          "falling back to full fetch. Create it via the link in this error:", err.message
      );
      const snap = await this.collection.where("tenantId", "==", tenantId).get();
      return snap.docs
        .map((doc) => ({ offerId: doc.id, ...doc.data() }))
        .filter((o) => o.sentAt >= sinceIso);
    }
  }
}

module.exports = {
  InMemoryOffersStore,
  FirestoreOffersStore,
  responseSeconds,
  PENDING,
  RESPONSE_OUTCOMES,
  FINAL_OUTCOMES,
  ANSWERABLE_OUTCOMES,
  LATE_ANSWER_WINDOW_MS,
};
