"use strict";

/**
 * Sites — the buildings staff are actually sent to.
 *
 * Data model (docs/agencymodelshape.md):
 *   sites/{siteId} = { tenantId, name, address,
 *                      geofence: {lat, lng, radiusMeters},
 *                      requesters: [{phone, name}],
 *                      billRates: {[role]: number},
 *                      active: boolean }
 *
 * This replaces the single per-tenant geofence in tenantStore.js. A venue
 * with one building is just a tenant with one site; an agency supplying
 * fifteen hotels is the same tenant with fifteen. Either way the geofence
 * a clock-in is checked against comes from the site on the assigned shift,
 * never from the tenant — see siteResolver.js.
 *
 * `tenantId` scopes every site to the agency that owns it, same discipline
 * as every other collection here. `requesters` and `billRates` are carried
 * from day one because they're free to store now and impossible to
 * backfill later (build order steps 4 and 6 read them).
 */

/**
 * @typedef {{lat: number, lng: number, radiusMeters: number}} Geofence
 * @typedef {{siteId: string, tenantId: string, name: string, address: string|null,
 *            geofence: Geofence|null, requesters: object[], billRates: object,
 *            active: boolean}} SiteRecord
 */

/** Radius bounds — see geofence.js on why this has to absorb GPS wobble alone. */
const MIN_RADIUS_METERS = 20;
const MAX_RADIUS_METERS = 2000;
const DEFAULT_RADIUS_METERS = 75;

/**
 * Coerces loose input (an API body, a config blob) into a storable geofence,
 * or null if it isn't one. Returning null rather than throwing keeps a site
 * creatable before someone has stood in the car park to get the coordinates.
 * @param {any} raw @returns {Geofence|null}
 */
function normalizeGeofence(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!isFinite(lng) || lng < -180 || lng > 180) return null;
  const requested = Number(raw.radiusMeters);
  const radiusMeters = isFinite(requested)
    ? Math.min(MAX_RADIUS_METERS, Math.max(MIN_RADIUS_METERS, Math.round(requested)))
    : DEFAULT_RADIUS_METERS;
  return { lat, lng, radiusMeters };
}

/**
 * Fills in every field a site is expected to have, so readers never have to
 * guard on shape. Unknown keys are dropped rather than passed through —
 * this is the write boundary for a collection the geofence now depends on.
 * @param {string} siteId @param {object} data @returns {SiteRecord}
 */
function normalizeSite(siteId, data = {}) {
  return {
    siteId,
    tenantId: data.tenantId || null,
    name: data.name ? String(data.name).trim() : siteId,
    address: data.address ? String(data.address).trim() : null,
    geofence: normalizeGeofence(data.geofence),
    requesters: Array.isArray(data.requesters) ? data.requesters : [],
    billRates: data.billRates && typeof data.billRates === "object" ? data.billRates : {},
    active: data.active !== false,
  };
}

class InMemorySiteStore {
  constructor() {
    /** @type {Map<string, SiteRecord>} */
    this._sites = new Map();

    // The demo venue's own building, carrying the geofence that used to live
    // on the tenant document. Keeps a fresh in-memory boot clocking people in
    // exactly as it did before sites existed.
    this.upsert("demo-venue-main", {
      tenantId: "demo-venue",
      name: "Demo Venue",
      geofence: { lat: -33.8568, lng: 151.2153, radiusMeters: 75 }, // Sydney Opera House, as a placeholder
    });
  }

  /** @param {string} siteId @param {object} data @returns {SiteRecord} */
  upsert(siteId, data) {
    const existing = this._sites.get(siteId);
    const site = normalizeSite(siteId, { ...existing, ...data });
    this._sites.set(siteId, site);
    return site;
  }

  /** @param {string} siteId @returns {Promise<SiteRecord|null>} */
  async findById(siteId) {
    return this._sites.get(siteId) || null;
  }

  /**
   * Every site for a tenant, active first then by name — the order an
   * operator expects in a picker.
   * @param {string} tenantId @param {{includeInactive?: boolean}} [opts]
   * @returns {Promise<SiteRecord[]>}
   */
  async listByTenant(tenantId, opts = {}) {
    return [...this._sites.values()]
      .filter((s) => s.tenantId === tenantId && (opts.includeInactive || s.active))
      .sort(compareSites);
  }

  /**
   * Soft delete. A site is never hard-deleted: shifts reference it by id and
   * an invoice from three months ago still has to name the building.
   * @param {string} siteId @returns {Promise<SiteRecord>}
   */
  async setActive(siteId, active) {
    const site = this._sites.get(siteId);
    if (!site) throw new Error("SITE_NOT_FOUND");
    site.active = Boolean(active);
    return site;
  }

  /**
   * Which sites a phone number is allowed to order staff for.
   *
   * **Only registered numbers can order.** This is the gate for the whole client
   * intake flow (docs/agencymodelshape.md step 4) — an unknown number gets asked
   * to have their manager register it, never a shift.
   *
   * Returns every matching site, because a regional manager legitimately orders
   * for several buildings and the parser needs to know which ones to consider.
   */
  async findByRequesterPhone(tenantId, phone) {
    return [...this._sites.values()].filter(
      (s) =>
        s.tenantId === tenantId &&
        s.active &&
        (s.requesters || []).some((r) => r && r.phone === phone)
    );
  }

  async setRequesters(siteId, requesters) {
    const site = this._sites.get(siteId);
    if (!site) throw new Error("SITE_NOT_FOUND");
    site.requesters = normalizeRequesters(requesters);
    return site;
  }
}

/**
 * Firestore-backed twin. Document ID is the siteId — a slug, so it reads
 * usefully on a shift record ("hilton-sydney" beats an autogenerated id when
 * you're eyeballing why a clock-in got flagged).
 */
class FirestoreSiteStore {
  constructor(db) {
    this.db = db;
    this.collection = db.collection("sites");
  }

  /**
   * Read-then-merge, matching the in-memory twin: normalizeSite() fills in
   * every field, so writing its output straight through would blank out
   * anything the caller didn't pass (a rename would clear the geofence).
   */
  async upsert(siteId, data) {
    const ref = this.collection.doc(siteId);
    const doc = await ref.get();
    const site = normalizeSite(siteId, { ...(doc.exists ? doc.data() : {}), ...data });
    const { siteId: _id, ...rest } = site;
    await ref.set(rest, { merge: true });
    return site;
  }

  async findById(siteId) {
    const doc = await this.collection.doc(siteId).get();
    return doc.exists ? normalizeSite(doc.id, doc.data()) : null;
  }

  /**
   * Single-field equality filter, so no composite index — the active filter
   * and the sort happen in JS, same discipline as the other stores.
   */
  async listByTenant(tenantId, opts = {}) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs
      .map((doc) => normalizeSite(doc.id, doc.data()))
      .filter((s) => opts.includeInactive || s.active)
      .sort(compareSites);
  }

  async setActive(siteId, active) {
    const ref = this.collection.doc(siteId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("SITE_NOT_FOUND");
    await ref.update({ active: Boolean(active) });
    return normalizeSite(siteId, { ...doc.data(), active: Boolean(active) });
  }

  /**
   * See the in-memory twin. Filtered in JS rather than with array-contains,
   * because requesters are objects and Firestore can only match a whole element
   * exactly — the name would have to be identical too.
   */
  async findByRequesterPhone(tenantId, phone) {
    const snap = await this.collection.where("tenantId", "==", tenantId).get();
    return snap.docs
      .map((doc) => normalizeSite(doc.id, doc.data()))
      .filter((s) => s.active && (s.requesters || []).some((r) => r && r.phone === phone));
  }

  async setRequesters(siteId, requesters) {
    const ref = this.collection.doc(siteId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error("SITE_NOT_FOUND");
    const clean = normalizeRequesters(requesters);
    await ref.update({ requesters: clean });
    return normalizeSite(siteId, { ...doc.data(), requesters: clean });
  }
}

/** Digits only, deduped — a phone number is the identity here, so it must be exact. */
function normalizeRequesters(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const phone = String((entry && entry.phone) || "").replace(/[^\d]/g, "");
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ phone, name: entry && entry.name ? String(entry.name).trim() : null });
  }
  return out;
}

function compareSites(a, b) {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Turns "Hilton Sydney" into "hilton-sydney" for use as a document ID. */
function slugifySiteId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

module.exports = {
  InMemorySiteStore,
  FirestoreSiteStore,
  normalizeSite,
  normalizeGeofence,
  normalizeRequesters,
  slugifySiteId,
  MIN_RADIUS_METERS,
  MAX_RADIUS_METERS,
  DEFAULT_RADIUS_METERS,
};
