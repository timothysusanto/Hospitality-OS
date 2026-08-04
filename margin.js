"use strict";

/**
 * Bill rates, on-costs and margin — build order step 6 of
 * docs/agencymodelshape.md.
 *
 * The existing penalty-rate engine in server.js already computes the cost side.
 * Adding the bill side is what turns it into a margin report:
 *
 *   margin = bill − pay − on-costs
 *
 * ## On-costs are the whole point
 *
 * Billing a shift flat while paying penalty rates loses money quietly, and the
 * urgent lane skews to nights and weekends where penalties bite hardest. A
 * margin that ignores casual loading, super, payroll tax and workers' comp is
 * not a margin, it is a gross number that flatters every decision made from it.
 *
 * Defaults below are Australian ballpark figures for a casual labour-hire
 * business as at 2026, and they are **starting points the operator confirms**,
 * exactly like the penalty presets already in the dashboard. They are not advice
 * and they are not award interpretation.
 *
 * ## Rates are stamped on the shift, never looked up later
 *
 * A shift carries the payRate and billRate that applied when it was worked. Rate
 * cards change; an invoice from three months ago must not silently reprice when
 * somebody edits a site. This is the same reasoning as `siteName` being
 * denormalized onto the shift in step 1.
 *
 * ## Pay rates are never visible to the site
 *
 * A decision taken with the owner from the design note's "Still open" list. If a
 * hotel negotiates directly with a casual the margin model breaks quietly, so no
 * function here that builds something a client sees may include a pay rate or a
 * margin. `clientFacingLine()` is the only formatter for client messages, and it
 * deliberately has no access to either.
 */

/** Ballpark Australian on-costs for casual labour hire. Operator-confirmed. */
const DEFAULT_ON_COSTS = {
  // Casual loading in lieu of leave entitlements.
  casualLoadingPct: 25,
  // Superannuation guarantee.
  superPct: 12,
  // State payroll tax — varies by state and by whether you're over the threshold.
  payrollTaxPct: 5.45,
  // Workers' compensation premium, industry-rated.
  workersCompPct: 2.5,
};

function pct(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

/** Fills in any missing on-cost with its default, so callers never branch. */
function normalizeOnCosts(raw) {
  const base = DEFAULT_ON_COSTS;
  if (!raw || typeof raw !== "object") return { ...base };
  return {
    casualLoadingPct: pct(raw.casualLoadingPct, base.casualLoadingPct),
    superPct: pct(raw.superPct, base.superPct),
    payrollTaxPct: pct(raw.payrollTaxPct, base.payrollTaxPct),
    workersCompPct: pct(raw.workersCompPct, base.workersCompPct),
  };
}

/**
 * The multiplier on base pay that turns it into what the shift actually costs.
 *
 * Order matters and is not commutative: casual loading is part of the wage, so
 * super, payroll tax and workers' comp are all levied on the loaded wage rather
 * than the base. Computing them off the base understates the cost by a few
 * percent on every shift, which is the difference between a thin margin and no
 * margin.
 */
function costMultiplier(onCosts) {
  const c = normalizeOnCosts(onCosts);
  const loaded = 1 + c.casualLoadingPct / 100;
  const onTop = (c.superPct + c.payrollTaxPct + c.workersCompPct) / 100;
  return loaded * (1 + onTop);
}

/**
 * The bill rate for a role at a site.
 *
 * `billRates.default` is the fallback, because an agency signs a rate card per
 * client and a role the card doesn't mention still has to be billable. Returns
 * null when neither exists, and the caller must treat that as "unbillable" and
 * say so rather than assuming zero — a shift billed at zero is invisible in a
 * margin report and looks like a loss-making placement.
 */
function billRateFor(site, role) {
  const rates = (site && site.billRates) || {};
  if (role) {
    const key = String(role).trim().toLowerCase();
    const exact = Number(rates[key]);
    if (Number.isFinite(exact) && exact > 0) return exact;
  }
  const fallback = Number(rates.default);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/** Hours actually worked, amendment-aware and minus breaks. */
function workedHours(shift) {
  const inIso = (shift.amended && shift.amended.clockInTime) || (shift.clockIn && shift.clockIn.time);
  const outIso = (shift.amended && shift.amended.clockOutTime) || (shift.clockOut && shift.clockOut.time);
  if (!inIso || !outIso) return 0;

  const grossMs = new Date(outIso).getTime() - new Date(inIso).getTime();
  if (!(grossMs > 0)) return 0;

  let breakMs = 0;
  if (shift.amended && Number.isFinite(Number(shift.amended.breakMinutes))) {
    breakMs = Number(shift.amended.breakMinutes) * 60000;
  } else {
    for (const entry of shift.breaks || []) {
      if (!entry.end) continue;
      breakMs += new Date(entry.end).getTime() - new Date(entry.start).getTime();
    }
  }
  return Math.max(0, (grossMs - breakMs) / 3600000);
}

/**
 * Margin for one shift, from the rates stamped on it.
 *
 * @returns {{hours, pay, cost, bill, margin, marginPct, billable}}
 *   `billable` is false when the shift has no bill rate — reported rather than
 *   silently treated as zero revenue.
 */
function shiftMargin(shift, onCosts) {
  const hours = workedHours(shift);
  const payRate = rateOrNull(shift.payRate);
  const billRate = rateOrNull(shift.billRate);
  const multiplier = costMultiplier(onCosts);

  const hasPayRate = payRate != null && payRate > 0;
  const billable = billRate != null && billRate > 0;

  const pay = hasPayRate ? payRate * hours : 0;
  const cost = pay * multiplier;
  const bill = billable ? billRate * hours : 0;
  const margin = bill - cost;

  return {
    hours: round(hours),
    pay: round(pay),
    cost: round(cost),
    bill: round(bill),
    margin: round(margin),
    marginPct: bill > 0 ? round((margin / bill) * 100) : null,
    billable,
    hasPayRate,
    // Both flags matter to a reader: an unbillable shift looks like a loss and
    // an unpriced one looks like pure profit. Either way the margin is fiction
    // until somebody sets the missing rate.
    complete: hasPayRate && billable,
  };
}

/**
 * A rate, or null. Not `Number.isFinite(Number(x))`: `Number(null)` is 0, so
 * that test treats an absent rate as a real rate of zero — which makes an
 * unpriced shift report 100% margin.
 */
function rateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Totals a set of shifts, and splits by lane so the two aren't blended. */
function summarize(shifts, onCosts) {
  const blank = () => ({ shifts: 0, hours: 0, pay: 0, cost: 0, bill: 0, margin: 0, unbillable: 0, noPayRate: 0 });
  const total = blank();
  const byLane = { planned: blank(), urgent: blank() };

  for (const shift of shifts) {
    const m = shiftMargin(shift, onCosts);
    // Blending planned and urgent hides both — the urgent column is a sales
    // asset you can price against, and only if it's reported apart.
    const bucket = byLane[shift.lane] || null;
    for (const target of [total, bucket].filter(Boolean)) {
      target.shifts += 1;
      target.hours += m.hours;
      target.pay += m.pay;
      target.cost += m.cost;
      target.bill += m.bill;
      target.margin += m.margin;
      if (!m.billable) target.unbillable += 1;
      if (!m.hasPayRate) target.noPayRate += 1;
    }
  }

  for (const bucket of [total, byLane.planned, byLane.urgent]) {
    for (const key of ["hours", "pay", "cost", "bill", "margin"]) bucket[key] = round(bucket[key]);
    bucket.marginPct = bucket.bill > 0 ? round((bucket.margin / bucket.bill) * 100) : null;
  }
  return { total, byLane };
}

/**
 * The only formatter for something a client sees. Hours and sign-off status,
 * never a rate and never a margin — see the note at the top of this file.
 */
function clientFacingLine(shift, staffName) {
  const hours = round(workedHours(shift));
  const approved = shift.approvedAt ? " ✓ approved" : shift.queriedAt ? " ⚠ queried" : "";
  return `${staffName || shift.staffPhone} — ${hours.toFixed(1)} hrs${approved}`;
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = {
  DEFAULT_ON_COSTS,
  normalizeOnCosts,
  costMultiplier,
  billRateFor,
  workedHours,
  shiftMargin,
  summarize,
  clientFacingLine,
};
