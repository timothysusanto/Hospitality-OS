"use strict";

/**
 * Food/beverage purchases — the input side of food cost.
 *
 * Data model:
 *   purchases/{id} = { tenantId, date: "YYYY-MM-DD", amount: number,
 *                      supplier: string|null, source: "manual"|"whatsapp"|"invoice_photo",
 *                      loggedBy: string|null, createdAt: ISO }
 *
 * source is recorded now so the invoice-photo flow (vision, later build
 * step) drops into the same collection without a migration.
 */

class InMemoryPurchasesStore {
  constructor() {
    this._purchases = new Map();
    this._nextId = 1;
  }

  async add({ tenantId, date, amount, supplier, source, loggedBy }) {
    const id = `purch_${this._nextId++}`;
    const record = {
      id, tenantId, date, amount,
      supplier: supplier || null,
      source: source || "manual",
      loggedBy: loggedBy || null,
      createdAt: new Date().toISOString(),
    };
    this._purchases.set(id, record);
    return record;
  }

  /** All purchases for a tenant — callers filter by date range in JS. */
  async listByTenant(tenantId) {
    return [...this._purchases.values()].filter((p) => p.tenantId === tenantId);
  }

  async remove(id) {
    return this._purchases.delete(id);
  }
}

class FirestorePurchasesStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("purchases");
  }

  async add({ tenantId, date, amount, supplier, source, loggedBy }) {
    const record = {
      tenantId, date, amount,
      supplier: supplier || null,
      source: source || "manual",
      loggedBy: loggedBy || null,
      createdAt: new Date().toISOString(),
    };
    const ref = await this.collection.add(record);
    return { id: ref.id, ...record };
  }

  /**
   * Single-field equality filter — no composite index required. Date-range
   * filtering happens in JS at the API layer, deliberately (see shifts).
   */
  async listByTenant(tenantId) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async remove(id) {
    await this.collection.doc(id).delete();
    return true;
  }
}

module.exports = { InMemoryPurchasesStore, FirestorePurchasesStore };
