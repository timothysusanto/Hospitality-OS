"use strict";

/**
 * Weekly rosters. One document per venue per week.
 *
 * Data model:
 *   rosters/{tenantId_weekStart} = {
 *     tenantId,
 *     weekStart: "YYYY-MM-DD" (a Monday),
 *     assignments: { "YYYY-MM-DD": { [staffPhone]: "AM"|"PM"|"ALL" } },
 *     published: boolean,
 *     publishedAt: ISO string | null,
 *   }
 *
 * Assignments are day-level slots, not timed shifts — deliberate v1
 * simplification matching how kitchens think in services (lunch/dinner).
 * Timed shifts and named service presets are a later step.
 */

function docId(tenantId, weekStart) {
  return `${tenantId}_${weekStart}`;
}

function emptyWeek(tenantId, weekStart) {
  return { tenantId, weekStart, assignments: {}, published: false, publishedAt: null, revenueForecast: null, openingStock: null, closingStock: null };
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
}

module.exports = { InMemoryRosterStore, FirestoreRosterStore };
