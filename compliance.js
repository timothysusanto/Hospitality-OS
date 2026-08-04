"use strict";

const { slotWindow, mondayOf, normalizeAssignment } = require("./rosterStore");
const { localDateIso } = require("./availabilityBlocks");

/**
 * The compliance gate and the fortnight hours cap — build order step 5 of
 * docs/agencymodelshape.md.
 *
 * **A gate, not a display panel.** Everything here returns a block, and the
 * blast engine applies it to every wave including the urgent lane's last one.
 * A dashboard that shows an expired RSA in red while the person keeps getting
 * offered bar shifts has not solved anything.
 *
 * Data model:
 *   staff/{phone}.compliance = {
 *     rsa:    { ref?, expiresAt },
 *     police: { ref?, expiresAt },
 *     visa:   { type?, expiresAt, hoursCapPerFortnight? },
 *     ...any other document the agency tracks
 *   }
 *
 * ## Two rules, and why they're separate
 *
 * 1. **A document that exists and has expired blocks the person.** This needs no
 *    configuration to be correct: if the agency is tracking somebody's police
 *    check and it lapsed last week, placing them is the agency's liability.
 * 2. **A document a role requires and the person doesn't hold blocks that role.**
 *    This needs configuration, because only the agency knows that its clients
 *    demand an RSA for bar work. Configured per tenant; absent means rule 1 only.
 *
 * Keeping them apart matters: rule 1 must work on day one with no setup, and
 * rule 2 must never be the reason rule 1 didn't fire.
 *
 * ## The fortnight is rolling, and checked as a worst case
 *
 * A student visa's work limit is nominally per fixed fortnight. This enforces a
 * **rolling 14 days**, which is stricter: a person cannot straddle two fixed
 * fortnights to work double in eight days.
 *
 * Rolling has one trap, and it is worth spelling out because the obvious
 * implementation has it. Checking only the 14 days *ending when the new shift
 * ends* is leaky: with a 24h cap and 16h already booked on the 10th and 11th,
 * accepting the 13th passes (24h in its window), and then accepting the 12th
 * also passes, because the 13th sits outside *its* window. Four days, 32 hours,
 * cap intact.
 *
 * So `checkHoursCap` evaluates **every** 14-day window containing the new shift
 * and blocks on the worst one. Bookings on both sides of a shift count, order of
 * acceptance stops mattering, and there is no ordering of accepts that gets
 * somebody over the cap. The exposure is the agency's, carried across *all*
 * sites, so the conservative reading is the right one.
 */

/** How far ahead the compliance pipeline looks. */
const PIPELINE_DAYS = 30;

const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;

/** Reasons a placement is blocked. Machine-readable so messages stay in one place. */
const BLOCKS = {
  EXPIRED: "COMPLIANCE_EXPIRED",
  MISSING: "COMPLIANCE_MISSING",
  HOURS_CAP: "HOURS_CAP_EXCEEDED",
};

function asDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Every tracked document as {key, expiresAt, ...}, ignoring junk. */
function documentsOf(staff) {
  const compliance = (staff && staff.compliance) || {};
  const out = [];
  for (const [key, value] of Object.entries(compliance)) {
    if (!value || typeof value !== "object") continue;
    out.push({ key, ...value, expiresAt: asDate(value.expiresAt) });
  }
  return out;
}

/** Documents already expired at `at`. A document with no expiry never expires. */
function expiredDocuments(staff, at = new Date()) {
  return documentsOf(staff).filter((d) => d.expiresAt && d.expiresAt.getTime() <= at.getTime());
}

/** Documents lapsing within the horizon — the 30-day pipeline. */
function lapsingDocuments(staff, at = new Date(), days = PIPELINE_DAYS) {
  const horizon = at.getTime() + days * 24 * 60 * 60 * 1000;
  return documentsOf(staff)
    .filter((d) => d.expiresAt && d.expiresAt.getTime() > at.getTime() && d.expiresAt.getTime() <= horizon)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/**
 * Which documents a role requires, from the tenant's rules.
 * @param {object|null} rules tenant.complianceRules
 * @param {string|null} role
 * @returns {string[]}
 */
function requiredFor(rules, role) {
  if (!rules) return [];
  const all = Array.isArray(rules.requiredForAll) ? rules.requiredForAll : [];
  const byRole = (rules.requiredByRole && role) ? rules.requiredByRole[String(role).toLowerCase()] : null;
  return [...new Set([...all, ...(Array.isArray(byRole) ? byRole : [])])].map(String);
}

/**
 * The document half of the gate, for one person and one shift.
 *
 * Checked against the shift's **end**, not now: somebody whose visa expires
 * mid-shift cannot lawfully work the back half of it, and finding that out on
 * the day is worse than not offering it.
 *
 * @returns {{ok: boolean, reason?: string, details?: string[]}}
 */
function checkDocuments(staff, { role = null, endsAt = null, rules = null } = {}) {
  const at = asDate(endsAt) || new Date();

  const expired = expiredDocuments(staff, at);
  if (expired.length) {
    return {
      ok: false,
      reason: BLOCKS.EXPIRED,
      details: expired.map((d) => `${d.key} expired ${localDateIso(d.expiresAt)}`),
    };
  }

  const required = requiredFor(rules, role);
  if (required.length) {
    const held = new Set(documentsOf(staff).map((d) => d.key));
    const absent = required.filter((key) => !held.has(key));
    if (absent.length) {
      return { ok: false, reason: BLOCKS.MISSING, details: absent.map((k) => `no ${k}`) };
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------- hours ledger */

/**
 * Hours a person is already committed to in the fortnight ending at `until`,
 * across **all sites**. Both halves matter:
 *
 *   - worked shifts, from the shifts collection
 *   - future roster assignments, which is where an accepted offer lives
 *
 * A cap that only counted worked hours would let somebody accept four shifts in
 * one afternoon and blow through it before a single clock-in.
 *
 * Overlapping sources are the reason this is keyed by date and slot rather than
 * summed blindly: a rostered assignment that has already been clocked in against
 * would otherwise count twice.
 */
async function committedHoursByDate(tenantId, phone, from, to, deps) {
  const { shiftsStore, rosterStore } = deps;
  const start = asDate(from);
  const end = asDate(to);

  /** dateIso -> hours, so a worked shift supersedes its roster assignment. */
  const byDate = new Map();

  // Worked (or in-progress) shifts.
  const shifts = await shiftsStore.listRecentByTenant(tenantId, start.toISOString());
  for (const shift of shifts) {
    if (shift.staffPhone !== phone || !shift.clockIn) continue;
    if (shift.clockOut && shift.clockOut.denied) continue;
    const clockIn = asDate(shift.clockIn.time);
    if (!clockIn || clockIn < start || clockIn > end) continue;

    const clockOut = shift.clockOut ? asDate(shift.clockOut.time) : null;
    // An open shift counts as its rostered length so far, not zero.
    const hours = clockOut
      ? Math.max(0, (clockOut - clockIn) / 3600000)
      : Math.max(0, (Math.min(end.getTime(), Date.now()) - clockIn.getTime()) / 3600000);
    const dateIso = localDateIso(clockIn);
    byDate.set(dateIso, Math.max(byDate.get(dateIso) || 0, hours));
  }

  // Roster assignments — including anything accepted from a blast. Every week
  // the span touches, not just its ends: a 28-day span covers five.
  const weeks = new Set();
  for (let d = new Date(start.getTime()); d <= end; d.setDate(d.getDate() + 7)) {
    weeks.add(mondayOf(`${localDateIso(d)}T12:00:00`));
  }
  weeks.add(mondayOf(`${localDateIso(end)}T12:00:00`));
  for (const weekStart of weeks) {
    const week = await rosterStore.getWeek(tenantId, weekStart);
    for (const [dateIso, day] of Object.entries(week.assignments || {})) {
      const assignment = normalizeAssignment(day[phone]);
      if (!assignment) continue;
      const window = slotWindow(assignment.slot, dateIso);
      if (!window || window.startsAt < start || window.startsAt > end) continue;
      const hours = Math.max(0, (window.endsAt - window.startsAt) / 3600000);
      // Max, not sum: a clocked-in shift and its assignment are one shift.
      byDate.set(dateIso, Math.max(byDate.get(dateIso) || 0, hours));
    }
  }

  return byDate;
}

/**
 * Total committed hours in the fortnight ending at `until`. The reporting view —
 * "how much has this person worked lately". The *gate* uses the worst-window
 * check in checkHoursCap instead; see the note at the top of this file.
 */
async function committedHours(tenantId, phone, until, deps) {
  const end = asDate(until) || new Date();
  const start = new Date(end.getTime() - FORTNIGHT_MS);
  const byDate = await committedHoursByDate(tenantId, phone, start, end, deps);
  let total = 0;
  for (const hours of byDate.values()) total += hours;
  return Math.round(total * 100) / 100;
}

/**
 * The worst 14-day total among every window containing `dateIso`.
 * @param {Map<string, number>} byDate
 */
function worstWindowTotal(byDate, dateIso) {
  const dayMs = 24 * 60 * 60 * 1000;
  const anchor = new Date(`${dateIso}T12:00:00`).getTime();
  let worst = 0;

  // A window containing this date starts anywhere from 13 days before it to the
  // day itself. Fourteen candidate windows, evaluated over day buckets.
  for (let offset = 13; offset >= 0; offset--) {
    const windowStart = anchor - offset * dayMs;
    let total = 0;
    for (const [day, hours] of byDate) {
      const dayMid = new Date(`${day}T12:00:00`).getTime();
      if (dayMid >= windowStart && dayMid < windowStart + 14 * dayMs) total += hours;
    }
    if (total > worst) worst = total;
  }
  return Math.round(worst * 100) / 100;
}

/** The cap this person is subject to, or null if uncapped. */
function hoursCapOf(staff) {
  const visa = staff && staff.compliance && staff.compliance.visa;
  const cap = visa && Number(visa.hoursCapPerFortnight);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * The hours half of the gate. Only applies to somebody who has a cap — most
 * casuals don't.
 */
async function checkHoursCap(staff, request, deps) {
  const cap = hoursCapOf(staff);
  if (!cap) return { ok: true };

  const startsAt = new Date(request.startsAt);
  const endsAt = new Date(request.endsAt);
  const shiftHours = Math.max(0, (endsAt.getTime() - startsAt.getTime()) / 3600000);
  const shiftDate = localDateIso(startsAt);

  // Look 14 days either side, because a window containing this shift can reach
  // in both directions — see the note at the top of this file.
  const byDate = await committedHoursByDate(
    request.tenantId,
    staff.phone,
    new Date(startsAt.getTime() - FORTNIGHT_MS),
    new Date(startsAt.getTime() + FORTNIGHT_MS),
    deps
  );

  // Add this shift to its own day, unless the day is already accounted for by an
  // assignment or a worked shift (accepting twice must not double-count).
  const withShift = new Map(byDate);
  withShift.set(shiftDate, Math.max(byDate.get(shiftDate) || 0, shiftHours));

  const worst = worstWindowTotal(withShift, shiftDate);
  const committed = worstWindowTotal(byDate, shiftDate);

  if (worst > cap) {
    return {
      ok: false,
      reason: BLOCKS.HOURS_CAP,
      details: [
        `${worst.toFixed(1)}h in the worst 14-day window with this shift > ${cap}h cap ` +
          `(${committed.toFixed(1)}h already committed)`,
      ],
      committed,
      worst,
      cap,
    };
  }
  return { ok: true, committed, worst, cap };
}

/**
 * The whole gate for one person and one request. Used twice on purpose:
 * once when building a wave, and again at the moment somebody accepts —
 * compliance can lapse in the two hours between a planned blast going out and
 * a reply coming back.
 */
async function checkPlacement(staff, request, deps, rules = null) {
  const docs = checkDocuments(staff, { role: request.role, endsAt: request.endsAt, rules });
  if (!docs.ok) return docs;
  return checkHoursCap(staff, request, deps);
}

/**
 * Filters a candidate pool down to who may lawfully be placed. Applied to every
 * wave tier, including the urgent lane's "everyone" — being short-staffed is
 * never a reason to place somebody the agency isn't allowed to place.
 *
 * Logs what it removed and why, because a blast that silently reaches nobody is
 * indistinguishable from a broken one.
 */
async function filterPlaceable(pool, request, deps, rules = null) {
  const allowed = [];
  const blocked = [];
  for (const staff of pool) {
    const check = await checkPlacement(staff, request, deps, rules);
    if (check.ok) allowed.push(staff);
    else blocked.push({ phone: staff.phone, name: staff.name, reason: check.reason, details: check.details });
  }
  if (blocked.length) {
    const summary = blocked.reduce((acc, b) => {
      acc[b.reason] = (acc[b.reason] || 0) + 1;
      return acc;
    }, {});
    console.log(
      `[compliance] ${request.ref || request.requestId}: excluded ${blocked.length} — ` +
        Object.entries(summary).map(([r, n]) => `${r}×${n}`).join(", ")
    );
  }
  return { allowed, blocked };
}

/**
 * The 30-day pipeline: who lapses soon, and how many placements that endangers.
 * A report, but the numbers come from the same functions the gate uses, so it
 * can never disagree with what actually blocks.
 */
async function compliancePipeline(tenantId, deps, at = new Date(), days = PIPELINE_DAYS) {
  const { staffStore, rosterStore } = deps;
  const staff = await staffStore.listByTenant(tenantId);

  const horizon = new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
  const weeks = new Set();
  for (let d = new Date(at.getTime()); d <= horizon; d.setDate(d.getDate() + 7)) {
    weeks.add(mondayOf(`${localDateIso(d)}T12:00:00`));
  }
  weeks.add(mondayOf(`${localDateIso(horizon)}T12:00:00`));

  // Upcoming assignments per person, so "endangers N placements" is real.
  const upcoming = new Map();
  for (const weekStart of weeks) {
    const week = await rosterStore.getWeek(tenantId, weekStart);
    for (const [dateIso, day] of Object.entries(week.assignments || {})) {
      for (const [phone, raw] of Object.entries(day)) {
        const assignment = normalizeAssignment(raw);
        if (!assignment) continue;
        const window = slotWindow(assignment.slot, dateIso);
        if (!window || window.startsAt < at || window.startsAt > horizon) continue;
        if (!upcoming.has(phone)) upcoming.set(phone, []);
        upcoming.get(phone).push({ dateIso, slot: assignment.slot, siteId: assignment.siteId });
      }
    }
  }

  const rows = [];
  for (const person of staff) {
    const expired = expiredDocuments(person, at);
    const lapsing = lapsingDocuments(person, at, days);
    if (!expired.length && !lapsing.length) continue;

    const theirShifts = upcoming.get(person.phone) || [];
    // A placement is only endangered if it falls after the document lapses.
    const earliest = [...expired, ...lapsing].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    const endangered = theirShifts.filter((s) => {
      const window = slotWindow(s.slot, s.dateIso);
      return window && window.endsAt > earliest.expiresAt;
    });

    rows.push({
      phone: person.phone,
      name: person.name,
      blockedNow: expired.length > 0,
      documents: [...expired, ...lapsing].map((d) => ({
        key: d.key,
        expiresAt: d.expiresAt.toISOString(),
        expired: d.expiresAt <= at,
      })),
      endangeredPlacements: endangered.length,
      nextExpiry: earliest.expiresAt.toISOString(),
    });
  }

  // Blocked now first, then soonest to lapse.
  rows.sort((a, b) =>
    (Number(b.blockedNow) - Number(a.blockedNow)) || (a.nextExpiry < b.nextExpiry ? -1 : 1)
  );
  return rows;
}

/** Staff-facing wording. Never names the client, and never lists a document to a third party. */
function describeBlock(check) {
  switch (check.reason) {
    case BLOCKS.EXPIRED:
      return "One of your compliance documents has expired, so I can't offer you shifts until it's renewed. Your coordinator will be in touch.";
    case BLOCKS.MISSING:
      return "That shift needs a document we don't have on file for you yet. Talk to your coordinator and we'll get you on the list.";
    case BLOCKS.HOURS_CAP:
      return "That shift would take you over your fortnightly hours limit, so I can't book you in for it.";
    default:
      return "I can't book you onto that shift at the moment — please check with your coordinator.";
  }
}

/** Coerces an API body into a storable compliance map. */
function normalizeCompliance(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const cleanKey = String(key).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!cleanKey) continue;
    const expiresAt = asDate(value.expiresAt);
    const entry = {};
    if (expiresAt) entry.expiresAt = expiresAt.toISOString();
    if (value.ref) entry.ref = String(value.ref).trim();
    if (value.type) entry.type = String(value.type).trim();
    const cap = Number(value.hoursCapPerFortnight);
    if (Number.isFinite(cap) && cap > 0) entry.hoursCapPerFortnight = cap;
    // A document with nothing on it is not a document.
    if (Object.keys(entry).length) out[cleanKey] = entry;
  }
  return out;
}

module.exports = {
  checkDocuments,
  checkHoursCap,
  checkPlacement,
  filterPlaceable,
  committedHours,
  committedHoursByDate,
  worstWindowTotal,
  compliancePipeline,
  documentsOf,
  expiredDocuments,
  lapsingDocuments,
  requiredFor,
  hoursCapOf,
  describeBlock,
  normalizeCompliance,
  BLOCKS,
  PIPELINE_DAYS,
  FORTNIGHT_MS,
};
