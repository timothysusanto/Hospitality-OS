"use strict";

const { LANES } = require("./requestsStore");
const { responseSeconds } = require("./offersStore");
const { normalizeReliability, showRate, medianOf } = require("./reliability");
const { summarize, workedHours } = require("./margin");
const { isSubmitted, declaredCellCount } = require("./availabilityStore");
const {
  BLOCKS, blockFor, weekDates, weekStartOf, localDateIso,
} = require("./availabilityBlocks");
const { slotWindow, normalizeAssignment, mondayOf } = require("./rosterStore");

/**
 * Reporting — build order step 7 of docs/agencymodelshape.md. Last, because it
 * is mostly free by now: every number here is read off data the earlier steps
 * already had to record.
 *
 * ## Every number splits by lane
 *
 * **Blending planned and urgent hides both.** A planned miss is an ops failure;
 * an urgent miss is a supply problem, and they have different fixes. Reported
 * apart, the urgent column becomes a sales asset you can price against.
 *
 * ## Nothing here recomputes a rule
 *
 * Fill rate reads `outcome`, response latency reads the offer timestamps, margin
 * calls the same `summarize` the gate-adjacent report uses. A report that
 * re-derives a rule eventually disagrees with the thing that enforced it, and
 * then nobody trusts either.
 *
 * ## Denominators are stated, not assumed
 *
 * Every rate returns its numerator and denominator alongside the percentage, and
 * a percentage is `null` rather than 0 when there is nothing to divide by. "0%
 * fill rate" and "no requests yet" look identical otherwise, and only one of
 * them is a problem.
 */

const LANE_KEYS = [LANES.PLANNED, LANES.URGENT];

function pctOf(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function emptyRate() {
  return { requested: 0, filled: 0, requests: 0, fullyFilled: 0, pct: null, seatPct: null };
}

/**
 * **Fill rate** — the headline number, per lane.
 *
 * Reported two ways because they answer different questions: `seatPct` is what
 * share of the seats you asked for got filled, and `pct` is what share of
 * requests were filled completely. A hotel that wanted four and got three cares
 * about the second; a supply planner cares about the first.
 *
 * Cancelled requests are excluded from both — a hotel changing its mind is
 * neither a hit nor a miss, and counting it either way distorts the number.
 */
function fillRate(requests) {
  const out = { total: emptyRate() };
  for (const lane of LANE_KEYS) out[lane] = emptyRate();

  for (const request of requests) {
    if (request.outcome === "cancelled") continue;
    // Still searching: not yet an outcome.
    if (request.outcome === "open") continue;
    const buckets = [out.total, out[request.lane]].filter(Boolean);
    for (const b of buckets) {
      b.requests += 1;
      b.requested += request.headcount || 0;
      b.filled += request.filled || 0;
      if ((request.filled || 0) >= (request.headcount || 0)) b.fullyFilled += 1;
    }
  }

  for (const key of ["total", ...LANE_KEYS]) {
    const b = out[key];
    if (!b) continue;
    b.pct = pctOf(b.fullyFilled, b.requests);
    b.seatPct = pctOf(b.filled, b.requested);
  }
  return out;
}

/**
 * **Time to fill** — median minutes from confirmation to filled.
 *
 * Measured from `confirmedAt`, not `createdAt`: the clock a hotel judges you on
 * starts when they confirmed the order, and time spent waiting for them to reply
 * to the read-back is not yours. Only fully-filled requests count — a partial
 * fill has no "filled at" moment, and including it would flatter the median.
 *
 * *"87% of same-day filled, median 34 minutes"* is the pitch this builds.
 */
function timeToFill(requests) {
  const byLane = {};
  for (const lane of LANE_KEYS) byLane[lane] = [];

  for (const request of requests) {
    if (request.outcome !== "filled" || !request.filledAt) continue;
    const from = request.confirmedAt || request.createdAt;
    if (!from) continue;
    const minutes = (new Date(request.filledAt) - new Date(from)) / 60000;
    if (minutes < 0) continue; // clock skew
    if (byLane[request.lane]) byLane[request.lane].push(minutes);
  }

  const out = {};
  for (const lane of LANE_KEYS) {
    const samples = byLane[lane];
    out[lane] = {
      n: samples.length,
      medianMinutes: samples.length ? Math.round(medianOf(samples.map((m) => Math.round(m)))) : null,
      p90Minutes: samples.length ? percentile(samples, 90) : null,
      fastestMinutes: samples.length ? Math.round(Math.min(...samples)) : null,
    };
  }
  return out;
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]);
}

/**
 * **Lost demand** — requests declined or unfilled, by site and by hour.
 *
 * Invisible today because a phone call leaves no trace, which is the whole
 * argument for chat intake. Bucketed by the hour the shift *starts*, because
 * that is the shape of the gap: "we can never fill 6am Saturdays" is actionable
 * in a way that a daily total isn't.
 */
function lostDemand(requests) {
  const bySite = {};
  const byHour = Array.from({ length: 24 }, () => ({ requests: 0, seats: 0 }));
  let seatsLost = 0;

  for (const request of requests) {
    if (!["unfilled", "partial"].includes(request.outcome)) continue;
    const missed = Math.max(0, (request.headcount || 0) - (request.filled || 0));
    if (!missed) continue;
    seatsLost += missed;

    const key = request.siteId || "no-site";
    if (!bySite[key]) {
      bySite[key] = { siteId: key, siteName: request.siteName || null, requests: 0, seatsLost: 0, byLane: { planned: 0, urgent: 0 } };
    }
    bySite[key].requests += 1;
    bySite[key].seatsLost += missed;
    if (bySite[key].byLane[request.lane] !== undefined) bySite[key].byLane[request.lane] += missed;

    const hour = new Date(request.startsAt).getHours();
    byHour[hour].requests += 1;
    byHour[hour].seats += missed;
  }

  return {
    seatsLost,
    bySite: Object.values(bySite).sort((a, b) => b.seatsLost - a.seatsLost),
    byHour,
  };
}

/**
 * **Reliability** and **response latency**, per person.
 *
 * Offered, accepted, showed, late, no-showed, and the median seconds to answer
 * an offer. These are the numbers that feed wave-1 ranking, so this report is
 * the same data the engine ranks on rather than a parallel calculation.
 */
function reliabilityReport(staff) {
  return staff
    .map((person) => {
      const r = normalizeReliability(person.reliability);
      return {
        phone: person.phone,
        name: person.name,
        offered: r.offered,
        accepted: r.accepted,
        acceptRatePct: pctOf(r.accepted, r.offered),
        showed: r.showed,
        late: r.late,
        noShow: r.noShow,
        showRatePct: (() => {
          const rate = showRate(r);
          return rate == null ? null : Math.round(rate * 1000) / 10;
        })(),
        medianResponseSec: r.medianResponseSec,
        answers: r.recentResponseSecs.length,
      };
    })
    // Fastest answerers first among people with history — your genuine top staff.
    .sort((a, b) => {
      if ((a.medianResponseSec == null) !== (b.medianResponseSec == null)) {
        return a.medianResponseSec == null ? 1 : -1;
      }
      return (a.medianResponseSec || 0) - (b.medianResponseSec || 0);
    });
}

/**
 * **Supply vs demand**, as a 7 × 3 grid.
 *
 * Declared headcount per day-block against demand for the same cell. Shows
 * you're twelve Night people short on Saturday *before* you fail to fill it.
 *
 * Supply counts people who said yes and aren't already booked in that cell —
 * a declaration from somebody already working is not available supply, and
 * counting it is how a grid says you're fine on a day you aren't.
 */
async function supplyVsDemand(tenantId, weekStart, deps) {
  const { staffStore, availabilityStore, requestsStore, rosterStore } = deps;
  const dates = weekDates(weekStart);

  const [pool, docs] = await Promise.all([
    staffStore.listByTenant(tenantId),
    availabilityStore.listByWeek(tenantId, weekStart),
  ]);
  const byPhone = new Map(docs.map((d) => [d.phone, d]));

  const week = await rosterStore.getWeek(tenantId, weekStart);
  /** dateIso -> Set of phones already committed that day. */
  const bookedByDate = new Map();
  for (const [dateIso, day] of Object.entries(week.assignments || {})) {
    const phones = new Set();
    for (const [phone, raw] of Object.entries(day)) {
      if (normalizeAssignment(raw)) phones.add(phone);
    }
    bookedByDate.set(dateIso, phones);
  }

  const grid = {};
  for (const dateIso of dates) {
    grid[dateIso] = {};
    for (const block of BLOCKS) {
      grid[dateIso][block] = { supply: 0, booked: 0, demand: 0, shortfall: 0 };
    }
  }

  // Supply: declared and not already committed that day.
  for (const person of pool) {
    const doc = byPhone.get(person.phone);
    if (!isSubmitted(doc)) continue;
    for (const [dateIso, blocks] of Object.entries(doc.days || {})) {
      if (!grid[dateIso]) continue;
      const isBooked = (bookedByDate.get(dateIso) || new Set()).has(person.phone);
      for (const block of blocks) {
        if (!grid[dateIso][block]) continue;
        if (isBooked) grid[dateIso][block].booked += 1;
        else grid[dateIso][block].supply += 1;
      }
    }
  }

  // Demand: outstanding seats on live and future requests, in the cell the
  // shift's start falls in.
  const since = new Date(`${dates[0]}T00:00:00`);
  const recent = await requestsStore.listRecent(tenantId, new Date(since.getTime() - 14 * 86400000).toISOString());
  for (const request of recent) {
    if (["cancelled"].includes(request.outcome)) continue;
    const { block, dateIso } = blockFor(request.startsAt);
    if (!grid[dateIso] || !grid[dateIso][block]) continue;
    grid[dateIso][block].demand += request.headcount || 0;
  }

  let totalShortfall = 0;
  for (const dateIso of dates) {
    for (const block of BLOCKS) {
      const cell = grid[dateIso][block];
      cell.shortfall = Math.max(0, cell.demand - cell.supply);
      totalShortfall += cell.shortfall;
    }
  }

  const answered = pool.filter((p) => isSubmitted(byPhone.get(p.phone)));
  return {
    weekStart,
    grid,
    totalShortfall,
    poolSize: pool.length,
    answered: answered.length,
    unknown: pool.length - answered.length,
    declaredCells: answered.reduce((sum, p) => sum + declaredCellCount(byPhone.get(p.phone)), 0),
  };
}

/**
 * **Free-today pool by hour** — when people opt in.
 *
 * Thin at 5am on Saturdays is a recruitment target, months early. Counted from
 * declarations rather than the live pool, so the history survives the expiry
 * that makes the pool self-cleaning.
 */
async function freeTodayByHour(tenantId, dates, deps) {
  const { freeTodayStore } = deps;
  const byHour = Array.from({ length: 24 }, () => 0);
  let total = 0;

  for (const dateIso of dates) {
    const declarations = await freeTodayStore.listDeclaredOn(tenantId, dateIso);
    for (const doc of declarations) {
      byHour[new Date(doc.declaredAt).getHours()] += 1;
      total += 1;
    }
  }
  return { dates, byHour, total, perDay: dates.length ? Math.round((total / dates.length) * 10) / 10 : 0 };
}

/**
 * **Client hours** per site, with sign-off status. This is the invoicing view.
 *
 * Approved, awaiting and queried hours are three separate columns rather than one
 * total, because only the first is invoiceable and a single number would hide
 * which is which.
 */
function clientHours(shifts) {
  const bySite = {};
  for (const shift of shifts) {
    if (!shift.clockOut || shift.clockOut.denied) continue;
    const key = shift.siteId || "no-site";
    if (!bySite[key]) {
      bySite[key] = {
        siteId: key, siteName: shift.siteName || null,
        shifts: 0, approvedHours: 0, awaitingHours: 0, queriedHours: 0,
      };
    }
    const row = bySite[key];
    const hours = workedHours(shift);
    row.shifts += 1;
    if (shift.approvedAt) row.approvedHours += hours;
    else if (shift.queriedAt) row.queriedHours += hours;
    else row.awaitingHours += hours;
  }

  for (const row of Object.values(bySite)) {
    for (const key of ["approvedHours", "awaitingHours", "queriedHours"]) {
      row[key] = Math.round(row[key] * 100) / 100;
    }
  }
  return Object.values(bySite).sort((a, b) => b.approvedHours - a.approvedHours);
}

/**
 * Everything in one call, for the reports page.
 *
 * @param {object} params {from, to, weekStart}
 */
async function agencyReport(tenantId, { from, to, weekStart } = {}, deps) {
  const { requestsStore, staffStore, shiftsStore, tenantStore } = deps;
  const now = new Date();
  const start = from ? new Date(from) : new Date(now.getTime() - 28 * 86400000);
  const end = to ? new Date(to) : now;
  const week = weekStart || weekStartOf(now);

  const [allRequests, staff, allShifts, tenant] = await Promise.all([
    requestsStore.listRecent(tenantId, start.toISOString()),
    staffStore.listByTenant(tenantId),
    shiftsStore.listRecentByTenant(tenantId, start.toISOString()),
    tenantStore.findById(tenantId),
  ]);

  const inRange = (iso) => {
    const t = new Date(iso).getTime();
    return t >= start.getTime() && t <= end.getTime();
  };
  const requests = allRequests.filter((r) => inRange(r.createdAt));
  const shifts = allShifts.filter((s) => s.clockIn && inRange(s.clockIn.time));

  // The last fortnight of days, for the free-today histogram.
  const histogramDates = [];
  for (let d = new Date(Math.max(start.getTime(), end.getTime() - 13 * 86400000)); d <= end; d.setDate(d.getDate() + 1)) {
    histogramDates.push(localDateIso(d));
  }

  const approved = shifts.filter((s) => s.clockOut && !s.clockOut.denied && s.approvedAt);

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    fillRate: fillRate(requests),
    timeToFill: timeToFill(requests),
    lostDemand: lostDemand(requests),
    reliability: reliabilityReport(staff),
    margin: summarize(approved, tenant && tenant.onCosts),
    clientHours: clientHours(shifts),
    freeToday: await freeTodayByHour(tenantId, histogramDates, deps),
    supplyVsDemand: await supplyVsDemand(tenantId, week, deps),
  };
}

module.exports = {
  agencyReport,
  fillRate,
  timeToFill,
  lostDemand,
  reliabilityReport,
  supplyVsDemand,
  freeTodayByHour,
  clientHours,
  percentile,
  pctOf,
};
