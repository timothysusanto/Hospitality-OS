"use strict";

/**
 * Build order step 1 (docs/agencymodelshape.md): sites as a first-class
 * collection, and the clock-in geofence coming off the tenant onto the
 * assigned shift.
 *
 * Run with `npm test` — node:test and node:assert only, no dependencies, so
 * this suite works on a fresh clone with no install step.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemorySiteStore, normalizeGeofence, slugifySiteId } = require("../siteStore");
const { InMemoryRosterStore, normalizeAssignment, normalizeAssignments } = require("../rosterStore");
const { InMemoryTenantStore } = require("../tenantStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { resolveSiteForClockIn, candidateRosterDates } = require("../siteResolver");
const { checkGeofence, distanceMeters } = require("../geofence");

/* Two real Sydney hotels, ~2.5km apart — far enough that a geofence built for
   one can never accidentally accept a location at the other. */
const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const MANLY = { lat: -33.7969, lng: 151.2876, radiusMeters: 75 };

function freshStores() {
  const siteStore = new InMemorySiteStore();
  const rosterStore = new InMemoryRosterStore();
  const tenantStore = new InMemoryTenantStore();
  const shiftsStore = new InMemoryShiftsStore();
  return { siteStore, rosterStore, tenantStore, shiftsStore };
}

/** A tenant with no sites at all, so the seeded demo site can't interfere. */
function agencyStores() {
  const stores = freshStores();
  // The seeded demo site belongs to "demo-venue"; "agency" starts empty.
  return stores;
}

const agencyStaff = { phone: "61400000001", tenantId: "agency", name: "Maria" };

/* ---------------------------------------------------------------- siteStore */

test("normalizeGeofence rejects junk and clamps the radius", () => {
  assert.equal(normalizeGeofence(null), null);
  assert.equal(normalizeGeofence({ lat: 999, lng: 0 }), null);
  assert.equal(normalizeGeofence({ lat: 0, lng: "not a number" }), null);

  // Missing radius falls back to the default rather than failing the site.
  assert.equal(normalizeGeofence({ lat: -33.87, lng: 151.2 }).radiusMeters, 75);
  // A 5m radius can't absorb GPS wobble, and a 50km one isn't a geofence.
  assert.equal(normalizeGeofence({ lat: -33.87, lng: 151.2, radiusMeters: 5 }).radiusMeters, 20);
  assert.equal(normalizeGeofence({ lat: -33.87, lng: 151.2, radiusMeters: 50000 }).radiusMeters, 2000);
});

test("slugifySiteId makes a readable document id", () => {
  assert.equal(slugifySiteId("Hilton Sydney"), "hilton-sydney");
  assert.equal(slugifySiteId("  Four Seasons — Sydney!  "), "four-seasons-sydney");
  assert.equal(slugifySiteId("!!!"), "");
});

test("sites are scoped by tenant and soft-deleted, never dropped", async () => {
  const { siteStore } = agencyStores();
  siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });

  assert.deepEqual((await siteStore.listByTenant("agency")).map((s) => s.siteId), [
    "hilton-sydney",
    "manly-pacific",
  ]);
  // The seeded demo site must not leak into another tenant's list.
  assert.equal((await siteStore.listByTenant("agency")).some((s) => s.tenantId !== "agency"), false);

  await siteStore.setActive("manly-pacific", false);
  assert.deepEqual((await siteStore.listByTenant("agency")).map((s) => s.siteId), ["hilton-sydney"]);
  // Still retrievable — shifts and invoices reference it by id forever.
  assert.equal((await siteStore.findById("manly-pacific")).name, "Manly Pacific");
  assert.equal((await siteStore.listByTenant("agency", { includeInactive: true })).length, 2);
});

/* --------------------------------------------------------- roster normalizer */

test("normalizeAssignment reads both the legacy and the site-carrying shape", () => {
  assert.deepEqual(normalizeAssignment("AM"), { slot: "AM", siteId: null });
  assert.deepEqual(normalizeAssignment("am"), { slot: "AM", siteId: null });
  assert.deepEqual(normalizeAssignment({ slot: "PM", siteId: "hilton-sydney" }), {
    slot: "PM",
    siteId: "hilton-sydney",
  });
  // Custom shift times painted from the dashboard's editor survive untouched —
  // dropping these would silently delete every non-preset shift on save.
  assert.deepEqual(normalizeAssignment("09:00-17:00"), { slot: "09:00-17:00", siteId: null });
  assert.deepEqual(normalizeAssignment({ slot: "18:00-02:00", siteId: "manly-pacific" }), {
    slot: "18:00-02:00",
    siteId: "manly-pacific",
  });

  assert.equal(normalizeAssignment(""), null);
  assert.equal(normalizeAssignment("BRUNCH"), null);
  assert.equal(normalizeAssignment({ siteId: "hilton-sydney" }), null);
});

test("normalizeAssignments strips a siteId the tenant doesn't own", () => {
  const known = (siteId) => siteId === "hilton-sydney";
  const clean = normalizeAssignments(
    {
      "2026-08-10": {
        "61400000001": { slot: "AM", siteId: "hilton-sydney" },
        "61400000002": { slot: "PM", siteId: "some-other-agencys-site" },
        "61400000003": "nonsense",
      },
      "not-a-date": { "61400000001": "AM" },
      "2026-08-11": { "61400000001": "" },
    },
    known
  );

  assert.deepEqual(clean, {
    "2026-08-10": {
      // A dangling siteId becomes a geofence that can never match, so it is
      // dropped to null rather than stored — the shift falls back to
      // resolution instead of flagging someone who is exactly where they were
      // told to be.
      "61400000001": { slot: "AM", siteId: "hilton-sydney" },
      "61400000002": { slot: "PM", siteId: null },
    },
  });
});

/* ------------------------------------------------------------ site resolution */

test("the rostered site wins, and two people can be measured against two buildings", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });

  const at = new Date("2026-08-10T09:00:00");
  await deps.rosterStore.saveWeek("agency", "2026-08-10", {
    "2026-08-10": {
      "61400000001": { slot: "AM", siteId: "hilton-sydney" },
      "61400000002": { slot: "AM", siteId: "manly-pacific" },
    },
  });

  const maria = await resolveSiteForClockIn({ staff: agencyStaff, at, deps });
  assert.equal(maria.source, "roster");
  assert.equal(maria.site.siteId, "hilton-sydney");

  const ahmed = await resolveSiteForClockIn({
    staff: { ...agencyStaff, phone: "61400000002" },
    at,
    deps,
  });
  assert.equal(ahmed.site.siteId, "manly-pacific");

  // The whole point of step 1: standing at the Hilton passes for the person
  // rostered there and fails for the person rostered at Manly. Under a single
  // tenant-level geofence one of these two was always going to be flagged.
  const atHilton = { lat: HILTON.lat, lng: HILTON.lng };
  assert.equal(checkGeofence(atHilton, maria.geofence).withinRadius, true);
  assert.equal(checkGeofence(atHilton, ahmed.geofence).withinRadius, false);
});

test("a single active site needs no roster entry", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });

  const resolution = await resolveSiteForClockIn({ staff: agencyStaff, deps });
  assert.equal(resolution.source, "only-site");
  assert.equal(resolution.site.siteId, "hilton-sydney");
});

test("several sites and no roster entry refuses rather than guessing", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });

  const resolution = await resolveSiteForClockIn({ staff: agencyStaff, deps });
  assert.equal(resolution.geofence, null);
  assert.equal(resolution.reason, "AMBIGUOUS_SITE");
  assert.deepEqual(resolution.candidates.map((s) => s.name), ["Hilton Sydney", "Manly Pacific"]);
});

test("the pre-sites tenant geofence still works, and stops being used once a site exists", async () => {
  const deps = agencyStores();
  deps.tenantStore.upsert("legacy-venue", { name: "Legacy Venue", geofence: MANLY });
  const staff = { phone: "61400000009", tenantId: "legacy-venue", name: "Jo" };

  const before = await resolveSiteForClockIn({ staff, deps });
  assert.equal(before.source, "legacy-tenant");
  assert.deepEqual(before.geofence, MANLY);
  // No site document exists, so the shift must record no siteId rather than
  // inventing one.
  assert.equal(before.site, null);

  deps.siteStore.upsert("legacy-main", { tenantId: "legacy-venue", name: "Legacy Main", geofence: HILTON });
  const after = await resolveSiteForClockIn({ staff, deps });
  assert.equal(after.source, "only-site");
  assert.equal(after.site.siteId, "legacy-main");
});

test("deactivating the only site refuses rather than reopening the tenant radius", async () => {
  const deps = agencyStores();
  deps.tenantStore.upsert("legacy-venue", { name: "Legacy Venue", geofence: MANLY });
  deps.siteStore.upsert("legacy-main", { tenantId: "legacy-venue", name: "Legacy Main", geofence: HILTON });
  await deps.siteStore.setActive("legacy-main", false);

  // The tenant has had a site, so its pre-sites geofence is dead data. Falling
  // back to it here would measure clock-ins against a radius nobody has
  // maintained since sites were introduced.
  const resolution = await resolveSiteForClockIn({
    staff: { phone: "61400000009", tenantId: "legacy-venue", name: "Jo" },
    deps,
  });
  assert.equal(resolution.geofence, null);
  assert.equal(resolution.reason, "NO_GEOFENCE_CONFIGURED");
});

test("an explicit siteId short-circuits, so both ends of a shift use one building", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });
  await deps.rosterStore.saveWeek("agency", "2026-08-10", {
    "2026-08-10": { "61400000001": { slot: "AM", siteId: "manly-pacific" } },
  });

  // Clocked in at the Hilton yesterday; the roster now says Manly. Clock-out
  // must still measure against the Hilton.
  const resolution = await resolveSiteForClockIn({
    staff: agencyStaff,
    at: new Date("2026-08-10T17:00:00"),
    siteId: "hilton-sydney",
    deps,
  });
  assert.equal(resolution.source, "shift");
  assert.equal(resolution.site.siteId, "hilton-sydney");
});

test("a deleted site is reported, not silently swapped for another", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });

  const resolution = await resolveSiteForClockIn({
    staff: agencyStaff,
    siteId: "site-that-was-deleted",
    deps,
  });
  assert.equal(resolution.reason, "SITE_MISSING");
  assert.equal(resolution.geofence, null);
});

test("a rostered site keeps working after it's deactivated mid-week", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });
  await deps.rosterStore.saveWeek("agency", "2026-08-10", {
    "2026-08-10": { "61400000001": { slot: "AM", siteId: "manly-pacific" } },
  });
  await deps.siteStore.setActive("manly-pacific", false);

  // The person was still sent to Manly. Falling through to "only one active
  // site left" would measure them against the Hilton, 10km away.
  const resolution = await resolveSiteForClockIn({
    staff: agencyStaff,
    at: new Date("2026-08-10T09:00:00"),
    deps,
  });
  assert.equal(resolution.source, "roster");
  assert.equal(resolution.site.siteId, "manly-pacific");
});

test("a night clock-in after midnight finds yesterday's assignment", () => {
  // "A night belongs to the date it starts on" — a porter clocking in at 00:20
  // on the 11th is working the shift rostered on the 10th.
  assert.deepEqual(candidateRosterDates(new Date("2026-08-11T00:20:00")), [
    "2026-08-11",
    "2026-08-10",
  ]);
  // Daytime clock-ins never reach back a day.
  assert.deepEqual(candidateRosterDates(new Date("2026-08-11T09:00:00")), ["2026-08-11"]);
});

test("the night-shift lookback resolves the site rostered the day before", async () => {
  const deps = agencyStores();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });
  await deps.rosterStore.saveWeek("agency", "2026-08-10", {
    "2026-08-10": { "61400000001": { slot: "22:00-06:00", siteId: "manly-pacific" } },
  });

  const resolution = await resolveSiteForClockIn({
    staff: agencyStaff,
    at: new Date("2026-08-11T00:20:00"),
    deps,
  });
  assert.equal(resolution.source, "roster");
  assert.equal(resolution.site.siteId, "manly-pacific");
});

/* ------------------------------------------------------- shifts carry the site */

test("an opened shift records which building it was worked at", async () => {
  const { shiftsStore } = freshStores();
  const { shiftId } = await shiftsStore.openShift({
    tenantId: "agency",
    staffPhone: "61400000001",
    department: null,
    siteId: "hilton-sydney",
    siteName: "Hilton Sydney",
    clockIn: { time: "2026-08-10T07:00:00.000Z", lat: HILTON.lat, lng: HILTON.lng, withinRadius: true, distanceMeters: 4 },
  });

  const open = await shiftsStore.findOpenShift("61400000001");
  assert.equal(open.shiftId, shiftId);
  assert.equal(open.siteId, "hilton-sydney");
  // Denormalized, so the record still reads correctly after a rename.
  assert.equal(open.siteName, "Hilton Sydney");
});

test("a shift opened without a site is explicitly siteless, not undefined", async () => {
  const { shiftsStore } = freshStores();
  await shiftsStore.openShift({
    tenantId: "legacy-venue",
    staffPhone: "61400000009",
    department: null,
    clockIn: { time: "2026-08-10T07:00:00.000Z", lat: MANLY.lat, lng: MANLY.lng, withinRadius: true, distanceMeters: 9 },
  });
  const open = await shiftsStore.findOpenShift("61400000009");
  // Firestore rejects undefined, and "unknown site" has to be readable.
  assert.equal(open.siteId, null);
  assert.equal(open.siteName, null);
});

/* ------------------------------------------------------------------- geofence */

test("the two test hotels are far enough apart to prove the point", () => {
  const apart = distanceMeters(HILTON.lat, HILTON.lng, MANLY.lat, MANLY.lng);
  assert.ok(apart > 1000, `expected the fixtures to be kilometres apart, got ${Math.round(apart)}m`);
});
