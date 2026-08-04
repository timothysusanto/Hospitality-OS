"use strict";

/**
 * Client intake over chat — build order step 4 of docs/agencymodelshape.md.
 *
 * The load-bearing rules under test:
 *   - only registered numbers can order
 *   - sender identity decides which conversation you're in
 *   - nothing dispatches on an unconfirmed parse
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
const { parseRequest, parseClock, parseHeadcount, parseRole } = require("../requestParser");
const { handleClientMessage, findPendingDraft } = require("../intakeHandler");
const { handleIncoming } = require("../router");
const { tick } = require("../dispatch");

const HILTON = { lat: -33.8710, lng: 151.2073, radiusMeters: 75 };
const MANLY = { lat: -33.7969, lng: 151.2876, radiusMeters: 75 };
const HOURS = 60 * 60 * 1000;

process.env.WHATSAPP_PHONE_NUMBER_ID = "test-number";
process.env.WHATSAPP_TOKEN = "test-token";
process.env.DEFAULT_TENANT_ID = "agency";

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

const MANAGER = "61455000001";
const REGIONAL = "61455000002";

function buildDeps({ twoSites = false } = {}) {
  const siteStore = new InMemorySiteStore();
  siteStore.upsert("hilton-sydney", {
    tenantId: "agency", name: "Hilton Sydney", geofence: HILTON,
    requesters: [{ phone: MANAGER, name: "Dana (Hilton)" }],
  });
  if (twoSites) {
    siteStore.upsert("manly-pacific", {
      tenantId: "agency", name: "Manly Pacific", geofence: MANLY,
      requesters: [{ phone: REGIONAL, name: "Sam (regional)" }],
    });
    siteStore.upsert("hilton-sydney", {
      tenantId: "agency", name: "Hilton Sydney", geofence: HILTON,
      requesters: [{ phone: MANAGER, name: "Dana (Hilton)" }, { phone: REGIONAL, name: "Sam (regional)" }],
    });
  }
  return {
    staffStore: new InMemoryStaffStore(),
    siteStore,
    tenantStore: new InMemoryTenantStore(),
    requestsStore: new InMemoryRequestsStore(),
    offersStore: new InMemoryOffersStore(),
    availabilityStore: new InMemoryAvailabilityStore(),
    freeTodayStore: new InMemoryFreeTodayStore(),
    rosterStore: new InMemoryRosterStore(),
    shiftsStore: new InMemoryShiftsStore(),
    pendingActions: new InMemoryPendingActions(),
  };
}

function addCasual(deps, phone, name) {
  deps.staffStore.upsert({
    phone, tenantId: "agency", name, role: "staff", department: "housekeeping",
    roles: ["housekeeping"],
  });
}

/** A Monday at 09:00 so relative dates are unambiguous. */
const NOW = new Date("2026-08-10T09:00:00");

/* ------------------------------------------------------------------ parsing */

test("the parser reads a hotel's actual words", () => {
  const sites = [{ siteId: "hilton-sydney", name: "Hilton Sydney", tenantId: "agency" }];
  const { draft, confident } = parseRequest("need 3 housekeepers tomorrow 7am", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  });

  assert.equal(confident, true);
  assert.equal(draft.headcount, 3);
  assert.equal(draft.role, "housekeeping");
  assert.equal(draft.siteId, "hilton-sydney");
  assert.equal(new Date(draft.startsAt).getDate(), 11);
  assert.equal(new Date(draft.startsAt).getHours(), 7);
  // No end stated: an 8 hour shift, and the caller is told it was assumed.
  assert.equal(new Date(draft.endsAt).getHours(), 15);
  assert.equal(draft.inferredEnd, true);
});

test("a stated range is used as given, including across midnight", () => {
  const sites = [{ siteId: "hilton-sydney", name: "Hilton Sydney", tenantId: "agency" }];
  const night = parseRequest("2 porters tonight 10pm-6am", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  }).draft;
  assert.equal(night.headcount, 2);
  assert.equal(night.role, "porter");
  assert.equal(new Date(night.startsAt).getHours(), 22);
  assert.equal(new Date(night.endsAt).getHours(), 6);
  // The night runs into the next day.
  assert.equal(new Date(night.endsAt).getDate(), 11);
  assert.equal(night.inferredEnd, false);

  const day = parseRequest("4 housekeeping fri 7am-3pm", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  }).draft;
  assert.equal(day.headcount, 4);
  assert.equal(new Date(day.startsAt).getHours(), 7);
  assert.equal(new Date(day.endsAt).getHours(), 15);
  // Friday of the same week, from a Monday.
  assert.equal(new Date(day.startsAt).getDate(), 14);
});

test("a clock time is never mistaken for a headcount", () => {
  const sites = [{ siteId: "hilton-sydney", name: "Hilton Sydney", tenantId: "agency" }];
  // This is the whole reason the confirm step exists: "7am" must not become
  // seven people, and "30" must not become thirty.
  const one = parseRequest("housekeeper tomorrow 7am", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  });
  assert.ok(one.missing.includes("headcount"), "no number means ask, not assume 7");

  const explicit = parseRequest("1 housekeeper tomorrow 7am", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  }).draft;
  assert.equal(explicit.headcount, 1);

  const worded = parseRequest("two porters tomorrow 10pm", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  }).draft;
  assert.equal(worded.headcount, 2);
});

test("what it can't work out is reported, not guessed", () => {
  const sites = [{ siteId: "hilton-sydney", name: "Hilton Sydney", tenantId: "agency" }];
  const vague = parseRequest("can you send someone please", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  });
  assert.equal(vague.confident, false);
  for (const key of ["headcount", "role", "date", "time"]) {
    assert.ok(vague.missing.includes(key), `${key} should be reported missing`);
  }

  // A date with no time is still incomplete — a guess costs a hotel a shift.
  const noTime = parseRequest("3 housekeepers tomorrow", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  });
  assert.deepEqual(noTime.missing, ["time"]);
});

test("a block word stands in for a clock time", () => {
  const sites = [{ siteId: "hilton-sydney", name: "Hilton Sydney", tenantId: "agency" }];
  const overnight = parseRequest("1 security tomorrow overnight", {
    sites, defaultSiteId: "hilton-sydney", now: NOW,
  }).draft;
  assert.equal(new Date(overnight.startsAt).getHours(), 22);
  assert.equal(overnight.fromBlock, "NIGHT");
});

test("the site is picked out by name when a requester covers several", () => {
  const sites = [
    { siteId: "hilton-sydney", name: "Hilton Sydney", tenantId: "agency" },
    { siteId: "manly-pacific", name: "Manly Pacific", tenantId: "agency" },
  ];
  const named = parseRequest("3 housekeepers for manly pacific tomorrow 7am", {
    sites, defaultSiteId: null, now: NOW,
  });
  assert.equal(named.draft.siteId, "manly-pacific");

  // With several sites and no name, ask which — never pick one.
  const unnamed = parseRequest("3 housekeepers tomorrow 7am", {
    sites, defaultSiteId: null, now: NOW,
  });
  assert.ok(unnamed.missing.includes("site"));
});

test("clock parsing handles the shapes people write", () => {
  assert.equal(parseClock("7am"), 7);
  assert.equal(parseClock("7:30am"), 7.5);
  assert.equal(parseClock("10pm"), 22);
  assert.equal(parseClock("12am"), 0);
  assert.equal(parseClock("12pm"), 12);
  assert.equal(parseClock("22:00"), 22);
  // A bare afternoon-ish number: "7-3" means 7am to 3pm, not 3am.
  assert.equal(parseClock("3"), 15);
  assert.equal(parseClock("7"), 7);
  assert.equal(parseClock("99"), null);
  assert.equal(parseHeadcount("3 housekeepers"), 3);
  assert.equal(parseRole("need some hk"), "housekeeping");
  assert.equal(parseRole("2 f&b staff"), "food-and-beverage");
});

/* --------------------------------------------- only registered numbers order */

test("an unregistered number is asked to register, never given a shift", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    await handleIncoming(
      { from: "61499000999", type: "text", text: { body: "3 housekeepers tomorrow 7am" } },
      deps
    );
    const reply = msg.lastTo("61499000999").body;
    assert.match(reply, /isn't registered/);
    assert.match(reply, /register this number for your hotel/);
    // Nothing was created.
    assert.equal((await deps.requestsStore.listRecent("agency", "2000-01-01T00:00:00Z")).length, 0);
  } finally {
    msg.restore();
  }
});

test("sender identity decides the conversation, client before staff", async () => {
  const deps = buildDeps();
  // The same number is both a registered requester and on the staff list — an
  // agency supervisor who also covers shifts.
  deps.staffStore.upsert({
    phone: MANAGER, tenantId: "agency", name: "Dana", role: "manager", department: "housekeeping",
  });
  const msg = captureMessages();
  try {
    await handleIncoming(
      { from: MANAGER, type: "text", text: { body: "3 housekeepers tomorrow 7am" } },
      deps
    );
    // Read as an order, not as an unrecognised staff command.
    assert.match(msg.lastTo(MANAGER).body, /3 × Housekeeping — Hilton Sydney/);
    assert.match(msg.lastTo(MANAGER).body, /Reply CONFIRM/);
  } finally {
    msg.restore();
  }
});

test("a client's \"no\" cancels their draft and is not read as declining a shift", async () => {
  const deps = buildDeps();
  addCasual(deps, "61400000701", "Maria");
  const msg = captureMessages();
  try {
    await handleClientMessage(MANAGER, await deps.siteStore.findByRequesterPhone("agency", MANAGER),
      "3 housekeepers tomorrow 7am", deps, {}, NOW);
    const draft = await findPendingDraft("agency", MANAGER, deps);
    assert.ok(draft);

    await handleClientMessage(MANAGER, await deps.siteStore.findByRequesterPhone("agency", MANAGER),
      "no", deps, {}, NOW);
    assert.match(msg.lastTo(MANAGER).body, /Cancelled — nothing has gone out/);
    assert.equal((await deps.requestsStore.findById(draft.requestId)).outcome, "cancelled");
  } finally {
    msg.restore();
  }
});

/* ------------------------------------- never dispatch on an unconfirmed parse */

test("an unconfirmed order physically cannot dispatch", async () => {
  const deps = buildDeps();
  addCasual(deps, "61400000701", "Maria");
  addCasual(deps, "61400000702", "Ahmed");
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "3 housekeepers tomorrow 7am", deps, {}, NOW);

    const draft = await findPendingDraft("agency", MANAGER, deps);
    assert.ok(draft, "a draft was stored");
    assert.equal(draft.confirmedAt, null);

    // The guard is structural: listOpen excludes unconfirmed requests, so a
    // whole dispatch pass cannot pick it up even if this handler forgot.
    assert.equal((await deps.requestsStore.listOpen("agency")).length, 0);
    await tick("agency", deps, {}, NOW);
    assert.equal((await deps.offersStore.listByRequest(draft.requestId)).length, 0);
    assert.equal(msg.to("61400000701").length, 0, "nobody should have been messaged");
  } finally {
    msg.restore();
  }
});

test("confirming is what starts the blast", async () => {
  const deps = buildDeps();
  addCasual(deps, "61400000701", "Maria");
  addCasual(deps, "61400000702", "Ahmed");
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "3 housekeepers tomorrow 7am", deps, {}, NOW);
    await handleClientMessage(MANAGER, sites, "confirm", deps, {}, NOW);

    assert.match(msg.lastTo(MANAGER).body, /Confirmed/);
    assert.match(msg.lastTo(MANAGER).body, /Searching now/);

    const request = (await deps.requestsStore.listOpen("agency"))[0];
    assert.ok(request, "it is now dispatchable");
    assert.ok(request.confirmedAt);

    await tick("agency", deps, {}, NOW);
    const offers = await deps.offersStore.listByRequest(request.requestId);
    assert.equal(offers.length, 2);
    assert.equal(msg.to("61400000701").length, 1);
  } finally {
    msg.restore();
  }
});

test("a corrected order supersedes the draft rather than leaving two", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "3 housekeepers tomorrow 7am", deps, {}, NOW);
    const first = await findPendingDraft("agency", MANAGER, deps);

    // They realise they need four, and just retype it.
    await handleClientMessage(MANAGER, sites, "4 housekeepers tomorrow 7am", deps, {}, NOW);
    const second = await findPendingDraft("agency", MANAGER, deps);

    assert.notEqual(second.requestId, first.requestId);
    assert.equal(second.headcount, 4);
    // The stale draft can't be confirmed later by accident.
    assert.equal((await deps.requestsStore.findById(first.requestId)).outcome, "cancelled");
  } finally {
    msg.restore();
  }
});

test("an incomplete order asks for exactly what's missing", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "need some help tomorrow", deps, {}, NOW);

    const reply = msg.lastTo(MANAGER).body;
    assert.match(reply, /how many people/);
    assert.match(reply, /what role/);
    assert.match(reply, /what time/);
    // And nothing was stored, so there's no half-draft to confirm.
    assert.equal(await findPendingDraft("agency", MANAGER, deps), null);
  } finally {
    msg.restore();
  }
});

test("the confirmation reads back the shift as it will be worked", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "3 housekeepers tomorrow 7am", deps, {}, NOW);

    const reply = msg.lastTo(MANAGER).body;
    assert.match(reply, /3 × Housekeeping — Hilton Sydney/);
    assert.match(reply, /Tue, 11 Aug, 07:00–15:00/);
    // An assumption is stated out loud, not applied quietly.
    assert.match(reply, /assumed an 8 hour shift/);
  } finally {
    msg.restore();
  }
});

test("an urgent order says so before it goes out", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    // 05:40, asking for 7am today — the design note's own scenario.
    const dawn = new Date("2026-08-10T05:40:00");
    await handleClientMessage(MANAGER, sites, "need 3 housekeepers today 7am", deps, {}, dawn);

    assert.match(msg.lastTo(MANAGER).body, /urgent/);
    const draft = await findPendingDraft("agency", MANAGER, deps);
    assert.equal(draft.lane, "urgent");
  } finally {
    msg.restore();
  }
});

/* ----------------------------------------------- the status loop back */

test("a hotel can ask where their order is, and gets names", async () => {
  const deps = buildDeps();
  addCasual(deps, "61400000701", "Maria");
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "2 housekeepers tomorrow 7am", deps, {}, NOW);
    await handleClientMessage(MANAGER, sites, "confirm", deps, {}, NOW);
    await tick("agency", deps, {}, NOW);

    const request = (await deps.requestsStore.listOpen("agency"))[0];
    const offer = await deps.offersStore.findPendingFor("61400000701", request.requestId);
    const { acceptOffer } = require("../dispatch");
    await acceptOffer(offer, await deps.staffStore.findByPhone("61400000701"), deps, {});

    await handleClientMessage(MANAGER, sites, "status", deps, {}, NOW);
    const reply = msg.lastTo(MANAGER).body;
    assert.match(reply, /1 of 2 filled: Maria/);
  } finally {
    msg.restore();
  }
});

test("status names a draft still waiting on a confirm", async () => {
  const deps = buildDeps();
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", MANAGER);
    await handleClientMessage(MANAGER, sites, "2 housekeepers tomorrow 7am", deps, {}, NOW);
    await handleClientMessage(MANAGER, sites, "status", deps, {}, NOW);
    assert.match(msg.lastTo(MANAGER).body, /waiting on your CONFIRM/);
  } finally {
    msg.restore();
  }
});

/* ---------------------------------------------------- the requester registry */

test("a requester covering two hotels must name which", async () => {
  const deps = buildDeps({ twoSites: true });
  const msg = captureMessages();
  try {
    const sites = await deps.siteStore.findByRequesterPhone("agency", REGIONAL);
    assert.equal(sites.length, 2);

    await handleClientMessage(REGIONAL, sites, "3 housekeepers tomorrow 7am", deps, {}, NOW);
    assert.match(msg.lastTo(REGIONAL).body, /which hotel/);

    await handleClientMessage(REGIONAL, sites, "3 housekeepers for manly pacific tomorrow 7am", deps, {}, NOW);
    assert.match(msg.lastTo(REGIONAL).body, /Manly Pacific/);
  } finally {
    msg.restore();
  }
});

test("removing a requester removes their ability to order", async () => {
  const deps = buildDeps();
  assert.equal((await deps.siteStore.findByRequesterPhone("agency", MANAGER)).length, 1);

  await deps.siteStore.setRequesters("hilton-sydney", []);
  assert.equal((await deps.siteStore.findByRequesterPhone("agency", MANAGER)).length, 0);

  // And a deactivated site cannot be ordered for at all.
  await deps.siteStore.setRequesters("hilton-sydney", [{ phone: MANAGER, name: "Dana" }]);
  await deps.siteStore.setActive("hilton-sydney", false);
  assert.equal((await deps.siteStore.findByRequesterPhone("agency", MANAGER)).length, 0);
});

test("requester phone numbers are normalized and deduped", async () => {
  const deps = buildDeps();
  const site = await deps.siteStore.setRequesters("hilton-sydney", [
    { phone: "+61 455 000 001", name: "Dana" },
    { phone: "61455000001", name: "Dana again" },
    { phone: "", name: "nobody" },
  ]);
  assert.deepEqual(site.requesters, [{ phone: "61455000001", name: "Dana" }]);
});
