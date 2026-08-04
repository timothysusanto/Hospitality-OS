"use strict";

/**
 * The blast engine — build order step 2 of docs/agencymodelshape.md.
 *
 * Time is injected everywhere (`tick(..., now)`), so wave progression and expiry
 * are tested by moving a fake clock rather than by sleeping. A test suite that
 * waits two hours for a planned wave to expire is a test suite nobody runs.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemorySiteStore } = require("../siteStore");
const { InMemoryRosterStore, mondayOf, slotWindow, windowsOverlap } = require("../rosterStore");
const { InMemoryTenantStore } = require("../tenantStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { InMemoryStaffStore } = require("../store");
const { InMemoryRequestsStore: Requests, laneFor, seatsRemaining } = require("../requestsStore");
const { InMemoryOffersStore: Offers, responseSeconds } = require("../offersStore");
const { rankStaff, withOfferAnswered, normalizeReliability, medianOf } = require("../reliability");
const { tick, advance, acceptOffer, declineOffer, sweepNoShows, bookedPhones, WAVE_PLANS } = require("../dispatch");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };

process.env.WHATSAPP_PHONE_NUMBER_ID = "test-number";
process.env.WHATSAPP_TOKEN = "test-token";

/** Captures outbound WhatsApp messages as {to, body} instead of sending them. */
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
  };
}

function buildDeps() {
  const staffStore = new InMemoryStaffStore();
  const siteStore = new InMemorySiteStore();
  siteStore.upsert("hilton-sydney", { tenantId: "agency", name: "Hilton Sydney", geofence: HILTON });
  return {
    staffStore,
    siteStore,
    tenantStore: new InMemoryTenantStore(),
    requestsStore: new Requests(),
    offersStore: new Offers(),
    rosterStore: new InMemoryRosterStore(),
    shiftsStore: new InMemoryShiftsStore(),
  };
}

/** A pool of housekeepers with distinguishable reliability histories. */
function seedPool(deps, count = 4) {
  const phones = [];
  for (let i = 1; i <= count; i++) {
    const phone = `6140000010${i}`;
    deps.staffStore.upsert({
      phone,
      tenantId: "agency",
      name: `Casual ${i}`,
      role: "staff",
      department: "housekeeping",
    });
    phones.push(phone);
  }
  return phones;
}

const HOURS = 60 * 60 * 1000;
const MINUTES = 60 * 1000;

function makeRequest(deps, overrides = {}) {
  const now = overrides.now || new Date("2026-08-10T09:00:00");
  const startsAt = overrides.startsAt || new Date(now.getTime() + 48 * HOURS);
  const endsAt = overrides.endsAt || new Date(startsAt.getTime() + 8 * HOURS);
  return deps.requestsStore.create({
    tenantId: "agency",
    siteId: "hilton-sydney",
    siteName: "Hilton Sydney",
    role: "housekeeping",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    headcount: overrides.headcount || 1,
    requestedBy: overrides.requestedBy,
    lane: overrides.lane,
    // State the clock, so the derived lane matches the clock the rest of the
    // test uses rather than the real one.
    now: now.toISOString(),
  });
}

/* ------------------------------------------------------------------- lanes */

test("the lane is derived from the start time, never declared", () => {
  const now = new Date("2026-08-10T09:00:00Z");
  assert.equal(laneFor(new Date(now.getTime() + 48 * HOURS), now), "planned");
  assert.equal(laneFor(new Date(now.getTime() + 13 * HOURS), now), "planned");
  // Twelve hours is the line.
  assert.equal(laneFor(new Date(now.getTime() + 11.9 * HOURS), now), "urgent");
  assert.equal(laneFor(new Date(now.getTime() + 30 * MINUTES), now), "urgent");
  // A shift that already started is as urgent as it gets.
  assert.equal(laneFor(new Date(now.getTime() - HOURS), now), "urgent");
});

test("the two lanes are the same engine with different dials", () => {
  assert.equal(WAVE_PLANS.planned.length, 2);
  assert.equal(WAVE_PLANS.urgent.length, 3);
  // Straight from the design note's table: 2 hours planned, 10 minutes urgent.
  assert.equal(WAVE_PLANS.planned[0].acceptWindowMs, 2 * HOURS);
  assert.equal(WAVE_PLANS.urgent[0].acceptWindowMs, 10 * MINUTES);
  assert.equal(WAVE_PLANS.urgent[2].flagUrgent, true);
});

/* ---------------------------------------------------------------- ranking */

test("urgent ranks on answering speed, planned ranks on showing up", () => {
  const fastFlake = {
    phone: "1", reliability: { medianResponseSec: 30, showed: 2, noShow: 3 },
  };
  const slowRock = {
    phone: "2", reliability: { medianResponseSec: 3000, showed: 20, noShow: 0 },
  };

  // At 5:30am the person who answers in 30 seconds is the useful one.
  assert.equal(rankStaff([slowRock, fastFlake], "urgent")[0].phone, "1");
  // With two days' notice, the person who actually turns up is.
  assert.equal(rankStaff([fastFlake, slowRock], "planned")[0].phone, "2");
});

test("someone with no history ranks mid-table, not last", () => {
  const unproven = { phone: "new", reliability: null };
  const poor = { phone: "poor", reliability: { medianResponseSec: 3000, showed: 1, noShow: 5 } };
  const good = { phone: "good", reliability: { medianResponseSec: 60, showed: 30, noShow: 0 } };

  const ranked = rankStaff([poor, unproven, good], "planned").map((s) => s.phone);
  // A new starter who always ranks last never gets a first shift, and so never
  // gets history — the pool would ossify.
  assert.deepEqual(ranked, ["good", "new", "poor"]);
});

test("the response median is a bounded rolling window", () => {
  let r = normalizeReliability(null);
  for (let i = 0; i < 30; i++) r = withOfferAnswered(r, { accepted: true, responseSec: 100 });
  assert.equal(r.recentResponseSecs.length, 20, "the window must not grow without bound");

  // A run of fast answers moves the median off a slow history.
  for (let i = 0; i < 20; i++) r = withOfferAnswered(r, { accepted: true, responseSec: 10 });
  assert.equal(r.medianResponseSec, 10);

  assert.equal(medianOf([]), null);
  assert.equal(medianOf([5, 1, 3]), 3);
  assert.equal(medianOf([4, 1]), 3); // rounded mean of the middle pair
});

test("a non-response is never counted as a response time", () => {
  const answered = withOfferAnswered(normalizeReliability(null), { accepted: false, responseSec: null });
  assert.deepEqual(answered.recentResponseSecs, []);
  assert.equal(answered.medianResponseSec, null);
});

/* ------------------------------------------------------------ wave sending */

test("a blast notifies the pool, records offers, and tells the requester", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 4);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { requestedBy: "61499999999" });
    const now = new Date("2026-08-10T09:00:00");
    await advance(request, deps, {}, now);

    // Wave 1 (available) has no data source until step 3, so the engine falls
    // straight through to wave 2 rather than waiting two hours on nobody.
    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.wave, 2);

    const offers = await deps.offersStore.listByRequest(request.requestId);
    assert.equal(offers.length, 4);
    assert.ok(offers.every((o) => o.outcome === "pending" && o.sentAt));

    for (const phone of phones) {
      assert.equal(msg.to(phone).length, 1, `${phone} should have been offered the shift`);
      assert.match(msg.to(phone)[0].body, /Hilton Sydney/);
      assert.match(msg.to(phone)[0].body, new RegExp(`YES ${after.ref}`));
    }
    // "Searching — 41 people notified." from the design note's message flow.
    assert.match(msg.to("61499999999")[0].body, /Searching — 4 people notified/);

    // Every offer counts against `offered`, whether it's answered or not.
    const staff = await deps.staffStore.findByPhone(phones[0]);
    assert.equal(staff.reliability.offered, 1);
  } finally {
    msg.restore();
  }
});

test("a second tick inside the accept window does not re-blast", async () => {
  const deps = buildDeps();
  seedPool(deps, 3);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps);
    const now = new Date("2026-08-10T09:00:00");
    await advance(request, deps, {}, now);
    const sentAfterFirst = msg.sent.length;

    // One minute later. The window is two hours; nothing should move.
    await advance(await deps.requestsStore.findById(request.requestId), deps, {}, new Date(now.getTime() + MINUTES));
    assert.equal(msg.sent.length, sentAfterFirst, "the same wave must not be sent twice");
  } finally {
    msg.restore();
  }
});

test("nobody is offered the same request twice across waves", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 3);
  const msg = captureMessages();
  try {
    // Urgent: three waves, so there is somewhere to progress to.
    const now = new Date("2026-08-10T09:00:00");
    const request = await makeRequest(deps, { now, startsAt: new Date(now.getTime() + 2 * HOURS) });
    assert.equal(request.lane, "urgent");

    await advance(request, deps, {}, now);
    const afterWave = await deps.requestsStore.findById(request.requestId);

    // Push past the accept window so the engine tries the next wave.
    await advance(afterWave, deps, {}, new Date(now.getTime() + 11 * MINUTES));

    const offers = await deps.offersStore.listByRequest(request.requestId);
    const perPhone = {};
    for (const offer of offers) perPhone[offer.phone] = (perPhone[offer.phone] || 0) + 1;
    for (const phone of phones) {
      assert.equal(perPhone[phone], 1, `${phone} was offered the same shift more than once`);
    }
  } finally {
    msg.restore();
  }
});

test("an unanswered offer expires with no response time recorded", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const now = new Date("2026-08-10T09:00:00");
    const request = await makeRequest(deps, { now, startsAt: new Date(now.getTime() + 2 * HOURS) });
    await advance(request, deps, {}, now);

    await advance(
      await deps.requestsStore.findById(request.requestId),
      deps, {}, new Date(now.getTime() + 11 * MINUTES)
    );

    const offers = await deps.offersStore.listByRequest(request.requestId);
    const expired = offers.filter((o) => o.outcome === "expired");
    assert.ok(expired.length > 0, "the first wave's offers should have expired");
    // Writing a timestamp here would poison the median with non-responses.
    assert.ok(expired.every((o) => o.respondedAt === null));

    const staff = await deps.staffStore.findByPhone(phones[0]);
    assert.equal(staff.reliability.medianResponseSec, null);
  } finally {
    msg.restore();
  }
});

/* --------------------------------------------------- the first-come claim */

test("two people answering at once: exactly one gets the seat", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { headcount: 1, requestedBy: "61499999999" });
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));

    const [offerA, offerB] = await Promise.all([
      deps.offersStore.findPendingFor(phones[0], request.requestId),
      deps.offersStore.findPendingFor(phones[1], request.requestId),
    ]);
    const staffA = await deps.staffStore.findByPhone(phones[0]);
    const staffB = await deps.staffStore.findByPhone(phones[1]);

    const [resultA, resultB] = await Promise.all([
      acceptOffer(offerA, staffA, deps, {}),
      acceptOffer(offerB, staffB, deps, {}),
    ]);

    const winners = [resultA, resultB].filter((r) => r.ok);
    assert.equal(winners.length, 1, "one seat must go to exactly one person");
    const loser = [resultA, resultB].find((r) => !r.ok);
    assert.equal(loser.reason, "ALREADY_FULL");

    const final = await deps.requestsStore.findById(request.requestId);
    assert.equal(final.filled, 1);
    assert.equal(final.outcome, "filled");
    assert.ok(final.filledAt);
  } finally {
    msg.restore();
  }
});

test("losing the race is recorded as lost, not declined", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { headcount: 1 });
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));

    const offerA = await deps.offersStore.findPendingFor(phones[0], request.requestId);
    const offerB = await deps.offersStore.findPendingFor(phones[1], request.requestId);
    await acceptOffer(offerA, await deps.staffStore.findByPhone(phones[0]), deps, {});

    // B answers a moment too late.
    const result = await acceptOffer(offerB, await deps.staffStore.findByPhone(phones[1]), deps, {});
    assert.equal(result.ok, false);

    const offers = await deps.offersStore.listByRequest(request.requestId);
    const bOffer = offers.find((o) => o.phone === phones[1]);
    // Someone who answered fast and lost is one of your best people; folding
    // them into "declined" would rank them with the person who said no.
    assert.equal(bOffer.outcome, "lost");
    assert.ok(bOffer.respondedAt, "a lost race is still a real response time");

    const staffB = await deps.staffStore.findByPhone(phones[1]);
    assert.equal(staffB.reliability.accepted, 0);
    assert.ok(Number.isFinite(staffB.reliability.medianResponseSec));
  } finally {
    msg.restore();
  }
});

test("a duplicate yes cannot take a second seat", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { headcount: 2 });
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));
    const offer = await deps.offersStore.findPendingFor(phones[0], request.requestId);
    const staff = await deps.staffStore.findByPhone(phones[0]);

    const first = await acceptOffer(offer, staff, deps, {});
    assert.equal(first.ok, true);

    // Same offer object replayed — an impatient second "yes".
    const second = await acceptOffer(offer, staff, deps, {});
    assert.equal(second.ok, false);
    assert.equal(second.reason, "OFFER_ALREADY_RESOLVED");

    const final = await deps.requestsStore.findById(request.requestId);
    assert.equal(final.filled, 1, "the seat taken by the duplicate must be handed back");
  } finally {
    msg.restore();
  }
});

test("filling the last seat stops everyone else's clock", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 4);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { headcount: 1, requestedBy: "61499999999" });
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));

    const offer = await deps.offersStore.findPendingFor(phones[0], request.requestId);
    await acceptOffer(offer, await deps.staffStore.findByPhone(phones[0]), deps, {});

    const offers = await deps.offersStore.listByRequest(request.requestId);
    assert.equal(offers.filter((o) => o.outcome === "pending").length, 0);
    assert.match(msg.to("61499999999").at(-1).body, /All 1 confirmed/);
  } finally {
    msg.restore();
  }
});

/* ------------------------------------------- accepting books a real shift */

test("accepting writes the roster assignment the geofence resolves against", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 1);
  const msg = captureMessages();
  try {
    const now = new Date("2026-08-10T09:00:00");
    const startsAt = new Date("2026-08-12T07:00:00");
    const request = await makeRequest(deps, {
      now, startsAt, endsAt: new Date("2026-08-12T15:00:00"),
    });
    await advance(request, deps, {}, now);

    const offer = await deps.offersStore.findPendingFor(phones[0], request.requestId);
    const result = await acceptOffer(offer, await deps.staffStore.findByPhone(phones[0]), deps, {});
    assert.equal(result.ok, true);

    // This is the join between step 1 and step 2: the assignment carries the
    // site, so clock-in resolves the right building with no extra plumbing.
    const assignment = await deps.rosterStore.findAssignment("agency", "2026-08-12", phones[0]);
    assert.deepEqual(assignment, { slot: "07:00-15:00", siteId: "hilton-sydney" });
  } finally {
    msg.restore();
  }
});

test("declining is a real answer and feeds the median", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { headcount: 1 });
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));
    const offer = await deps.offersStore.findPendingFor(phones[0], request.requestId);

    const declined = await declineOffer(offer, deps);
    assert.equal(declined.outcome, "declined");

    const staff = await deps.staffStore.findByPhone(phones[0]);
    // Saying no still proves they read their messages, which is what the
    // number measures.
    assert.ok(Number.isFinite(staff.reliability.medianResponseSec));
    assert.equal(staff.reliability.accepted, 0);

    // And the seat is still there for someone else.
    const request2 = await deps.requestsStore.findById(request.requestId);
    assert.equal(seatsRemaining(request2), 1);
  } finally {
    msg.restore();
  }
});

/* ------------------------------------------------- the hard negative filter */

test("whoever is already booked is filtered out, with certainty", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 3);
  const msg = captureMessages();
  try {
    // Casual 1 is already rostered at the Hilton that morning.
    await deps.rosterStore.setAssignment("agency", "2026-08-12", phones[0], {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });
    // Casual 2 is rostered that night — no overlap, so they should still be asked.
    await deps.rosterStore.setAssignment("agency", "2026-08-12", phones[1], {
      slot: "22:00-06:00", siteId: "hilton-sydney",
    });

    const now = new Date("2026-08-10T09:00:00");
    const request = await makeRequest(deps, {
      now,
      startsAt: new Date("2026-08-12T09:00:00"),
      endsAt: new Date("2026-08-12T17:00:00"),
    });
    await advance(request, deps, {}, now);

    const offered = [...(await deps.offersStore.phonesOfferedFor(request.requestId))];
    assert.ok(!offered.includes(phones[0]), "an overlapping booking is a hard no");
    assert.ok(offered.includes(phones[1]), "a night shift doesn't clash with a day shift");
    assert.ok(offered.includes(phones[2]));
  } finally {
    msg.restore();
  }
});

test("anyone currently clocked in is busy whatever the roster says", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  await deps.shiftsStore.openShift({
    tenantId: "agency",
    staffPhone: phones[0],
    department: "housekeeping",
    siteId: "hilton-sydney",
    siteName: "Hilton Sydney",
    clockIn: { time: new Date("2026-08-10T07:00:00").toISOString(), withinRadius: true, distanceMeters: 3 },
  });

  const request = await makeRequest(deps);
  const booked = await bookedPhones(request, deps);
  assert.ok(booked.has(phones[0]));
  assert.ok(!booked.has(phones[1]));
});

test("slot windows overlap correctly, including across midnight", () => {
  const day = slotWindow("07:00-15:00", "2026-08-12");
  const night = slotWindow("22:00-06:00", "2026-08-12");
  const evening = slotWindow("PM", "2026-08-12"); // 14:00-22:00

  assert.equal(windowsOverlap(day, night), false);
  assert.equal(windowsOverlap(day, evening), true, "15:00 day and 14:00 PM overlap by an hour");
  assert.equal(windowsOverlap(night, evening), false, "22:00 is the boundary, not an overlap");
  // The night shift runs into the next morning.
  assert.equal(night.endsAt.getDate(), 13);
  assert.equal(slotWindow("NIGHT", "2026-08-12").endsAt.getHours(), 6);
  assert.equal(slotWindow("nonsense", "2026-08-12"), null);
});

/* ------------------------------------------------------------- give up well */

test("a request nobody can fill is closed, not retried forever", async () => {
  const deps = buildDeps();
  // No staff at all.
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, { requestedBy: "61499999999" });
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));

    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.outcome, "unfilled");
    assert.match(msg.to("61499999999").at(-1).body, /Couldn't fill/);

    // And it drops out of the dispatcher's work list.
    assert.equal((await deps.requestsStore.listOpen("agency")).length, 0);
  } finally {
    msg.restore();
  }
});

test("a part-filled request that runs out of time closes as partial", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const now = new Date("2026-08-10T09:00:00");
    const startsAt = new Date(now.getTime() + 2 * HOURS);
    const request = await makeRequest(deps, { now, startsAt, headcount: 3, requestedBy: "61499999999" });
    await advance(request, deps, {}, now);

    const offer = await deps.offersStore.findPendingFor(phones[0], request.requestId);
    await acceptOffer(offer, await deps.staffStore.findByPhone(phones[0]), deps, {});

    // Well past the start with two of three seats still open.
    await advance(
      await deps.requestsStore.findById(request.requestId),
      deps, {}, new Date(startsAt.getTime() + 45 * MINUTES)
    );

    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.outcome, "partial");
    assert.equal(after.filled, 1);
    assert.match(msg.to("61499999999").at(-1).body, /1 of 3/);
  } finally {
    msg.restore();
  }
});

/* --------------------------------------------------------- auto-backfill */

test("no clock-in fifteen minutes in fires the urgent blast on its own", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 3);
  const msg = captureMessages();
  try {
    // Casual 1 is rostered from 07:00 and hasn't turned up.
    await deps.rosterStore.setAssignment("agency", "2026-08-12", phones[0], {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });

    // 07:10 — inside the grace period, nothing happens.
    let created = await sweepNoShows("agency", deps, {}, new Date("2026-08-12T07:10:00"));
    assert.equal(created.length, 0);

    // 07:16 — the shift is fifteen minutes old and empty.
    created = await sweepNoShows("agency", deps, {}, new Date("2026-08-12T07:16:00"));
    assert.equal(created.length, 1);
    const backfill = created[0];
    // Urgent by derivation, because the replacement is needed now.
    assert.equal(backfill.lane, "urgent");
    assert.equal(backfill.siteId, "hilton-sydney");
    assert.equal(backfill.headcount, 1);

    // The no-show is recorded against the person who didn't turn up.
    const absentee = await deps.staffStore.findByPhone(phones[0]);
    assert.equal(absentee.reliability.noShow, 1);
  } finally {
    msg.restore();
  }
});

test("the backfill sweep cannot fire twice for the same missed shift", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 3);
  const msg = captureMessages();
  try {
    await deps.rosterStore.setAssignment("agency", "2026-08-12", phones[0], {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });

    const first = await sweepNoShows("agency", deps, {}, new Date("2026-08-12T07:16:00"));
    assert.equal(first.length, 1);

    // A tick every thirty seconds must not raise a request every thirty seconds.
    for (const minute of [17, 18, 30, 90]) {
      const again = await sweepNoShows("agency", deps, {}, new Date(`2026-08-12T0${minute > 59 ? 8 : 7}:${String(minute % 60).padStart(2, "0")}:00`));
      assert.equal(again.length, 0, `sweep at 07:${minute} should have been deduped`);
    }
    const all = await deps.requestsStore.listRecent("agency", "2026-01-01T00:00:00.000Z");
    assert.equal(all.filter((r) => r.backfillFor).length, 1);
  } finally {
    msg.restore();
  }
});

test("somebody who clocked in late is not backfilled", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 3);
  const msg = captureMessages();
  try {
    await deps.rosterStore.setAssignment("agency", "2026-08-12", phones[0], {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });
    // Twelve minutes late, but present.
    await deps.shiftsStore.openShift({
      tenantId: "agency",
      staffPhone: phones[0],
      department: "housekeeping",
      siteId: "hilton-sydney",
      siteName: "Hilton Sydney",
      clockIn: { time: new Date("2026-08-12T07:12:00").toISOString(), withinRadius: true, distanceMeters: 5 },
    });

    const created = await sweepNoShows("agency", deps, {}, new Date("2026-08-12T07:20:00"));
    assert.equal(created.length, 0, "they are on site — blasting a replacement would be absurd");
    const staff = await deps.staffStore.findByPhone(phones[0]);
    // Read through the normalizer: a staff record only grows a reliability
    // object once something has happened to them.
    assert.equal(normalizeReliability(staff.reliability).noShow, 0);
  } finally {
    msg.restore();
  }
});

test("a tick both sweeps no-shows and advances open requests", async () => {
  const deps = buildDeps();
  const phones = seedPool(deps, 3);
  const msg = captureMessages();
  try {
    await deps.rosterStore.setAssignment("agency", "2026-08-12", phones[0], {
      slot: "07:00-15:00", siteId: "hilton-sydney",
    });

    const result = await tick("agency", deps, {}, new Date("2026-08-12T07:16:00"));
    assert.equal(result.backfilled, 1);

    // The backfill request was raised and blasted in the same pass, so the
    // replacement is being found before the supervisor has noticed the gap.
    const requests = await deps.requestsStore.listRecent("agency", "2026-01-01T00:00:00.000Z");
    const backfill = requests.find((r) => r.backfillFor);
    const offers = await deps.offersStore.listByRequest(backfill.requestId);
    assert.ok(offers.length > 0, "the backfill should already be out to the pool");
    // Not to the person who didn't turn up.
    assert.ok(!offers.some((o) => o.phone === phones[0]));
  } finally {
    msg.restore();
  }
});

/* ------------------------------------------------------------------- misc */

test("responseSeconds only measures a real answer", () => {
  assert.equal(responseSeconds({ sentAt: "2026-08-10T09:00:00Z", respondedAt: null }), null);
  assert.equal(
    responseSeconds({ sentAt: "2026-08-10T09:00:00Z", respondedAt: "2026-08-10T09:00:45Z" }),
    45
  );
  // Clock skew must not produce a negative median.
  assert.equal(
    responseSeconds({ sentAt: "2026-08-10T09:00:45Z", respondedAt: "2026-08-10T09:00:00Z" }),
    null
  );
});

test("cancelling is not the same as being unable to fill", async () => {
  const deps = buildDeps();
  seedPool(deps, 2);
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps);
    await advance(request, deps, {}, new Date("2026-08-10T09:00:00"));

    await deps.offersStore.expirePending(request.requestId);
    await deps.requestsStore.close(request.requestId, "cancelled");

    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.outcome, "cancelled");
    assert.equal((await deps.requestsStore.listOpen("agency")).length, 0);
    // Nobody is left holding an offer for a shift that no longer exists.
    const offers = await deps.offersStore.listByRequest(request.requestId);
    assert.equal(offers.filter((o) => o.outcome === "pending").length, 0);
  } finally {
    msg.restore();
  }
});
