"use strict";

const { sendText } = require("./whatsapp");
const { seatsRemaining, isLive, LANES } = require("./requestsStore");
const { responseSeconds } = require("./offersStore");
const { rankStaff } = require("./reliability");
const { canWorkRole } = require("./store");
const { slotWindow, windowsOverlap, mondayOf } = require("./rosterStore");
const { sweepWeeklyPings } = require("./availabilityCapture");
const { filterPlaceable, checkPlacement, describeBlock } = require("./compliance");

/**
 * The blast engine — build order step 2 of docs/agencymodelshape.md.
 *
 * **One engine, configured twice.** Waves, an atomic first-come claim,
 * auto-expiry and response timing are built once; the planned and urgent lanes
 * are the same machine with different dials. The dials are WAVE_PLANS below and
 * they are a direct transcription of the design note's dispatch table.
 *
 * ## Why a tick loop and not timers
 *
 * The obvious implementation is a setTimeout per wave. It is also wrong here: a
 * Railway redeploy mid-blast would drop every pending timer and abandon
 * half-filled requests with nobody watching. Instead all dispatch state lives
 * on the request document (`wave`, `waveSentAt`) and `tick()` recomputes what
 * should happen from that state on every pass. A restart loses at most one tick
 * interval, and a tick is idempotent.
 *
 * ## What the waves actually reach today
 *
 * Wave tiers name audiences that don't fully exist until step 3 (weekly
 * availability and the free-today pool). Until then `available` and `freeToday`
 * resolve empty, and an empty wave is skipped immediately rather than burning
 * its accept window on nobody — so today a planned blast effectively starts at
 * "everyone not already booked, ranked by reliability", and narrows on its own
 * once step 3 lands. Compliance filtering is step 5 and is not applied yet.
 */

/** Grace after a shift has started before a request is given up on. */
const ABANDON_AFTER_START_MS = 30 * 60 * 1000;

/** How long after a rostered start with no clock-in counts as a no-show. */
const NO_SHOW_AFTER_MS = 15 * 60 * 1000;

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

/**
 * The dials. One entry per wave, in order.
 *   tier           — which audience this wave reaches (see audienceFor)
 *   acceptWindowMs — how long before the wave is expired and the next one goes
 *   flagUrgent     — mark the message as urgent in the text
 */
const WAVE_PLANS = {
  [LANES.PLANNED]: [
    { tier: "available", acceptWindowMs: 2 * HOURS },
    { tier: "unknown", acceptWindowMs: 2 * HOURS },
  ],
  [LANES.URGENT]: [
    { tier: "freeToday", acceptWindowMs: 10 * MINUTES },
    { tier: "unknown", acceptWindowMs: 10 * MINUTES },
    { tier: "all", acceptWindowMs: 20 * MINUTES, flagUrgent: true },
  ],
};

function planFor(lane) {
  return WAVE_PLANS[lane] || WAVE_PLANS[LANES.PLANNED];
}

/* ------------------------------------------------------------------ helpers */

function localDateIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtWhen(startsAt, endsAt) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const day = start.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const t = (d) => d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${t(start)}–${t(end)}`;
}

/** The dates a shift window touches, so an overnight shift checks both days. */
function datesTouched(startsAt, endsAt) {
  const dates = new Set([localDateIso(new Date(startsAt))]);
  dates.add(localDateIso(new Date(endsAt)));
  return [...dates];
}

/**
 * Everyone already committed during a request's window.
 *
 * **The roster is the only availability data that's never wrong.** Whoever is
 * already booked is known with certainty, so this is a hard negative filter on
 * both lanes rather than a ranking signal. On a day with 120 people working
 * that removes 40% of the pool with zero guessing.
 */
async function bookedPhones(request, deps) {
  const { rosterStore, shiftsStore } = deps;
  const booked = new Set();
  const window = { startsAt: new Date(request.startsAt), endsAt: new Date(request.endsAt) };

  for (const dateIso of datesTouched(request.startsAt, request.endsAt)) {
    const week = await rosterStore.getWeek(request.tenantId, mondayOf(dateIso + "T12:00:00"));
    const day = (week.assignments || {})[dateIso];
    if (!day) continue;
    for (const [phone, raw] of Object.entries(day)) {
      const assignment = typeof raw === "string" ? { slot: raw } : raw;
      const other = slotWindow(assignment && assignment.slot, dateIso);
      // An unreadable slot still means somebody wrote something in that cell —
      // treat it as booked rather than risk double-booking a real person.
      if (!other || windowsOverlap(window, other)) booked.add(phone);
    }
  }

  // Anyone currently clocked in is busy regardless of what the roster says.
  const open = await shiftsStore.listOpenByTenant(request.tenantId);
  for (const shift of open) booked.add(shift.staffPhone);

  return booked;
}

/**
 * Who a given wave tier reaches, before the booked and already-offered filters.
 *
 * The tiers map onto availability's three states:
 *
 *   available — said yes to this block. Wave 1 of the planned lane.
 *   freeToday — opted into today's pool. Wave 1 of the urgent lane.
 *   unknown   — we have no answer from them for this block. Wave 2 of both.
 *   all       — everybody, including people who said no. Urgent wave 3 only,
 *               where a hotel is short in an hour and asking anyway is fair.
 *
 * `unknown` deliberately excludes people who declared themselves unavailable.
 * They answered; blasting them again is how a casual pool learns to ignore the
 * messages. Only the urgent lane's last wave overrides that, and it says so in
 * the message.
 *
 * Returns null when an audience cannot be determined at all — a store that
 * isn't configured. The caller treats that as an empty wave and skips it, which
 * is different from `[]` meaning "nobody qualifies".
 *
 * @returns {Promise<object[]|null>}
 */
async function audienceFor(tier, request, deps) {
  const { staffStore, availabilityStore, freeTodayStore } = deps;
  const roster = await staffStore.listByTenant(request.tenantId);
  // Access level, not job title: owners and managers aren't in the labour pool
  // unless they've been given job roles explicitly.
  const pool = roster.filter((s) => canWorkRole(s, request.role));

  if (tier === "all") return pool;

  if (tier === "unknown") {
    // Without an availability store nobody has answered anything, so unknown is
    // the whole pool — which is exactly right.
    if (!availabilityStore || !availabilityStore.filterUnknown) return pool;
    return availabilityStore.filterUnknown(pool, request);
  }

  if (tier === "available") {
    if (!availabilityStore || !availabilityStore.filterAvailable) return null;
    return availabilityStore.filterAvailable(pool, request);
  }

  if (tier === "freeToday") {
    if (!freeTodayStore || !freeTodayStore.filterFreeToday) return null;
    return freeTodayStore.filterFreeToday(pool, request);
  }

  return null;
}

/**
 * The tenant's compliance rules, or null.
 *
 * A failed lookup returns null rather than throwing, which leaves rule 1 —
 * anybody holding an expired document is blocked — fully in force. That rule
 * needs no configuration to be correct, which is exactly why it is separate
 * from the role requirements this function fetches.
 */
async function complianceRulesFor(tenantId, deps) {
  const { tenantStore } = deps;
  if (!tenantStore) return null;
  try {
    const tenant = await tenantStore.findById(tenantId);
    return (tenant && tenant.complianceRules) || null;
  } catch (err) {
    console.error("[compliance] couldn't read rules:", err.message);
    return null;
  }
}

function offerText(request, wave, plan) {
  const lines = [
    `${request.role ? request.role : "Shift"} — ${request.siteName || request.siteId}`,
    fmtWhen(request.startsAt, request.endsAt),
    "",
    `Reply YES ${request.ref} to take it, or NO to pass.`,
  ];
  if (plan.flagUrgent) lines.unshift("⚡ URGENT — needed now");
  return lines.join("\n");
}

/* ------------------------------------------------------------------- engine */

/**
 * Sends one wave. Returns the number of people notified — 0 means the audience
 * was empty and the caller should move straight on.
 */
async function sendWave(request, waveNumber, deps, sendOpts = {}) {
  const { staffStore, offersStore, requestsStore } = deps;
  const plan = planFor(request.lane)[waveNumber - 1];
  if (!plan) return 0;

  const audience = await audienceFor(plan.tier, request, deps);
  if (audience == null) {
    console.log(
      `[dispatch] ${request.ref} wave ${waveNumber} (${plan.tier}) has no data source yet — skipping`
    );
    return 0;
  }

  const [booked, alreadyOffered] = await Promise.all([
    bookedPhones(request, deps),
    offersStore.phonesOfferedFor(request.requestId),
  ]);

  const free = audience.filter(
    (s) => !booked.has(s.phone) && !alreadyOffered.has(s.phone)
  );

  // The compliance gate, applied to every tier including the urgent lane's
  // "everyone". Being short-staffed is never a reason to place somebody the
  // agency isn't allowed to place.
  const rules = await complianceRulesFor(request.tenantId, deps);
  const { allowed: candidates } = await filterPlaceable(free, request, deps, rules);

  if (!candidates.length) {
    console.log(
      `[dispatch] ${request.ref} wave ${waveNumber} (${plan.tier}): nobody left after ` +
        `booked(${booked.size}), already-offered(${alreadyOffered.size}) and compliance filters`
    );
    return 0;
  }

  // Wave 1 of the planned lane ranks by reliability; the urgent lane ranks by
  // response speed. Same list, different question.
  const ranked = rankStaff(candidates, request.lane);
  const phones = ranked.map((s) => s.phone);

  const offers = await offersStore.createMany(phones, {
    tenantId: request.tenantId,
    requestId: request.requestId,
    requestRef: request.ref,
    wave: waveNumber,
  });

  await requestsStore.setDispatchState(request.requestId, {
    wave: waveNumber,
    waveSentAt: new Date().toISOString(),
  });

  const body = offerText(request, waveNumber, plan);
  // Batched, because wave 3 of an urgent blast can touch the whole pool and
  // sequential sends would outlast the accept window.
  const BATCH = 10;
  for (let i = 0; i < offers.length; i += BATCH) {
    await Promise.all(
      offers.slice(i, i + BATCH).map(async (offer) => {
        try {
          await sendText(offer.phone, body, sendOpts);
          await staffStore.recordOfferSent(offer.phone);
        } catch (err) {
          console.error(`[dispatch] offer ${offer.offerId} send failed:`, err.message);
        }
      })
    );
  }

  console.log(
    `[dispatch] ${request.ref} wave ${waveNumber} (${plan.tier}): ${phones.length} notified`
  );
  await notifyRequester(
    request,
    `Searching — ${phones.length} ${phones.length === 1 ? "person" : "people"} notified.`,
    deps,
    sendOpts
  );
  return phones.length;
}

/**
 * Advances a request as far as it should go right now. Called per request per
 * tick, and safe to call repeatedly.
 */
async function advance(request, deps, sendOpts = {}, now = new Date()) {
  const { requestsStore, offersStore } = deps;
  const plan = planFor(request.lane);

  if (!isLive(request) || !request.confirmedAt) return request;

  // Past the point of usefulness: the shift has started and is still short.
  if (now.getTime() - new Date(request.startsAt).getTime() > ABANDON_AFTER_START_MS) {
    await offersStore.expirePending(request.requestId);
    const outcome = request.filled > 0 ? "partial" : "unfilled";
    const closed = await requestsStore.close(request.requestId, outcome);
    console.warn(
      `[dispatch] ${request.ref} abandoned as ${outcome} — ${request.filled}/${request.headcount} filled`
    );
    await notifyRequester(
      request,
      request.filled > 0
        ? `Couldn't fill all of ${request.ref}: ${request.filled} of ${request.headcount} confirmed.`
        : `Couldn't fill ${request.ref}. Nobody was available — call us and we'll work it out.`,
      deps,
      sendOpts
    );
    return closed;
  }

  const currentWave = request.wave || 0;

  // Nothing sent yet, or the window on the last wave has closed. An empty wave
  // returns 0 and we keep walking the plan in the same tick, so a lane whose
  // early tiers have no data source yet doesn't sit idle for two hours.
  const currentPlan = currentWave > 0 ? plan[currentWave - 1] : null;
  const windowElapsed =
    Boolean(currentPlan) &&
    Boolean(request.waveSentAt) &&
    now.getTime() - new Date(request.waveSentAt).getTime() >= currentPlan.acceptWindowMs;

  if (currentWave > 0 && !windowElapsed) return request;

  if (currentWave > 0) {
    // The window closed on people who never answered. Their offers expire with
    // respondedAt left null — a non-response is not a response time.
    await offersStore.expirePending(request.requestId);
  }

  let wave = currentWave;
  let sent = 0;
  while (wave < plan.length && sent === 0) {
    wave += 1;
    sent = await sendWave(request, wave, deps, sendOpts);
  }

  if (sent === 0) {
    // Every remaining wave reached nobody. Stop rather than spin on each tick.
    const outcome = request.filled > 0 ? "partial" : "unfilled";
    await requestsStore.close(request.requestId, outcome);
    console.warn(`[dispatch] ${request.ref} exhausted every wave — closing as ${outcome}`);
    await notifyRequester(
      request,
      request.filled > 0
        ? `${request.ref}: ${request.filled} of ${request.headcount} confirmed, no one else available.`
        : `Couldn't fill ${request.ref} — nobody available. Call us and we'll work it out.`,
      deps,
      sendOpts
    );
    return requestsStore.findById(request.requestId);
  }

  return requestsStore.findById(request.requestId);
}

/**
 * Somebody said yes. The atomic first-come claim is the whole point of this
 * function, and the ordering matters:
 *
 *   1. Claim the seat first. If it's gone, the person loses the race and is
 *      told so — recorded as `lost`, never `declined`, because answering fast
 *      and losing makes them one of your better people.
 *   2. Then resolve the offer. If that fails, this was a duplicate "yes" and
 *      the seat we just took is handed back.
 *
 * Doing it the other way round would mark the offer accepted and then discover
 * there was no seat, leaving a person who thinks they have a shift.
 *
 * @returns {Promise<{ok: boolean, reason?: string, request?: object}>}
 */
async function acceptOffer(offer, staff, deps, sendOpts = {}) {
  const { requestsStore, offersStore, staffStore, rosterStore } = deps;

  // Re-check the gate at claim time. A planned blast's accept window is two
  // hours; a document can lapse inside it, and the hours cap can be used up by
  // another shift accepted in the meantime. Checked before the seat is taken so
  // a blocked person never briefly holds one.
  const pending = await requestsStore.findById(offer.requestId);
  if (pending) {
    const rules = await complianceRulesFor(pending.tenantId, deps);
    const gate = await checkPlacement(staff, pending, deps, rules);
    if (!gate.ok) {
      await offersStore.respond(offer.offerId, "declined");
      console.warn(
        `[compliance] ${staff.phone} blocked from ${pending.ref} at accept: ` +
          `${gate.reason} (${(gate.details || []).join("; ")})`
      );
      return { ok: false, reason: gate.reason, request: pending, message: describeBlock(gate) };
    }
  }

  const claim = await requestsStore.claimSeat(offer.requestId);
  if (!claim.claimed) {
    const resolved = await offersStore.respond(offer.offerId, "lost");
    if (resolved) {
      await staffStore.recordOfferAnswered(offer.phone, {
        accepted: false,
        responseSec: responseSeconds(resolved),
      });
    }
    return { ok: false, reason: claim.reason, request: claim.request };
  }

  const resolved = await offersStore.respond(offer.offerId, "accepted");
  if (!resolved) {
    // A second "yes" for an offer already resolved. Give the seat back.
    await requestsStore.releaseSeat(offer.requestId);
    return { ok: false, reason: "OFFER_ALREADY_RESOLVED", request: claim.request };
  }

  await staffStore.recordOfferAnswered(offer.phone, {
    accepted: true,
    responseSec: responseSeconds(resolved),
  });

  const request = claim.request;

  // Booking them onto the roster is what turns an accepted offer into a shift
  // the rest of the system understands: the clock-in geofence resolves the site
  // from this assignment (siteResolver.js), the "roster" command shows it, and
  // the no-show sweep watches it.
  const dateIso = localDateIso(new Date(request.startsAt));
  const start = new Date(request.startsAt);
  const end = new Date(request.endsAt);
  const hhmm = (d) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  await rosterStore.setAssignment(request.tenantId, dateIso, offer.phone, {
    slot: `${hhmm(start)}-${hhmm(end)}`,
    siteId: request.siteId,
  });

  // The last seat just went — nobody else can accept, so stop their clocks.
  if (seatsRemaining(request) === 0) {
    await offersStore.expirePending(request.requestId);
  }

  await notifyFillProgress(request, staff, deps, sendOpts);
  return { ok: true, request };
}

async function declineOffer(offer, deps) {
  const { offersStore, staffStore } = deps;
  const resolved = await offersStore.respond(offer.offerId, "declined");
  if (!resolved) return null;
  // A decline still proves they read their messages, so it feeds the median.
  await staffStore.recordOfferAnswered(offer.phone, {
    accepted: false,
    responseSec: responseSeconds(resolved),
  });
  return resolved;
}

/* ------------------------------------------------- status back to the hotel */

async function notifyRequester(request, body, deps, sendOpts = {}) {
  if (!request.requestedBy) return;
  try {
    await sendText(request.requestedBy, body, sendOpts);
  } catch (err) {
    console.error(`[dispatch] couldn't update requester for ${request.ref}:`, err.message);
  }
}

async function notifyFillProgress(request, staff, deps, sendOpts = {}) {
  const name = staff && staff.name ? staff.name : "Someone";
  const body =
    seatsRemaining(request) === 0
      ? `All ${request.headcount} confirmed for ${request.ref}. ${name} joins them.`
      : `${request.filled} of ${request.headcount} filled for ${request.ref}: ${name}.`;
  await notifyRequester(request, body, deps, sendOpts);
}

/* --------------------------------------------------------- auto-backfill */

/**
 * **Auto-backfill closes the loop.** No clock-in fifteen minutes after a shift
 * starts fires the urgent blast on its own and tells the operator it's already
 * running: the supervisor notices the gap at 7:15am, the replacement was
 * accepted at 7:04.
 *
 * This falls out of step 1 almost free — the roster assignment already names
 * the site and the window, which is everything a replacement request needs.
 *
 * Deduped on a stable key, so a tick every thirty seconds can't fire the same
 * backfill twice.
 */
async function sweepNoShows(tenantId, deps, sendOpts = {}, now = new Date()) {
  const { rosterStore, shiftsStore, requestsStore, siteStore, staffStore } = deps;
  const created = [];

  // Yesterday too, so a night shift that started at 22:00 is still watched
  // after midnight.
  const dates = [localDateIso(now)];
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  dates.push(localDateIso(yesterday));

  const shifts = await shiftsStore.listRecentByTenant(
    tenantId,
    new Date(now.getTime() - 36 * HOURS).toISOString()
  );

  for (const dateIso of dates) {
    const week = await rosterStore.getWeek(tenantId, mondayOf(dateIso + "T12:00:00"));
    const day = (week.assignments || {})[dateIso];
    if (!day) continue;

    for (const [phone, raw] of Object.entries(day)) {
      const assignment = typeof raw === "string" ? { slot: raw, siteId: null } : raw;
      const window = slotWindow(assignment && assignment.slot, dateIso);
      if (!window) continue;

      const dueMs = window.startsAt.getTime() + NO_SHOW_AFTER_MS;
      if (now.getTime() < dueMs) continue;
      // Don't keep re-checking shifts that ended hours ago.
      if (now.getTime() > window.endsAt.getTime()) continue;

      // Did they turn up? Any shift that started within this window counts,
      // including one flagged for review — they're on site either way.
      const turnedUp = shifts.some(
        (s) =>
          s.staffPhone === phone &&
          s.clockIn &&
          new Date(s.clockIn.time) >= new Date(window.startsAt.getTime() - 2 * HOURS) &&
          new Date(s.clockIn.time) <= window.endsAt
      );
      if (turnedUp) continue;

      const backfillFor = `${dateIso}:${phone}:${assignment.siteId || "no-site"}`;
      const existing = await requestsStore.findByBackfillKey(tenantId, backfillFor);
      if (existing) continue;

      const site = assignment.siteId ? await siteStore.findById(assignment.siteId) : null;
      const absentee = await staffStore.findByPhone(phone);
      const request = await requestsStore.create({
        tenantId,
        siteId: assignment.siteId,
        siteName: site ? site.name : null,
        role: absentee ? (absentee.department || null) : null,
        // A replacement is needed from now, not from the start they missed —
        // which also makes the derived lane urgent, without declaring it.
        startsAt: now.toISOString(),
        endsAt: window.endsAt.toISOString(),
        headcount: 1,
        now,
        backfillFor,
      });

      // The absentee stays on the roster. Removing them would erase the fact
      // that they no-showed, which is exactly what reliability needs to record.
      await staffStore.recordShiftResult(phone, { noShow: true });

      console.warn(
        `[backfill] ${absentee ? absentee.name : phone} hasn't clocked in for ` +
          `${assignment.slot} at ${site ? site.name : "unknown site"} — blasting ${request.ref}`
      );
      created.push(request);
    }
  }

  return created;
}

/* ----------------------------------------------------------------- the tick */

/**
 * One pass over everything that needs deciding. Idempotent, so it doesn't
 * matter if a tick is late, early, or repeated after a restart.
 */
async function tick(tenantId, deps, sendOpts = {}, now = new Date()) {
  const { requestsStore } = deps;
  const backfilled = await sweepNoShows(tenantId, deps, sendOpts, now).catch((err) => {
    console.error("[backfill] sweep failed:", err);
    return [];
  });

  // Ask Wednesday, chase Friday. Idempotent, so running it on every tick all
  // Wednesday pings each person exactly once.
  const pinged = await sweepWeeklyPings(tenantId, deps, sendOpts, now).catch((err) => {
    console.error("[availability] ping sweep failed:", err);
    return { asked: 0, chased: 0 };
  });

  const open = await requestsStore.listOpen(tenantId);
  for (const request of open) {
    try {
      await advance(request, deps, sendOpts, now);
    } catch (err) {
      console.error(`[dispatch] ${request.ref} failed to advance:`, err);
    }
  }
  return {
    advanced: open.length,
    backfilled: backfilled.length,
    asked: pinged.asked,
    chased: pinged.chased,
  };
}

/**
 * The loop. `intervalMs` is a floor on responsiveness, not a schedule: every
 * decision is derived from timestamps, so a slow tick delays a wave rather
 * than skipping it.
 */
function createDispatcher(tenantId, deps, sendOpts = {}, intervalMs = 30 * 1000) {
  let timer = null;
  let running = false;

  async function runOnce(now = new Date()) {
    if (running) return null; // never overlap two passes
    running = true;
    try {
      return await tick(tenantId, deps, sendOpts, now);
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        runOnce().catch((err) => console.error("[dispatch] tick failed:", err));
      }, intervalMs);
      // Don't hold the process open on shutdown.
      if (timer.unref) timer.unref();
      console.log(`[dispatch] blast engine running every ${Math.round(intervalMs / 1000)}s`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  createDispatcher,
  tick,
  advance,
  sendWave,
  acceptOffer,
  declineOffer,
  sweepNoShows,
  bookedPhones,
  audienceFor,
  WAVE_PLANS,
  NO_SHOW_AFTER_MS,
  ABANDON_AFTER_START_MS,
};
