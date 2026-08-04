"use strict";

/**
 * End-to-end clock in/out through clockHandler.js, with WhatsApp's Send API
 * stubbed at the fetch boundary. This is where the step 1 behaviour change is
 * observable: the geofence used is the one on the resolved site, and the shift
 * that comes out the other end names the building it was worked at.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemorySiteStore } = require("../siteStore");
const { InMemoryRosterStore, mondayOf } = require("../rosterStore");
const { InMemoryTenantStore } = require("../tenantStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { InMemoryPendingActions } = require("../pendingActions");
const { handleLocationForClockAction } = require("../clockHandler");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const MANLY = { lat: -33.7969, lng: 151.2876, radiusMeters: 75 };

// whatsapp.js reads these at call time and throws without them.
process.env.WHATSAPP_PHONE_NUMBER_ID = "test-number";
process.env.WHATSAPP_TOKEN = "test-token";

/**
 * Captures every outbound WhatsApp message instead of sending one, and
 * restores the real fetch afterwards.
 */
function withCapturedMessages(fn) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body.text ? body.text.body : JSON.stringify(body.interactive));
    return { ok: true, json: async () => ({}) };
  };
  return Promise.resolve(fn(sent)).finally(() => {
    globalThis.fetch = realFetch;
  });
}

function buildDeps() {
  return {
    siteStore: new InMemorySiteStore(),
    rosterStore: new InMemoryRosterStore(),
    tenantStore: new InMemoryTenantStore(),
    shiftsStore: new InMemoryShiftsStore(),
    pendingActions: new InMemoryPendingActions(),
  };
}

const asLocation = (g) => ({ latitude: g.lat, longitude: g.lng });
const maria = { phone: "61400000001", tenantId: "agency", name: "Maria", department: "housekeeping" };

/** Two hotels, with Maria rostered to the Hilton today. */
async function agencyWithTwoHotels() {
  const deps = buildDeps();
  deps.siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });
  await rosterMariaTo(deps, "hilton-sydney");
  return deps;
}

/**
 * Clock-in resolves against "now", so the fixture week has to be keyed to the
 * real current Monday — not a fixed date, which would only match in the one
 * week it was written.
 */
function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function rosterMariaTo(deps, siteId) {
  return deps.rosterStore.saveWeek("agency", mondayOf(new Date()), {
    [todayIso()]: { "61400000001": { slot: "AM", siteId } },
  });
}

test("clocking in at the rostered hotel succeeds and stamps the site", async () => {
  const deps = await agencyWithTwoHotels();
  await withCapturedMessages(async (sent) => {
    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_in", deps);

    assert.match(sent[0], /Clocked in at Hilton Sydney, Maria/);
    const open = await deps.shiftsStore.findOpenShift(maria.phone);
    assert.equal(open.siteId, "hilton-sydney");
    assert.equal(open.siteName, "Hilton Sydney");
    assert.equal(open.clockIn.withinRadius, true);
    // Records how the site was decided, so a wrong assignment is diagnosable.
    assert.equal(open.clockIn.siteSource, "roster");
  });
});

test("standing at the wrong hotel is flagged, and the flag names the right one", async () => {
  const deps = await agencyWithTwoHotels();
  await withCapturedMessages(async (sent) => {
    // Rostered at the Hilton, actually at Manly Pacific.
    await handleLocationForClockAction(maria.phone, maria, asLocation(MANLY), "clock_in", deps);

    assert.match(sent[0], /from Hilton Sydney, which is outside the clock-in range/);
    const flagged = await deps.shiftsStore.findOpenShift(maria.phone);
    assert.equal(flagged.clockIn.flaggedForReview, true);
    assert.equal(flagged.clockIn.withinRadius, false);
    // The distance is meaningless to a manager without the building it's from.
    assert.equal(flagged.siteName, "Hilton Sydney");
    assert.ok(flagged.clockIn.distanceMeters > 1000);
  });
});

test("with several sites and no assignment, the clock-in is refused, not flagged", async () => {
  const deps = await agencyWithTwoHotels();
  // Same two hotels, but this person isn't on the roster.
  const unrostered = { ...maria, phone: "61400000077", name: "Sam" };

  await withCapturedMessages(async (sent) => {
    await handleLocationForClockAction(unrostered.phone, unrostered, asLocation(HILTON), "clock_in", deps);

    assert.match(sent[0], /don't know which site you're at today/);
    assert.match(sent[0], /Hilton Sydney, Manly Pacific/);
    // No shift at all — a flagged shift would imply they were somewhere wrong,
    // when in fact we simply don't know where they were meant to be.
    assert.equal(await deps.shiftsStore.findOpenShift(unrostered.phone), null);
  });
});

test("clock-out measures against the site stamped on the shift, not today's roster", async () => {
  const deps = await agencyWithTwoHotels();
  await withCapturedMessages(async (sent) => {
    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_in", deps);
    const open = await deps.shiftsStore.findOpenShift(maria.phone);

    // The coordinator reassigns her to Manly for the rest of the week while
    // she's still on shift at the Hilton.
    await rosterMariaTo(deps, "manly-pacific");

    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_out", deps);

    assert.match(sent[1], /Clocked out, Maria/);
    const closed = (await deps.shiftsStore.listByTenant("agency")).find((s) => s.shiftId === open.shiftId);
    // Still measured against the Hilton, so clocking out where she worked
    // reads as within radius.
    assert.equal(closed.clockOut.withinRadius, true);
  });
});

test("a clock-out is never refused when the site has gone missing", async () => {
  const deps = await agencyWithTwoHotels();
  await withCapturedMessages(async (sent) => {
    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_in", deps);
    const open = await deps.shiftsStore.findOpenShift(maria.phone);

    // The site record is gone — a deletion, a bad migration, whatever.
    deps.siteStore.findById = async (siteId) => (siteId === "hilton-sydney" ? null : null);

    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_out", deps);

    // The hours are already worked; losing them would be worse than an
    // unverified location.
    assert.match(sent[1], /Clocked out, Maria/);
    const closed = (await deps.shiftsStore.listByTenant("agency")).find((s) => s.shiftId === open.shiftId);
    assert.ok(closed.clockOut, "the shift must still be closed");
    assert.equal(closed.clockOut.withinRadius, null);
    assert.equal(closed.clockOut.geofenceUnavailable, "SITE_MISSING");
  });
});

test("a single-site venue still clocks in with no roster entry at all", async () => {
  const deps = buildDeps();
  deps.siteStore.upsert("one-hotel", { tenantId: "agency", name: "The Only Hotel", geofence: HILTON });

  await withCapturedMessages(async (sent) => {
    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_in", deps);
    assert.match(sent[0], /Clocked in at The Only Hotel/);
    const open = await deps.shiftsStore.findOpenShift(maria.phone);
    assert.equal(open.clockIn.siteSource, "only-site");
  });
});

test("a deployment still on the tenant geofence keeps working, with no siteId", async () => {
  const deps = buildDeps();
  deps.tenantStore.upsert("legacy-venue", { name: "Legacy Venue", geofence: HILTON });
  const jo = { phone: "61400000009", tenantId: "legacy-venue", name: "Jo", department: null };

  await withCapturedMessages(async (sent) => {
    await handleLocationForClockAction(jo.phone, jo, asLocation(HILTON), "clock_in", deps);
    assert.match(sent[0], /Clocked in at the venue, Jo/);
    const open = await deps.shiftsStore.findOpenShift(jo.phone);
    // No site document exists, so the shift says so rather than inventing one.
    assert.equal(open.siteId, null);
    assert.equal(open.clockIn.siteSource, "legacy-tenant");
  });
});

test("the pending location request is cleared on every path", async () => {
  const deps = await agencyWithTwoHotels();
  await withCapturedMessages(async () => {
    deps.pendingActions.set(maria.phone, "clock_in");
    await handleLocationForClockAction(maria.phone, maria, asLocation(HILTON), "clock_in", deps);
    assert.equal(deps.pendingActions.get(maria.phone), null);

    // And on the refusal path, so a stale request can't be replayed.
    const sam = { ...maria, phone: "61400000077", name: "Sam" };
    deps.pendingActions.set(sam.phone, "clock_in");
    await handleLocationForClockAction(sam.phone, sam, asLocation(HILTON), "clock_in", deps);
    assert.equal(deps.pendingActions.get(sam.phone), null);
  });
});
