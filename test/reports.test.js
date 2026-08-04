"use strict";

/**
 * Reporting — build order step 7 of docs/agencymodelshape.md.
 *
 * Two properties are being defended: every number that can split by lane does,
 * and a denominator of zero reports null rather than 0% — "0% fill rate" and "no
 * requests yet" look identical otherwise, and only one is a problem.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemorySiteStore } = require("../siteStore");
const { InMemoryStaffStore } = require("../store");
const { InMemoryTenantStore } = require("../tenantStore");
const { InMemoryRosterStore } = require("../rosterStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { InMemoryRequestsStore } = require("../requestsStore");
const { InMemoryOffersStore } = require("../offersStore");
const { InMemoryAvailabilityStore } = require("../availabilityStore");
const { InMemoryFreeTodayStore } = require("../freeTodayStore");
const {
  fillRate, timeToFill, lostDemand, reliabilityReport, supplyVsDemand,
  freeTodayByHour, clientHours, percentile, agencyReport,
} = require("../reports");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const iso = (s) => new Date(s).toISOString();

function buildDeps() {
  const siteStore = new InMemorySiteStore();
  siteStore.upsert("hilton-sydney", {
    tenantId: "agency", name: "Hilton Sydney", geofence: HILTON,
    billRates: { housekeeping: 45, default: 40 },
  });
  siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: HILTON });
  const tenantStore = new InMemoryTenantStore();
  tenantStore.upsert("agency", { name: "The Agency" });
  return {
    staffStore: new InMemoryStaffStore(),
    siteStore,
    tenantStore,
    requestsStore: new InMemoryRequestsStore(),
    offersStore: new InMemoryOffersStore(),
    availabilityStore: new InMemoryAvailabilityStore(),
    freeTodayStore: new InMemoryFreeTodayStore(),
    rosterStore: new InMemoryRosterStore(),
    shiftsStore: new InMemoryShiftsStore(),
  };
}

/** A request in whatever end-state the test needs. */
function req(overrides = {}) {
  return {
    requestId: overrides.requestId || `r${Math.abs(hash(JSON.stringify(overrides)))}`,
    ref: overrides.ref || "AAAA",
    tenantId: "agency",
    siteId: overrides.siteId || "hilton-sydney",
    siteName: overrides.siteName || "Hilton Sydney",
    role: "housekeeping",
    lane: overrides.lane || "planned",
    headcount: overrides.headcount != null ? overrides.headcount : 1,
    filled: overrides.filled != null ? overrides.filled : 0,
    outcome: overrides.outcome || "filled",
    createdAt: overrides.createdAt || iso("2026-08-10T09:00:00"),
    confirmedAt: overrides.confirmedAt !== undefined ? overrides.confirmedAt : iso("2026-08-10T09:00:00"),
    filledAt: overrides.filledAt !== undefined ? overrides.filledAt : iso("2026-08-10T09:30:00"),
    startsAt: overrides.startsAt || iso("2026-08-12T07:00:00"),
    endsAt: overrides.endsAt || iso("2026-08-12T15:00:00"),
  };
}
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

/* ------------------------------------------------------------- fill rate */

test("fill rate splits by lane and reports both denominators", () => {
  const rates = fillRate([
    req({ lane: "planned", headcount: 3, filled: 3, outcome: "filled" }),
    req({ lane: "planned", headcount: 4, filled: 2, outcome: "partial" }),
    req({ lane: "urgent", headcount: 1, filled: 1, outcome: "filled" }),
    req({ lane: "urgent", headcount: 2, filled: 0, outcome: "unfilled" }),
  ]);

  // A planned miss is an ops failure; an urgent miss is a supply problem. They
  // have different fixes, so they are never one number.
  assert.equal(rates.planned.requests, 2);
  assert.equal(rates.planned.fullyFilled, 1);
  assert.equal(rates.planned.pct, 50);
  // Seats: 5 of 7 planned.
  assert.equal(rates.planned.seatPct, 71.4);

  assert.equal(rates.urgent.pct, 50);
  assert.equal(rates.urgent.seatPct, 33.3);
  assert.equal(rates.total.requests, 4);
});

test("a cancelled request is neither a hit nor a miss", () => {
  const rates = fillRate([
    req({ outcome: "filled", headcount: 1, filled: 1 }),
    req({ outcome: "cancelled", headcount: 5, filled: 0 }),
  ]);
  // A hotel changing its mind must not drag the number down.
  assert.equal(rates.total.requests, 1);
  assert.equal(rates.total.pct, 100);
});

test("a request still searching isn't counted yet", () => {
  const rates = fillRate([req({ outcome: "open", headcount: 3, filled: 1 })]);
  assert.equal(rates.total.requests, 0);
  // Nothing to divide by, so null — not 0%.
  assert.equal(rates.total.pct, null);
});

test("no data reports null, never zero percent", () => {
  const rates = fillRate([]);
  for (const key of ["total", "planned", "urgent"]) {
    assert.equal(rates[key].pct, null, `${key} should be null with no data`);
    assert.equal(rates[key].seatPct, null);
  }
});

/* ---------------------------------------------------------- time to fill */

test("time to fill is measured from the hotel's confirm, not from creation", () => {
  const t = timeToFill([
    req({
      lane: "urgent", outcome: "filled", headcount: 1, filled: 1,
      createdAt: iso("2026-08-10T05:00:00"),
      // The hotel took 30 minutes to reply to the read-back. That's not our time.
      confirmedAt: iso("2026-08-10T05:30:00"),
      filledAt: iso("2026-08-10T06:04:00"),
    }),
  ]);
  assert.equal(t.urgent.medianMinutes, 34);
});

test("only fully-filled requests count toward the median", () => {
  const t = timeToFill([
    req({ lane: "urgent", outcome: "filled", filled: 1, headcount: 1, confirmedAt: iso("2026-08-10T05:00:00"), filledAt: iso("2026-08-10T05:10:00") }),
    // A partial fill has no "filled at" moment; counting it would flatter this.
    req({ lane: "urgent", outcome: "partial", filled: 1, headcount: 3, filledAt: null }),
  ]);
  assert.equal(t.urgent.n, 1);
  assert.equal(t.urgent.medianMinutes, 10);
  assert.equal(t.planned.medianMinutes, null);
});

test("percentiles are reported alongside the median", () => {
  const samples = [10, 20, 30, 40, 100];
  assert.equal(percentile(samples, 90), 100);
  assert.equal(percentile(samples, 50), 30);
});

/* ----------------------------------------------------------- lost demand */

test("lost demand is bucketed by site and by the hour the shift starts", () => {
  const lost = lostDemand([
    req({ outcome: "unfilled", headcount: 2, filled: 0, startsAt: iso("2026-08-15T06:00:00") }),
    req({ outcome: "partial", headcount: 4, filled: 1, startsAt: iso("2026-08-15T06:00:00") }),
    req({ outcome: "unfilled", headcount: 1, filled: 0, siteId: "manly-pacific", siteName: "Manly Pacific", startsAt: iso("2026-08-16T22:00:00"), lane: "urgent" }),
    // Filled requests aren't lost demand.
    req({ outcome: "filled", headcount: 3, filled: 3 }),
  ]);

  assert.equal(lost.seatsLost, 6);
  assert.equal(lost.bySite[0].siteId, "hilton-sydney");
  assert.equal(lost.bySite[0].seatsLost, 5);
  // "We can never fill 6am" is actionable in a way a daily total isn't.
  assert.equal(lost.byHour[6].seats, 5);
  assert.equal(lost.byHour[22].seats, 1);
  assert.equal(lost.byHour[13].seats, 0);
});

/* ------------------------------------------------- reliability and latency */

test("reliability ranks the fastest answerers first, unproven last", () => {
  const rows = reliabilityReport([
    { phone: "slow", name: "Slow", reliability: { offered: 10, accepted: 4, showed: 4, noShow: 0, medianResponseSec: 2400, recentResponseSecs: [2400] } },
    { phone: "new", name: "New", reliability: null },
    { phone: "fast", name: "Fast", reliability: { offered: 20, accepted: 15, showed: 14, late: 1, noShow: 1, medianResponseSec: 45, recentResponseSecs: [45] } },
  ]);

  // Your genuine top staff, and the number only exists because every offer
  // recorded when it was sent and when it was answered.
  assert.deepEqual(rows.map((r) => r.phone), ["fast", "slow", "new"]);
  assert.equal(rows[0].medianResponseSec, 45);
  assert.equal(rows[0].acceptRatePct, 75);
  assert.equal(rows[0].showRatePct, 93.3);
  // Somebody with no history reports null rather than a flattering zero.
  assert.equal(rows[2].medianResponseSec, null);
  assert.equal(rows[2].showRatePct, null);
  assert.equal(rows[2].acceptRatePct, null);
});

/* --------------------------------------------------- supply vs demand grid */

test("the grid shows a shortfall before you fail to fill it", async () => {
  const deps = buildDeps();
  const weekStart = "2026-08-10";

  // Three people say they can work Saturday night; one is already booked.
  for (const [phone, name] of [["614001", "A"], ["614002", "B"], ["614003", "C"]]) {
    deps.staffStore.upsert({ phone, tenantId: "agency", name, role: "staff", department: "housekeeping" });
    await deps.availabilityStore.submit("agency", phone, weekStart, { "2026-08-15": ["NIGHT"] }, "grid");
  }
  await deps.rosterStore.setAssignment("agency", "2026-08-15", "614003", {
    slot: "22:00-06:00", siteId: "hilton-sydney",
  });

  // Five needed that night.
  await deps.requestsStore.create({
    tenantId: "agency", siteId: "hilton-sydney", siteName: "Hilton Sydney", role: "housekeeping",
    startsAt: iso("2026-08-15T22:00:00"), endsAt: iso("2026-08-16T06:00:00"),
    headcount: 5, now: iso("2026-08-10T09:00:00"),
  });

  const grid = await supplyVsDemand("agency", weekStart, deps);
  const cell = grid.grid["2026-08-15"].NIGHT;
  assert.equal(cell.demand, 5);
  // A declaration from somebody already working is not available supply.
  assert.equal(cell.supply, 2);
  assert.equal(cell.booked, 1);
  assert.equal(cell.shortfall, 3);
  assert.equal(grid.totalShortfall, 3);
  assert.equal(grid.answered, 3);
});

test("the grid is 21 cells and counts who hasn't answered", async () => {
  const deps = buildDeps();
  deps.staffStore.upsert({ phone: "614001", tenantId: "agency", name: "Silent", role: "staff" });
  const grid = await supplyVsDemand("agency", "2026-08-10", deps);

  const dates = Object.keys(grid.grid);
  assert.equal(dates.length, 7);
  assert.equal(dates.length * Object.keys(grid.grid[dates[0]]).length, 21);
  // Silence is not supply.
  assert.equal(grid.unknown, 1);
  assert.equal(grid.answered, 0);
  assert.equal(grid.totalShortfall, 0);
});

/* ------------------------------------------------ free-today by hour */

test("the free-today histogram survives the expiry that cleans the pool", async () => {
  const deps = buildDeps();
  await deps.freeTodayStore.declare("agency", "614001", new Date("2026-08-15T05:30:00"));
  await deps.freeTodayStore.declare("agency", "614002", new Date("2026-08-15T05:45:00"));
  await deps.freeTodayStore.declare("agency", "614003", new Date("2026-08-15T09:00:00"));

  // Long after every declaration has lapsed.
  const later = new Date("2026-08-20T09:00:00");
  assert.equal((await deps.freeTodayStore.listLive("agency", later)).length, 0);

  // The history is still there, because the report counts declarations.
  const hist = await freeTodayByHour("agency", ["2026-08-15"], deps);
  assert.equal(hist.total, 3);
  assert.equal(hist.byHour[5], 2);
  assert.equal(hist.byHour[9], 1);
  // Thin at 5am Saturdays is a recruitment target, months early.
  assert.equal(hist.byHour[3], 0);
});

/* ----------------------------------------------------------- client hours */

test("client hours keep approved, awaiting and queried apart", () => {
  const base = {
    tenantId: "agency", siteId: "hilton-sydney", siteName: "Hilton Sydney",
    clockIn: { time: iso("2026-08-10T07:00:00") },
    clockOut: { time: iso("2026-08-10T15:00:00") },
    breaks: [],
  };
  const rows = clientHours([
    { ...base, shiftId: "1", approvedAt: iso("2026-08-10T16:00:00") },
    { ...base, shiftId: "2" },
    { ...base, shiftId: "3", queriedAt: iso("2026-08-10T16:00:00") },
    // A denied clock-in was never worked.
    { ...base, shiftId: "4", clockOut: { time: iso("2026-08-10T15:00:00"), denied: true } },
  ]);

  assert.equal(rows.length, 1);
  // Only the first is invoiceable, and one total would hide which is which.
  assert.equal(rows[0].approvedHours, 8);
  assert.equal(rows[0].awaitingHours, 8);
  assert.equal(rows[0].queriedHours, 8);
  assert.equal(rows[0].shifts, 3);
});

/* --------------------------------------------------------- the whole report */

test("the agency report assembles every number in one call", async () => {
  const deps = buildDeps();
  deps.staffStore.upsert({
    phone: "614001", tenantId: "agency", name: "Maria", role: "staff",
    department: "housekeeping", wageRate: 32,
    reliability: { offered: 5, accepted: 3, showed: 3, noShow: 0, medianResponseSec: 60, recentResponseSecs: [60] },
  });

  await deps.requestsStore.create({
    tenantId: "agency", siteId: "hilton-sydney", siteName: "Hilton Sydney", role: "housekeeping",
    startsAt: iso("2026-08-12T07:00:00"), endsAt: iso("2026-08-12T15:00:00"),
    headcount: 1, now: iso("2026-08-11T09:00:00"),
  });

  const { shiftId } = await deps.shiftsStore.openShift({
    tenantId: "agency", staffPhone: "614001", department: "housekeeping",
    siteId: "hilton-sydney", siteName: "Hilton Sydney", role: "housekeeping",
    payRate: 32, billRate: 45, lane: "planned",
    clockIn: { time: iso("2026-08-12T07:00:00"), withinRadius: true, distanceMeters: 3 },
  });
  await deps.shiftsStore.closeShift(shiftId, { time: iso("2026-08-12T15:00:00") });
  await deps.shiftsStore.signOffShift(shiftId, { approve: true, by: "61455000001" });

  const report = await agencyReport(
    "agency",
    { from: new Date("2026-08-01T00:00:00"), to: new Date("2026-08-20T23:59:59"), weekStart: "2026-08-10" },
    deps
  );

  for (const key of [
    "fillRate", "timeToFill", "lostDemand", "reliability", "margin",
    "clientHours", "freeToday", "supplyVsDemand",
  ]) {
    assert.ok(report[key], `the report is missing ${key}`);
  }
  assert.equal(report.reliability[0].name, "Maria");
  assert.equal(report.clientHours[0].approvedHours, 8);
  // Only approved hours reach the margin, so the figure can't be inflated by
  // hours a client hasn't agreed to.
  assert.equal(report.margin.total.shifts, 1);
  assert.equal(report.margin.byLane.planned.hours, 8);
});

test("an empty tenant reports cleanly rather than dividing by zero", async () => {
  const deps = buildDeps();
  const report = await agencyReport("agency", { weekStart: "2026-08-10" }, deps);
  assert.equal(report.fillRate.total.pct, null);
  assert.equal(report.timeToFill.urgent.medianMinutes, null);
  assert.equal(report.lostDemand.seatsLost, 0);
  assert.deepEqual(report.reliability, []);
  assert.deepEqual(report.clientHours, []);
  assert.equal(report.margin.total.marginPct, null);
});
