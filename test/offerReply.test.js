"use strict";

/**
 * Answering an offer over WhatsApp — the staff-facing half of build order
 * step 2. Covers the parsing, the refusal to guess between two hotels, and the
 * late-answer rules that keep response timing honest.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { InMemorySiteStore } = require("../siteStore");
const { InMemoryRosterStore } = require("../rosterStore");
const { InMemoryTenantStore } = require("../tenantStore");
const { InMemoryShiftsStore } = require("../shiftsStore");
const { InMemoryStaffStore } = require("../store");
const { InMemoryRequestsStore } = require("../requestsStore");
const { InMemoryOffersStore } = require("../offersStore");
const { normalizeReliability } = require("../reliability");
const { advance, acceptOffer } = require("../dispatch");
const { handleOfferReply, looksLikeOfferReply, extractRef } = require("../offerHandler");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const MANLY = { lat: -33.7969, lng: 151.2876, radiusMeters: 75 };
const HOURS = 60 * 60 * 1000;

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
  siteStore.upsert("manly-pacific", { tenantId: "agency", name: "Manly Pacific", geofence: MANLY });
  const staffStore = new InMemoryStaffStore();
  return {
    staffStore,
    siteStore,
    tenantStore: new InMemoryTenantStore(),
    requestsStore: new InMemoryRequestsStore(),
    offersStore: new InMemoryOffersStore(),
    rosterStore: new InMemoryRosterStore(),
    shiftsStore: new InMemoryShiftsStore(),
  };
}

function addStaff(deps, phone, name) {
  deps.staffStore.upsert({
    phone, tenantId: "agency", name, role: "staff", department: "housekeeping",
  });
  return { phone, tenantId: "agency", name, role: "staff", department: "housekeeping" };
}

const NOW = new Date("2026-08-10T09:00:00");

function makeRequest(deps, siteId, siteName, overrides = {}) {
  const startsAt = overrides.startsAt || new Date(NOW.getTime() + 48 * HOURS);
  return deps.requestsStore.create({
    tenantId: "agency",
    siteId,
    siteName,
    role: "housekeeping",
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 8 * HOURS).toISOString(),
    headcount: overrides.headcount || 1,
    now: (overrides.now || NOW).toISOString(),
  });
}

/* ------------------------------------------------------------------ parsing */

test("yes and no are recognised in the shapes people actually type", () => {
  for (const yes of ["yes", "y", "Yes please", "yep", "YEAH", "ok", "sure", "i'll take it"]) {
    assert.ok(looksLikeOfferReply(yes.toLowerCase()), `"${yes}" should read as an answer`);
  }
  for (const no of ["no", "n", "nope", "nah", "pass", "can't", "cant sorry"]) {
    assert.ok(looksLikeOfferReply(no.toLowerCase()), `"${no}" should read as an answer`);
  }
  // Must not swallow the other commands.
  for (const other of ["in", "out", "break", "back", "roster", "avail mon", "off 3/8", "spend 420"]) {
    assert.equal(looksLikeOfferReply(other), false, `"${other}" is not an offer answer`);
  }
});

test("a request code is picked out of the message, ambiguous letters excluded", () => {
  assert.equal(extractRef("yes h7k2"), "H7K2");
  assert.equal(extractRef("YES ref H7K2 thanks"), "H7K2");
  assert.equal(extractRef("yes"), null);
  // 0/O, 1/I/L and 5/S are not in the alphabet, so they can't be misread codes.
  assert.equal(extractRef("yes 1lo5"), null);
});

/* ------------------------------------------------------------- happy paths */

test("one offer open: yes takes it and books the shift", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney");
    await advance(request, deps, {}, NOW);

    await handleOfferReply(staff.phone, staff, "yes", deps, {});

    assert.match(msg.lastTo(staff.phone).body, /You're on: housekeeping — Hilton Sydney/);
    assert.match(msg.lastTo(staff.phone).body, /Message "in" when you get there/);

    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.filled, 1);
    assert.equal(after.outcome, "filled");
  } finally {
    msg.restore();
  }
});

test("no is a real answer, and the seat stays open for someone else", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "61400000201", "Maria");
  addStaff(deps, "61400000202", "Ahmed");
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney");
    await advance(request, deps, {}, NOW);

    await handleOfferReply(staff.phone, staff, "nah", deps, {});
    assert.match(msg.lastTo(staff.phone).body, /passed on housekeeping — Hilton Sydney/);

    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.filled, 0);
    assert.equal(after.outcome, "open");

    const reliability = normalizeReliability((await deps.staffStore.findByPhone(staff.phone)).reliability);
    assert.equal(reliability.accepted, 0);
    assert.ok(Number.isFinite(reliability.medianResponseSec), "a decline is still a response time");
  } finally {
    msg.restore();
  }
});

/* ---------------------------------------------------- never guess the hotel */

test("two offers open: a bare yes asks which, and takes neither", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    const hilton = await makeRequest(deps, "hilton-sydney", "Hilton Sydney");
    const manly = await makeRequest(deps, "manly-pacific", "Manly Pacific");
    await advance(hilton, deps, {}, NOW);
    await advance(manly, deps, {}, NOW);

    await handleOfferReply(staff.phone, staff, "yes", deps, {});

    const reply = msg.lastTo(staff.phone).body;
    assert.match(reply, /2 offers open/);
    assert.match(reply, /Hilton Sydney/);
    assert.match(reply, /Manly Pacific/);

    // Accepting the wrong hotel sends somebody to the wrong side of the city,
    // so neither may be claimed on a guess.
    assert.equal((await deps.requestsStore.findById(hilton.requestId)).filled, 0);
    assert.equal((await deps.requestsStore.findById(manly.requestId)).filled, 0);
  } finally {
    msg.restore();
  }
});

test("two offers open: yes with the code takes exactly that one", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    const hilton = await makeRequest(deps, "hilton-sydney", "Hilton Sydney");
    const manly = await makeRequest(deps, "manly-pacific", "Manly Pacific");
    await advance(hilton, deps, {}, NOW);
    await advance(manly, deps, {}, NOW);

    const manlyRef = (await deps.requestsStore.findById(manly.requestId)).ref;
    await handleOfferReply(staff.phone, staff, `yes ${manlyRef.toLowerCase()}`, deps, {});

    assert.match(msg.lastTo(staff.phone).body, /You're on: housekeeping — Manly Pacific/);
    assert.equal((await deps.requestsStore.findById(manly.requestId)).filled, 1);
    assert.equal((await deps.requestsStore.findById(hilton.requestId)).filled, 0);
  } finally {
    msg.restore();
  }
});

test("an unknown code is reported with the codes that do work", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney");
    await advance(request, deps, {}, NOW);
    const realRef = (await deps.requestsStore.findById(request.requestId)).ref;

    await handleOfferReply(staff.phone, staff, "yes zzzz", deps, {});

    const reply = msg.lastTo(staff.phone).body;
    assert.match(reply, /can't find an open offer with the code ZZZZ/);
    assert.match(reply, new RegExp(realRef));
    assert.equal((await deps.requestsStore.findById(request.requestId)).filled, 0);
  } finally {
    msg.restore();
  }
});

test("answering with nothing on offer says so rather than going quiet", async () => {
  const deps = buildDeps();
  const staff = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    await handleOfferReply(staff.phone, staff, "yes", deps, {});
    // Silence here reads as the system being broken.
    assert.match(msg.lastTo(staff.phone).body, /don't have any open shift offers/);
  } finally {
    msg.restore();
  }
});

/* --------------------------------------------------------- losing the race */

test("losing by seconds is told plainly, and counted as a fast answer", async () => {
  const deps = buildDeps();
  const maria = addStaff(deps, "61400000201", "Maria");
  const ahmed = addStaff(deps, "61400000202", "Ahmed");
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney", { headcount: 1 });
    await advance(request, deps, {}, NOW);

    // Maria gets there first.
    const mariaOffer = await deps.offersStore.findPendingFor(maria.phone, request.requestId);
    await acceptOffer(mariaOffer, maria, deps, {});

    // Ahmed answers a moment later. His offer was expired when the last seat
    // went — that must not turn his answer into a non-response.
    await handleOfferReply(ahmed.phone, ahmed, "yes", deps, {});

    assert.match(msg.lastTo(ahmed.phone).body, /has just been taken/);
    assert.match(msg.lastTo(ahmed.phone).body, /You were quick/);

    const offers = await deps.offersStore.listByRequest(request.requestId);
    const ahmedOffer = offers.find((o) => o.phone === ahmed.phone);
    assert.equal(ahmedOffer.outcome, "lost");
    assert.ok(ahmedOffer.respondedAt, "he answered — the timestamp is the whole point");

    const reliability = normalizeReliability((await deps.staffStore.findByPhone(ahmed.phone)).reliability);
    assert.ok(
      Number.isFinite(reliability.medianResponseSec),
      "a fast loser is one of your best people and must rank as one"
    );
  } finally {
    msg.restore();
  }
});

test("a late yes still gets the shift while seats are open", async () => {
  const deps = buildDeps();
  const maria = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    // Urgent lane: a ten-minute accept window, so expiry is easy to reach.
    const startsAt = new Date(NOW.getTime() + 2 * HOURS);
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney", { startsAt });
    await advance(request, deps, {}, NOW);
    assert.equal((await deps.requestsStore.findById(request.requestId)).lane, "urgent");

    // The window closes with nobody having answered.
    await deps.offersStore.expirePending(request.requestId);

    // Maria replies two minutes late. The shift is still unfilled, so turning
    // her away would be perverse.
    await handleOfferReply(maria.phone, maria, "yes", deps, {});

    assert.match(msg.lastTo(maria.phone).body, /You're on: housekeeping — Hilton Sydney/);
    const after = await deps.requestsStore.findById(request.requestId);
    assert.equal(after.filled, 1);
  } finally {
    msg.restore();
  }
});

test("a second yes after a real answer changes nothing", async () => {
  const deps = buildDeps();
  const maria = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney", { headcount: 2 });
    await advance(request, deps, {}, NOW);

    await handleOfferReply(maria.phone, maria, "yes", deps, {});
    const filledOnce = (await deps.requestsStore.findById(request.requestId)).filled;
    assert.equal(filledOnce, 1);

    // An impatient repeat. She already has the shift; it must not take a
    // second seat, and she must not be told she lost.
    await handleOfferReply(maria.phone, maria, "yes", deps, {});
    assert.equal((await deps.requestsStore.findById(request.requestId)).filled, 1);
    assert.match(msg.lastTo(maria.phone).body, /don't have any open shift offers/);
  } finally {
    msg.restore();
  }
});

test("a withdrawn request tells the person instead of failing silently", async () => {
  const deps = buildDeps();
  const maria = addStaff(deps, "61400000201", "Maria");
  const msg = captureMessages();
  try {
    const request = await makeRequest(deps, "hilton-sydney", "Hilton Sydney");
    await advance(request, deps, {}, NOW);

    // The hotel pulls it. Offers are expired but Maria's reply is in flight.
    await deps.offersStore.expirePending(request.requestId);
    await deps.requestsStore.close(request.requestId, "cancelled");

    await handleOfferReply(maria.phone, maria, "yes", deps, {});
    assert.match(msg.lastTo(maria.phone).body, /has just been taken|withdrawn/);
    assert.equal((await deps.requestsStore.findById(request.requestId)).filled, 0);
  } finally {
    msg.restore();
  }
});
