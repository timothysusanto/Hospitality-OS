"use strict";

/**
 * The compliance gate and the fortnight hours cap — build order step 5 of
 * docs/agencymodelshape.md.
 *
 * The claim under test is that this is a gate and not a display panel: every
 * assertion here is about somebody NOT being offered or NOT being able to accept.
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
  checkDocuments, checkHoursCap, checkPlacement, filterPlaceable, committedHours,
  compliancePipeline, expiredDocuments, lapsingDocuments, requiredFor, hoursCapOf,
  normalizeCompliance, BLOCKS,
} = require("../compliance");
const { advance, acceptOffer } = require("../dispatch");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

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
  };
}

function buildDeps() {
  const siteStore = new InMemorySiteStore();
  siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  const tenantStore = new InMemoryTenantStore();
  tenantStore.upsert("agency", { name: "The Agency", plan: "pro" });
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

const NOW = new Date("2026-08-10T09:00:00");
const SHIFT_START = new Date("2026-08-12T07:00:00");
const SHIFT_END = new Date("2026-08-12T15:00:00");

function addStaff(deps, phone, name, extra = {}) {
  const record = {
    phone, tenantId: "agency", name, role: "staff", department: "housekeeping",
    roles: ["housekeeping"], ...extra,
  };
  deps.staffStore.upsert(record);
  return record;
}

function makeRequest(deps, overrides = {}) {
  return deps.requestsStore.create({
    tenantId: "agency", siteId: "hilton-sydney", siteName: "Hilton Sydney",
    role: overrides.role || "housekeeping",
    startsAt: (overrides.startsAt || SHIFT_START).toISOString(),
    endsAt: (overrides.endsAt || SHIFT_END).toISOString(),
    headcount: overrides.headcount || 1,
    now: NOW.toISOString(),
  });
}

const iso = (d) => new Date(d).toISOString();

/* ----------------------------------------------- rule 1: expired blocks */

test("an expired document blocks, with no configuration at all", () => {
  const staff = {
    phone: "1", name: "Lapsed",
    compliance: { police: { expiresAt: iso(NOW.getTime() - 7 * DAYS) } },
  };
  // No tenant rules passed. If the agency is tracking a police check and it
  // lapsed last week, placing them is the agency's liability.
  const check = checkDocuments(staff, { role: "housekeeping", endsAt: SHIFT_END, rules: null });
  assert.equal(check.ok, false);
  assert.equal(check.reason, BLOCKS.EXPIRED);
  assert.match(check.details[0], /police expired/);
});

test("expiry is measured against the end of the shift, not now", () => {
  const staff = {
    phone: "1", name: "Lapses mid-shift",
    // Valid now, expires at noon — halfway through a 07:00–15:00 shift.
    compliance: { visa: { expiresAt: iso(new Date("2026-08-12T12:00:00")) } },
  };
  assert.equal(checkDocuments(staff, { endsAt: NOW, rules: null }).ok, true);
  // They cannot lawfully work the back half, and finding out on the day is worse.
  assert.equal(checkDocuments(staff, { endsAt: SHIFT_END, rules: null }).ok, false);
});

test("a document with no expiry never expires, and no documents is not a block", () => {
  assert.equal(checkDocuments({ compliance: { police: { ref: "ABC123" } } }, {}).ok, true);
  assert.equal(checkDocuments({ compliance: {} }, {}).ok, true);
  assert.equal(checkDocuments({}, {}).ok, true);
  assert.deepEqual(expiredDocuments({ compliance: {} }), []);
});

/* -------------------------------------- rule 2: a role's requirements */

test("a role's required document blocks only that role", () => {
  const rules = { requiredForAll: [], requiredByRole: { "food-and-beverage": ["rsa"] } };
  const staff = { phone: "1", name: "No RSA", compliance: { police: { expiresAt: iso(NOW.getTime() + 300 * DAYS) } } };

  const bar = checkDocuments(staff, { role: "food-and-beverage", endsAt: SHIFT_END, rules });
  assert.equal(bar.ok, false);
  assert.equal(bar.reason, BLOCKS.MISSING);
  assert.match(bar.details[0], /no rsa/);

  // Same person, a housekeeping shift: fine.
  assert.equal(checkDocuments(staff, { role: "housekeeping", endsAt: SHIFT_END, rules }).ok, true);
});

test("requiredForAll applies to every role", () => {
  const rules = { requiredForAll: ["police"], requiredByRole: {} };
  assert.deepEqual(requiredFor(rules, "housekeeping"), ["police"]);
  assert.deepEqual(requiredFor(rules, "porter"), ["police"]);
  assert.deepEqual(requiredFor(null, "porter"), []);

  const staff = { phone: "1", name: "No check", compliance: {} };
  assert.equal(checkDocuments(staff, { role: "porter", endsAt: SHIFT_END, rules }).reason, BLOCKS.MISSING);
});

test("rule 2 being unconfigured never stops rule 1 firing", () => {
  // The two rules are separate precisely so this holds.
  const staff = { phone: "1", name: "Lapsed", compliance: { rsa: { expiresAt: iso(NOW.getTime() - DAYS) } } };
  for (const rules of [null, undefined, {}, { requiredByRole: {} }]) {
    assert.equal(checkDocuments(staff, { role: "housekeeping", endsAt: SHIFT_END, rules }).reason, BLOCKS.EXPIRED);
  }
});

/* ------------------------------------------------- the fortnight hours cap */

test("hours are counted across all sites, from shifts and future assignments", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Capped");
  deps.siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: HILTON });

  // A worked shift at one hotel.
  await deps.shiftsStore.openShift({
    tenantId: "agency", staffPhone: staff.phone, department: "housekeeping",
    siteId: "hilton-sydney", siteName: "Hilton Sydney",
    clockIn: { time: iso(new Date("2026-08-04T07:00:00")), withinRadius: true, distanceMeters: 3 },
  });
  const open = await deps.shiftsStore.findOpenShift(staff.phone);
  await deps.shiftsStore.closeShift(open.shiftId, { time: iso(new Date("2026-08-04T15:00:00")) });

  // A future booking at the other — this is where an accepted offer lives.
  await deps.rosterStore.setAssignment("agency", "2026-08-11", staff.phone, {
    slot: "07:00-15:00", siteId: "manly-pacific",
  });

  // The exposure is the agency's, carried across every client.
  const total = await committedHours("agency", staff.phone, new Date("2026-08-12T15:00:00"), deps);
  assert.equal(total, 16);
});

test("a shift and its own roster assignment are not counted twice", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Worked it");

  await deps.rosterStore.setAssignment("agency", "2026-08-11", staff.phone, {
    slot: "07:00-15:00", siteId: "hilton-sydney",
  });
  await deps.shiftsStore.openShift({
    tenantId: "agency", staffPhone: staff.phone, department: "housekeeping",
    siteId: "hilton-sydney", siteName: "Hilton Sydney",
    clockIn: { time: iso(new Date("2026-08-11T07:00:00")), withinRadius: true, distanceMeters: 3 },
  });
  const open = await deps.shiftsStore.findOpenShift(staff.phone);
  await deps.shiftsStore.closeShift(open.shiftId, { time: iso(new Date("2026-08-11T15:00:00")) });

  // One shift, eight hours — not sixteen.
  assert.equal(await committedHours("agency", staff.phone, new Date("2026-08-12T15:00:00"), deps), 8);
});

test("the cap blocks the shift that would break it, not the one before", async () => {
  const deps = buildDeps();
  // A student visa: 24 hours a fortnight.
  const staff = addStaff(deps, "614001", "Student", {
    compliance: { visa: { type: "student", expiresAt: iso(NOW.getTime() + 300 * DAYS), hoursCapPerFortnight: 24 } },
  });
  assert.equal(hoursCapOf(staff), 24);

  const request = await makeRequest(deps);

  // 16 hours committed + 8 for this shift = 24. Exactly at the cap is allowed.
  for (const dateIso of ["2026-08-10", "2026-08-11"]) {
    await deps.rosterStore.setAssignment("agency", dateIso, staff.phone, {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });
  }
  assert.equal((await checkHoursCap(staff, request, deps)).ok, true);

  // One more booking and this shift would take them to 32.
  await deps.rosterStore.setAssignment("agency", "2026-08-13", staff.phone, {
    slot: "07:00-15:00", siteId: "hilton-sydney",
  });
  const blocked = await checkHoursCap(staff, request, deps);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, BLOCKS.HOURS_CAP);
  assert.equal(blocked.cap, 24);
});

test("somebody with no cap is never blocked on hours", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Uncapped");
  const request = await makeRequest(deps);
  for (const dateIso of ["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14"]) {
    await deps.rosterStore.setAssignment("agency", dateIso, staff.phone, {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });
  }
  assert.equal(hoursCapOf(staff), null);
  assert.equal((await checkHoursCap(staff, request, deps)).ok, true);
});

test("no order of accepting shifts can get somebody over the cap", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Student", {
    compliance: { visa: { expiresAt: iso(NOW.getTime() + 300 * DAYS), hoursCapPerFortnight: 24 } },
  });

  // 16h already booked on the 10th and 11th.
  for (const dateIso of ["2026-08-10", "2026-08-11"]) {
    await deps.rosterStore.setAssignment("agency", dateIso, staff.phone, {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });
  }

  // The 13th brings them to exactly 24 — allowed.
  const thirteenth = await makeRequest(deps, {
    startsAt: new Date("2026-08-13T07:00:00"), endsAt: new Date("2026-08-13T15:00:00"),
  });
  assert.equal((await checkHoursCap(staff, thirteenth, deps)).ok, true);
  await deps.rosterStore.setAssignment("agency", "2026-08-13", staff.phone, {
    slot: "07:00-15:00", siteId: "hilton-sydney",
  });

  // Now the 12th. A window ending at the 12th sees only 16h and would allow it —
  // four days, 32 hours, cap intact. Checking every window containing the shift
  // is what closes that.
  const twelfth = await makeRequest(deps);
  const check = await checkHoursCap(staff, twelfth, deps);
  assert.equal(check.ok, false, "the straddle loophole must be closed");
  assert.equal(check.reason, BLOCKS.HOURS_CAP);
  assert.equal(check.worst, 32);
});

test("the worst-window search looks both ways from the shift", () => {
  const { worstWindowTotal } = require("../compliance");
  // 8h a day for four consecutive days, and the shift is the second of them.
  const byDate = new Map([
    ["2026-08-10", 8], ["2026-08-11", 8], ["2026-08-12", 8], ["2026-08-13", 8],
  ]);
  assert.equal(worstWindowTotal(byDate, "2026-08-11"), 32);

  // A day 20 days later is in no window containing the 11th.
  byDate.set("2026-08-31", 8);
  assert.equal(worstWindowTotal(byDate, "2026-08-11"), 32);
});

test("the fortnight is rolling, so old hours drop out of it", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Student", {
    compliance: { visa: { expiresAt: iso(NOW.getTime() + 300 * DAYS), hoursCapPerFortnight: 24 } },
  });

  // Three weeks before the shift — outside the 14-day window ending at its end.
  await deps.rosterStore.setAssignment("agency", "2026-07-20", staff.phone, {
    slot: "07:00-15:00", siteId: "hilton-sydney",
  });
  assert.equal(await committedHours("agency", staff.phone, SHIFT_END, deps), 0);
});

/* -------------------------------------------- the gate in the blast engine */

test("a blocked person is not offered the shift at all", async () => {
  const deps = buildDeps();
  const clear = addStaff(deps, "614001", "Clear");
  addStaff(deps, "614002", "Lapsed", {
    compliance: { police: { expiresAt: iso(NOW.getTime() - DAYS) } },
  });
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps);
    await advance(request, deps, {}, NOW);

    const offered = [...(await deps.offersStore.phonesOfferedFor(request.requestId))];
    assert.deepEqual(offered, [clear.phone]);
    assert.equal(msg.to("614002").length, 0, "an expired document means no message at all");
  } finally {
    msg.restore();
  }
});

test("the gate applies to the urgent lane's everyone wave too", async () => {
  const deps = buildDeps();
  addStaff(deps, "614002", "Lapsed", {
    compliance: { visa: { expiresAt: iso(NOW.getTime() - DAYS) } },
  });
  const msg = captureMessages();
  try {
    // Urgent, and the only candidate is blocked. Being short-staffed is never a
    // reason to place somebody the agency isn't allowed to place.
    const request = await makeRequest(deps, {
      startsAt: new Date(NOW.getTime() + 2 * HOURS),
      endsAt: new Date(NOW.getTime() + 10 * HOURS),
    });
    await advance(request, deps, {}, NOW);

    assert.equal((await deps.offersStore.listByRequest(request.requestId)).length, 0);
    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.outcome, "unfilled");
  } finally {
    msg.restore();
  }
});

test("filterPlaceable reports who it removed and why", async () => {
  const deps = buildDeps();
  const clear = addStaff(deps, "614001", "Clear");
  addStaff(deps, "614002", "Lapsed", { compliance: { rsa: { expiresAt: iso(NOW.getTime() - DAYS) } } });
  const request = await makeRequest(deps);

  const { allowed, blocked } = await filterPlaceable(
    await deps.staffStore.listByTenant("agency"), request, deps, null
  );
  assert.deepEqual(allowed.map((s) => s.phone), [clear.phone]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, BLOCKS.EXPIRED);
});

/* ----------------------------------------- re-checked at the moment of accept */

test("a document lapsing inside the accept window blocks the accept", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Lapses soon", {
    compliance: { police: { expiresAt: iso(NOW.getTime() + 60 * 1000) } },
  });
  const msg = captureMessages();
  try {
    // A shift ending before the document lapses: they're offered it.
    const soon = await makeRequest(deps, {
      startsAt: new Date(NOW.getTime() + 10 * 1000),
      endsAt: new Date(NOW.getTime() + 30 * 1000),
    });
    await advance(soon, deps, {}, NOW);
    const offer = await deps.offersStore.findPendingFor(staff.phone, soon.requestId);
    assert.ok(offer, "they were offered it while compliant");

    // The document lapses before they reply. A planned lane's window is two
    // hours; this is exactly the gap the second check exists for.
    deps.staffStore.upsert({ ...staff, compliance: { police: { expiresAt: iso(NOW.getTime() - 1000) } } });
    const lapsed = await deps.staffStore.findByPhone(staff.phone);

    const result = await acceptOffer(offer, lapsed, deps, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, BLOCKS.EXPIRED);
    assert.match(result.message, /expired/);

    // And crucially: no seat was taken, even briefly.
    const after = await deps.requestsStore.findById(soon.requestId);
    assert.equal(after.filled, 0);
    // Nor was a roster assignment written.
    assert.equal(await deps.rosterStore.findAssignment("agency", "2026-08-10", staff.phone), null);
  } finally {
    msg.restore();
  }
});

test("hours used up between blast and reply block the accept", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Student", {
    compliance: { visa: { expiresAt: iso(NOW.getTime() + 300 * DAYS), hoursCapPerFortnight: 16 } },
  });
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps);
    await advance(request, deps, {}, NOW);
    const offer = await deps.offersStore.findPendingFor(staff.phone, request.requestId);
    assert.ok(offer);

    // They accept two other shifts elsewhere first, using up the fortnight.
    for (const dateIso of ["2026-08-10", "2026-08-11"]) {
      await deps.rosterStore.setAssignment("agency", dateIso, staff.phone, {
        slot: "07:00-15:00", siteId: "hilton-sydney",
      });
    }

    const result = await acceptOffer(offer, await deps.staffStore.findByPhone(staff.phone), deps, {});
    assert.equal(result.ok, false);
    assert.equal(result.reason, BLOCKS.HOURS_CAP);
    assert.equal((await deps.requestsStore.findById(request.requestId)).filled, 0);
  } finally {
    msg.restore();
  }
});

/* ------------------------------------------------------- the 30-day pipeline */

test("the pipeline names who lapses and how many placements it endangers", async () => {
  const deps = buildDeps();
  addStaff(deps, "614001", "Clear", {
    compliance: { police: { expiresAt: iso(NOW.getTime() + 300 * DAYS) } },
  });
  const lapsing = addStaff(deps, "614002", "Lapsing", {
    compliance: { rsa: { expiresAt: iso(new Date("2026-08-20T00:00:00")) } },
  });
  const blocked = addStaff(deps, "614003", "Blocked", {
    compliance: { visa: { expiresAt: iso(NOW.getTime() - DAYS) } },
  });

  // Two bookings after the RSA lapses, one before.
  await deps.rosterStore.setAssignment("agency", "2026-08-18", lapsing.phone, { slot: "AM", siteId: "hilton-sydney" });
  await deps.rosterStore.setAssignment("agency", "2026-08-25", lapsing.phone, { slot: "AM", siteId: "hilton-sydney" });
  await deps.rosterStore.setAssignment("agency", "2026-08-26", lapsing.phone, { slot: "PM", siteId: "hilton-sydney" });

  const rows = await compliancePipeline("agency", deps, NOW, 30);
  // Somebody already blocked comes first — that's today's problem.
  assert.equal(rows[0].phone, blocked.phone);
  assert.equal(rows[0].blockedNow, true);

  const lapsingRow = rows.find((r) => r.phone === lapsing.phone);
  assert.equal(lapsingRow.blockedNow, false);
  // The 18th is before the lapse, so only two placements are at risk.
  assert.equal(lapsingRow.endangeredPlacements, 2);
  assert.equal(lapsingRow.documents[0].key, "rsa");

  // Nobody clear appears at all — this is a worklist, not a roster.
  assert.equal(rows.some((r) => r.phone === "614001"), false);
});

test("lapsingDocuments only looks inside the horizon", () => {
  const staff = {
    compliance: {
      soon: { expiresAt: iso(NOW.getTime() + 10 * DAYS) },
      later: { expiresAt: iso(NOW.getTime() + 90 * DAYS) },
      gone: { expiresAt: iso(NOW.getTime() - DAYS) },
    },
  };
  const lapsing = lapsingDocuments(staff, NOW, 30).map((d) => d.key);
  assert.deepEqual(lapsing, ["soon"]);
  assert.deepEqual(expiredDocuments(staff, NOW).map((d) => d.key), ["gone"]);
});

/* ----------------------------------------------------------- normalisation */

test("compliance input is cleaned, and an empty document is not stored", () => {
  const clean = normalizeCompliance({
    RSA: { expiresAt: "2027-01-31", ref: " 12345 " },
    visa: { expiresAt: "2027-06-30", hoursCapPerFortnight: "48", type: "student" },
    junk: { note: "nothing useful" },
    alsoJunk: "not an object",
    "bad key!!": { expiresAt: "2027-01-01" },
  });

  assert.ok(clean.rsa.expiresAt.startsWith("2027-01-31"));
  assert.equal(clean.rsa.ref, "12345");
  assert.equal(clean.visa.hoursCapPerFortnight, 48);
  assert.equal(clean.visa.type, "student");
  // A document with nothing on it is not a document — storing {} would look
  // like a held document and satisfy a role requirement it shouldn't.
  assert.equal(clean.junk, undefined);
  assert.equal(clean.alsoJunk, undefined);
  assert.ok(clean.badkey, "the key is sanitised rather than dropped");
});

test("checkPlacement runs both halves, documents first", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "614001", "Both problems", {
    compliance: { visa: { expiresAt: iso(NOW.getTime() - DAYS), hoursCapPerFortnight: 1 } },
  });
  const request = await makeRequest(deps);
  const check = await checkPlacement(staff, request, deps, null);
  // The document problem is the one to report — renewing it is the fix, and
  // telling somebody about an hours cap they can't reach is noise.
  assert.equal(check.reason, BLOCKS.EXPIRED);
});
