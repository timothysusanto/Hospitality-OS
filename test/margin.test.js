"use strict";

/**
 * Bill rates, timesheet sign-off and margin — build order step 6 of
 * docs/agencymodelshape.md.
 *
 * Two things are being defended here: that on-costs are applied in the right
 * order (getting it wrong understates every shift), and that a client is never
 * shown a pay rate or a margin.
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
const { InMemoryPendingActions } = require("../pendingActions");
const {
  DEFAULT_ON_COSTS, normalizeOnCosts, costMultiplier, billRateFor,
  workedHours, shiftMargin, summarize, clientFacingLine,
} = require("../margin");
const { sweepSignoffs, handleSignoffReply, groupForSignoff } = require("../signoffHandler");
const { handleClientMessage } = require("../intakeHandler");
const { handleLocationForClockAction } = require("../clockHandler");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const MANAGER = "61455000001";

process.env.WHATSAPP_PHONE_NUMBER_ID = "test-number";
process.env.WHATSAPP_TOKEN = "test-token";

function captureMessages() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    sent.push({ to: payload.to, body: payload.text ? payload.text.body : "(interactive)" });
    return { ok: true, json: async () => ({}) };
  };
  return {
    sent,
    restore() { globalThis.fetch = realFetch; },
    to(phone) { return sent.filter((m) => m.to === phone); },
    lastTo(phone) { return this.to(phone).at(-1); },
    all() { return sent.map((m) => m.body).join("\n"); },
  };
}

function buildDeps() {
  const siteStore = new InMemorySiteStore();
  siteStore.upsert("hilton-sydney", {
    tenantId: "agency", name: "Hilton Sydney", geofence: HILTON,
    requesters: [{ phone: MANAGER, name: "Dana" }],
    billRates: { housekeeping: 45, default: 40 },
  });
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
    pendingActions: new InMemoryPendingActions(),
  };
}

const iso = (s) => new Date(s).toISOString();

/** A finished shift, priced. */
async function workShift(deps, { phone, name, start, end, payRate = 32, billRate = 45, lane = "planned", breaks = [] }) {
  deps.staffStore.upsert({
    phone, tenantId: "agency", name, role: "staff", department: "housekeeping",
    roles: ["housekeeping"], wageRate: payRate,
  });
  const { shiftId } = await deps.shiftsStore.openShift({
    tenantId: "agency", staffPhone: phone, department: "housekeeping",
    siteId: "hilton-sydney", siteName: "Hilton Sydney",
    role: "housekeeping", payRate, billRate, lane,
    clockIn: { time: iso(start), withinRadius: true, distanceMeters: 4 },
  });
  for (const b of breaks) {
    await deps.shiftsStore.startBreak(shiftId, iso(b.start));
    await deps.shiftsStore.endBreak(shiftId, iso(b.end));
  }
  await deps.shiftsStore.closeShift(shiftId, { time: iso(end), withinRadius: true, distanceMeters: 6 });
  const all = await deps.shiftsStore.listByTenant("agency");
  return all.find((s) => s.shiftId === shiftId);
}

/* --------------------------------------------------------------- on-costs */

test("on-costs are levied on the loaded wage, not the base", () => {
  // Casual loading is part of the wage, so super, payroll tax and workers' comp
  // apply on top of the loaded figure. Computing them off the base understates
  // the cost of every shift.
  const onCosts = { casualLoadingPct: 25, superPct: 12, payrollTaxPct: 5, workersCompPct: 3 };
  const correct = 1.25 * 1.2;      // loaded, then 20% on top
  const naive = 1 + 0.25 + 0.2;    // everything off the base
  assert.equal(Math.round(costMultiplier(onCosts) * 10000) / 10000, Math.round(correct * 10000) / 10000);
  assert.ok(costMultiplier(onCosts) > naive, "the correct order costs more than the naive one");
});

test("on-costs default rather than silently becoming zero", () => {
  assert.deepEqual(normalizeOnCosts(null), { ...DEFAULT_ON_COSTS });
  // A nonsense value falls back to the default instead of dropping the on-cost.
  assert.equal(normalizeOnCosts({ superPct: "banana" }).superPct, DEFAULT_ON_COSTS.superPct);
  assert.equal(normalizeOnCosts({ superPct: -5 }).superPct, DEFAULT_ON_COSTS.superPct);
  assert.equal(normalizeOnCosts({ superPct: 0 }).superPct, 0, "zero is a real answer");
});

/* ------------------------------------------------------------- bill rates */

test("a role's rate wins, then default, then unbillable", () => {
  const site = { billRates: { housekeeping: 45, default: 40 } };
  assert.equal(billRateFor(site, "housekeeping"), 45);
  assert.equal(billRateFor(site, "porter"), 40);
  assert.equal(billRateFor({ billRates: { housekeeping: 45 } }, "porter"), null);
  assert.equal(billRateFor({}, "housekeeping"), null);
});

test("an unpriced shift is unbillable, not billed at zero", async () => {
  const deps = buildDeps();
  const shift = await workShift(deps, {
    phone: "614001", name: "Maria",
    start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    billRate: null,
  });
  const m = shiftMargin(shift, null);
  assert.equal(m.billable, false);
  assert.equal(m.bill, 0);
  // A margin report has to be able to say "this one has no rate card" rather
  // than showing it as a loss-making placement.
  assert.ok(m.margin < 0);
  assert.equal(m.marginPct, null);
});

/* ----------------------------------------------------------------- hours */

test("hours are amendment-aware and net of breaks", async () => {
  const deps = buildDeps();
  const shift = await workShift(deps, {
    phone: "614001", name: "Maria",
    start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    breaks: [{ start: "2026-08-10T11:00:00", end: "2026-08-10T11:30:00" }],
  });
  assert.equal(workedHours(shift), 7.5);

  // An amendment overrides both the times and the break.
  const amended = { ...shift, amended: { clockInTime: iso("2026-08-10T07:00:00"), clockOutTime: iso("2026-08-10T14:00:00"), breakMinutes: 60 } };
  assert.equal(workedHours(amended), 6);

  // A shift still open has no hours yet.
  assert.equal(workedHours({ clockIn: { time: iso("2026-08-10T07:00:00") }, clockOut: null }), 0);
});

/* ---------------------------------------------------------------- margin */

test("margin is bill less pay less on-costs", async () => {
  const deps = buildDeps();
  const shift = await workShift(deps, {
    phone: "614001", name: "Maria",
    start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    payRate: 32, billRate: 45,
  });
  const onCosts = { casualLoadingPct: 25, superPct: 12, payrollTaxPct: 5, workersCompPct: 3 };
  const m = shiftMargin(shift, onCosts);

  assert.equal(m.hours, 8);
  assert.equal(m.pay, 256);            // 8 × 32
  assert.equal(m.bill, 360);           // 8 × 45
  assert.equal(m.cost, 384);           // 256 × 1.25 × 1.20
  // A 40% gross mark-up is a loss once on-costs are counted. This is exactly the
  // number the design note warns gets missed.
  assert.ok(m.margin < 0, `expected a loss, got ${m.margin}`);
});

test("the two lanes are reported apart, never blended", async () => {
  const deps = buildDeps();
  const planned = await workShift(deps, {
    phone: "614001", name: "Maria", lane: "planned",
    start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00", payRate: 30, billRate: 50,
  });
  const urgent = await workShift(deps, {
    phone: "614002", name: "Ahmed", lane: "urgent",
    start: "2026-08-11T22:00:00", end: "2026-08-12T06:00:00", payRate: 45, billRate: 55,
  });

  const { total, byLane } = summarize([planned, urgent], DEFAULT_ON_COSTS);
  assert.equal(total.shifts, 2);
  assert.equal(total.hours, 16);
  assert.equal(byLane.planned.shifts, 1);
  assert.equal(byLane.urgent.shifts, 1);
  // Urgent skews to nights and weekends, so its margin is the one worth watching.
  assert.ok(byLane.urgent.margin < byLane.planned.margin);
  assert.equal(Math.round((byLane.planned.margin + byLane.urgent.margin) * 100) / 100, total.margin);
});

test("unbillable and unpriced shifts are counted, not hidden", async () => {
  const deps = buildDeps();
  const noBill = await workShift(deps, {
    phone: "614001", name: "Maria", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00", billRate: null,
  });
  const noPay = await workShift(deps, {
    phone: "614002", name: "Ahmed", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00", payRate: null,
  });
  const { total } = summarize([noBill, noPay], DEFAULT_ON_COSTS);
  assert.equal(total.unbillable, 1);
  assert.equal(total.noPayRate, 1);

  // An absent rate is null, never a real rate of zero: an unbillable shift would
  // look like a loss and an unpriced one like pure profit.
  assert.equal(noPay.payRate, null);
  assert.equal(noBill.billRate, null);
  assert.equal(shiftMargin(noPay, DEFAULT_ON_COSTS).marginPct, 100);
  assert.equal(shiftMargin(noPay, DEFAULT_ON_COSTS).complete, false);
  assert.equal(shiftMargin(noBill, DEFAULT_ON_COSTS).complete, false);
});

/* ------------------------------------ pay rates are never visible to the site */

test("nothing a client is shown carries a rate or a margin", async () => {
  const deps = buildDeps();
  const shift = await workShift(deps, {
    phone: "614001", name: "Maria",
    start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00", payRate: 32, billRate: 45,
  });

  const line = clientFacingLine(shift, "Maria");
  assert.match(line, /Maria — 8\.0 hrs/);
  // If a hotel negotiates directly with a casual the margin model breaks
  // quietly, so a client message must not carry either number.
  for (const forbidden of ["32", "45", "margin", "rate", "$"]) {
    assert.ok(!line.toLowerCase().includes(String(forbidden).toLowerCase()), `client line leaked "${forbidden}": ${line}`);
  }
});

test("the sign-off request sent to a client carries hours only", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    await workShift(deps, {
      phone: "614001", name: "Maria",
      start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00", payRate: 32, billRate: 45,
    });
    // An hour after clock-out, past the settle window.
    await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T16:00:00"));

    const body = msg.lastTo(MANAGER).body;
    assert.match(body, /8\.0 hrs total/);
    assert.match(body, /Maria/);
    for (const forbidden of ["32", "45", "$", "margin", "cost"]) {
      assert.ok(!body.toLowerCase().includes(String(forbidden).toLowerCase()), `signoff request leaked "${forbidden}"`);
    }
  } finally {
    msg.restore();
  }
});

/* --------------------------------------------------------------- sign-off */

test("the sign-off request waits for stragglers, then asks once", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    await workShift(deps, {
      phone: "614001", name: "Maria", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    });

    // Ten minutes after clock-out: still inside the settle window, in case
    // somebody else on the same shift hasn't clocked out yet.
    await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:10:00"));
    assert.equal(msg.to(MANAGER).length, 0);

    // Half an hour later: asked.
    assert.equal((await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"))).groups, 1);
    assert.equal(msg.to(MANAGER).length, 1);

    // The tick runs every 30 seconds and must not ask again.
    for (const t of ["15:41", "16:30", "20:00"]) {
      await sweepSignoffs("agency", deps, {}, new Date(`2026-08-10T${t}:00`));
    }
    assert.equal(msg.to(MANAGER).length, 1);
  } finally {
    msg.restore();
  }
});

test("one message covers the whole shift, not one per person", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    for (const [phone, name] of [["614001", "Maria"], ["614002", "Ahmed"], ["614003", "Jo"]]) {
      await workShift(deps, { phone, name, start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00" });
    }
    await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"));

    assert.equal(msg.to(MANAGER).length, 1, "a supervisor gets one message, not three");
    const body = msg.lastTo(MANAGER).body;
    for (const name of ["Maria", "Ahmed", "Jo"]) assert.match(body, new RegExp(name));
    assert.match(body, /24\.0 hrs total/);
  } finally {
    msg.restore();
  }
});

test("APPROVE signs off the group and names the invoice date", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    for (const [phone, name] of [["614001", "Maria"], ["614002", "Ahmed"]]) {
      await workShift(deps, { phone, name, start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00" });
    }
    await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"));

    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleSignoffReply(MANAGER, sites, "approve", deps, {}, new Date("2026-08-10T16:00:00"));

    assert.match(msg.lastTo(MANAGER).body, /Signed off — 16\.0 hrs/);
    assert.match(msg.lastTo(MANAGER).body, /10 Aug invoice/);

    const shifts = await deps.shiftsStore.listByTenant("agency");
    assert.ok(shifts.every((s) => s.approvedAt), "the whole group is approved");
    assert.ok(shifts.every((s) => s.approvedBy === MANAGER));
  } finally {
    msg.restore();
  }
});

test("QUERY holds the hours off the invoice and keeps the note", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    await workShift(deps, {
      phone: "614001", name: "Maria", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    });
    await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"));

    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleSignoffReply(MANAGER, sites, "query she left at 2", deps, {}, new Date("2026-08-10T16:00:00"));

    assert.match(msg.lastTo(MANAGER).body, /flagged Maria for review/);
    assert.match(msg.lastTo(MANAGER).body, /held it off your invoice/);

    const shift = (await deps.shiftsStore.listByTenant("agency"))[0];
    assert.ok(shift.queriedAt);
    assert.equal(shift.approvedAt, null);
    assert.match(shift.queryNote, /she left at 2/);
  } finally {
    msg.restore();
  }
});

test("a second APPROVE is a no-op, not a second audit entry", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    await workShift(deps, {
      phone: "614001", name: "Maria", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    });
    await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"));
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleSignoffReply(MANAGER, sites, "approve", deps, {}, new Date("2026-08-10T16:00:00"));
    const first = (await deps.shiftsStore.listByTenant("agency"))[0].approvedAt;

    await handleSignoffReply(MANAGER, sites, "approve", deps, {}, new Date("2026-08-10T17:00:00"));
    assert.equal((await deps.shiftsStore.listByTenant("agency"))[0].approvedAt, first);
    assert.match(msg.lastTo(MANAGER).body, /Nothing waiting for your sign-off/);
  } finally {
    msg.restore();
  }
});

test("a flagged clock-in is never sent for client sign-off", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const { shiftId } = await deps.shiftsStore.openShift({
      tenantId: "agency", staffPhone: "614001", department: "housekeeping",
      siteId: "hilton-sydney", siteName: "Hilton Sydney", role: "housekeeping",
      payRate: 32, billRate: 45,
      clockIn: { time: iso("2026-08-10T07:00:00"), withinRadius: false, distanceMeters: 900, flaggedForReview: true },
    });
    await deps.shiftsStore.closeShift(shiftId, { time: iso("2026-08-10T15:00:00") });

    // An out-of-radius clock-in is a manager's call first — asking the client to
    // approve it would be asking them to rule on our own exception.
    assert.equal((await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"))).groups, 0);
    assert.equal(msg.to(MANAGER).length, 0);
  } finally {
    msg.restore();
  }
});

test("approve does not shadow confirming an order", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    const now = new Date("2026-08-10T09:00:00");
    await handleClientMessage(MANAGER, sites, "3 housekeepers tomorrow 7am", deps, {}, now);
    // "ok" with a draft on the table means confirm the order, not approve a
    // timesheet — a shift they haven't been asked about yet.
    await handleClientMessage(MANAGER, sites, "ok", deps, {}, now);
    assert.match(msg.lastTo(MANAGER).body, /Confirmed/);
  } finally {
    msg.restore();
  }
});

test("shifts with no requester to ask are left for the operator", async () => {
  const deps = buildDeps();
  await deps.siteStore.setRequesters("hilton-sydney", []);
  const msg = captureMessages();
  try {
    await workShift(deps, {
      phone: "614001", name: "Maria", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00",
    });
    assert.equal((await sweepSignoffs("agency", deps, {}, new Date("2026-08-10T15:40:00"))).groups, 0);
    // Not asked, not approved — it shows up in the dashboard's awaiting-signoff
    // count instead of being silently invoiced.
    const shift = (await deps.shiftsStore.listByTenant("agency"))[0];
    assert.equal(shift.signoffAskedAt, null);
    assert.equal(shift.approvedAt, null);
  } finally {
    msg.restore();
  }
});

/* ------------------------------------------- rates are stamped at clock-in */

test("clock-in stamps the role and both rates from today's rate card", async () => {
  const deps = buildDeps();
  deps.staffStore.upsert({
    phone: "614001", tenantId: "agency", name: "Maria", role: "staff",
    department: "housekeeping", roles: ["housekeeping"], wageRate: 33.5,
  });
  await deps.rosterStore.setAssignment("agency", localToday(), "614001", {
    slot: "07:00-15:00", siteId: "hilton-sydney", role: "housekeeping",
  });

  const msg = captureMessages();
  try {
    const staff = await deps.staffStore.findByPhone("614001");
    await handleLocationForClockAction(
      "614001", staff, { latitude: HILTON.lat, longitude: HILTON.lng }, "clock_in", deps, {}
    );
    const open = await deps.shiftsStore.findOpenShift("614001");
    assert.equal(open.role, "housekeeping");
    assert.equal(open.payRate, 33.5);
    assert.equal(open.billRate, 45);

    // Changing the rate card afterwards must not reprice the shift.
    await deps.siteStore.upsert("hilton-sydney", { billRates: { housekeeping: 99 } });
    const again = await deps.shiftsStore.findOpenShift("614001");
    assert.equal(again.billRate, 45, "a stamped rate never moves");
  } finally {
    msg.restore();
  }
});

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

test("groupForSignoff buckets by site and day", async () => {
  const deps = buildDeps();
  const a = await workShift(deps, { phone: "614001", name: "A", start: "2026-08-10T07:00:00", end: "2026-08-10T15:00:00" });
  const b = await workShift(deps, { phone: "614002", name: "B", start: "2026-08-10T14:00:00", end: "2026-08-10T22:00:00" });
  const c = await workShift(deps, { phone: "614003", name: "C", start: "2026-08-11T07:00:00", end: "2026-08-11T15:00:00" });

  const groups = groupForSignoff([a, b, c], new Date("2026-08-11T20:00:00"));
  assert.equal(groups.size, 2, "two days, two groups");
  assert.equal(groups.get("hilton-sydney|2026-08-10").length, 2);
});
