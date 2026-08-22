/**
 * award-engine.js — Config-driven award interpretation & shift costing
 * Deskless Workforce OS — Core. Award #1: HIGA (MA000009).
 *
 * DESIGN RULES
 *  - Pure functions. No Firestore, no Express. Testable in isolation.
 *  - All dollar figures live in AWARD_CONFIGS, never in logic.
 *  - Every rate carries a `verified` flag. Unverified rates render with a ⚠ in the UI
 *    and are listed by listUnverifiedRates() so nothing silently ships wrong.
 *
 * RATE SOURCES (2026/27, effective first full pay period on/after 1 Jul 2026):
 *  - FY2026/27 wage review = +4.75%. HIGA L1 adult: $26.44 FT/PT, $33.05 casual (VERIFIED
 *    against published summaries of the FWO pay guide, 24 Jun 2026).
 *  - Levels 2–6 below are ESTIMATES (2025/26 rates × 1.0475). The C13 floor changed the
 *    maths at lower levels this year — VERIFY every level against the official FWO
 *    HIGA Pay Guide before first live pay run. Update `verified: true` as you confirm.
 */

const AWARD_CONFIGS = {
  MA000009: {
    code: "MA000009",
    name: "Hospitality Industry (General) Award 2020 (HIGA)",
    casualLoading: 0.25,
    // Adult minimum hourly base rates (full-time/part-time, non-casino streams)
    levels: {
      INTRO: { label: "Introductory",              base: 25.85, verified: false },
      L1:    { label: "Level 1 — F&B/Kitchen Att.", base: 26.44, verified: true  },
      L2:    { label: "Level 2 — Cook Gr1/HK",      base: 26.95, verified: false },
      L3:    { label: "Level 3 — Cook Gr2/Senior",  base: 27.34, verified: false },
      L4:    { label: "Level 4 — Cook Gr3 (trade)", base: 28.80, verified: false },
      L5:    { label: "Level 5 — Cook Gr4/Sup.",    base: 30.61, verified: false },
      L6:    { label: "Level 6 — Cook Gr5",         base: 31.41, verified: false },
    },
    /**
     * Penalty multipliers applied to BASE rate.
     * HIGA structure: casual weekend/PH rates already absorb part/all of the loading —
     * they are expressed here as total multipliers of base (not base+loading+penalty).
     */
    penalties: {
      permanent: { weekday: 1.0,  saturday: 1.25, sunday: 1.5,  publicHoliday: 2.25 },
      casual:    { weekday: 1.25, saturday: 1.5,  sunday: 1.75, publicHoliday: 2.5  },
    },
    /**
     * Time-of-day loadings, added per hour worked in the window, as % of base.
     * HIGA: Mon–Fri 7pm–midnight +10% of base/hr; midnight–7am +15% of base/hr.
     * Applies to permanent and casual; not on top of Sat/Sun/PH penalties.
     */
    timeLoadings: [
      { id: "evening", label: "Evening (Mon–Fri 7pm–12am)", startHour: 19, endHour: 24, pct: 0.10, daysOfWeek: [1,2,3,4,5], verified: false },
      { id: "night",   label: "Night (Mon–Fri 12am–7am)",   startHour: 0,  endHour: 7,  pct: 0.15, daysOfWeek: [1,2,3,4,5], verified: false },
    ],
    overtime: {
      dailyThresholdHours: 11.5,      // beyond this in one shift → OT (simplified v1)
      weeklyThresholdHours: 38,       // FT weekly ordinary hours
      firstBlockHours: 2, firstBlockMult: 1.5, thenMult: 2.0,
      casualOTMult: { first: 1.75, then: 2.25 }, // casual OT incl. loading (verify)
      verified: false,
    },
    superRate: 0.12, // Superannuation Guarantee 12% from 1 Jul 2025 (statutory)
  },
};

// ---------------------------------------------------------------------------

function getAward(code) {
  const a = AWARD_CONFIGS[code];
  if (!a) throw new Error(`Unknown award code: ${code}`);
  return a;
}

/** Day type for penalty purposes. publicHolidays: array of "YYYY-MM-DD". */
function dayType(dateStr, publicHolidays = []) {
  if (publicHolidays.includes(dateStr)) return "publicHoliday";
  const d = new Date(dateStr + "T12:00:00");
  const dow = d.getDay();
  if (dow === 6) return "saturday";
  if (dow === 0) return "sunday";
  return "weekday";
}

/**
 * Cost one shift.
 * shift: { date:"YYYY-MM-DD", start:"HH:MM", end:"HH:MM", unpaidBreakMins }
 * worker: { employmentType:"fulltime"|"parttime"|"casual", level:"L1".. , awardCode }
 * opts: { publicHolidays: ["YYYY-MM-DD", ...] }
 */
function costShift(shift, worker, opts = {}) {
  const award = getAward(worker.awardCode || "MA000009");
  const level = award.levels[worker.level];
  if (!level) throw new Error(`Unknown level ${worker.level} for ${award.code}`);

  const type = dayType(shift.date, opts.publicHolidays || []);
  const isCasual = worker.employmentType === "casual";
  const mult = award.penalties[isCasual ? "casual" : "permanent"][type];

  // Paid hours
  const [sh, sm] = shift.start.split(":").map(Number);
  const [eh, em] = shift.end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // overnight shift
  const paidMins = Math.max(0, mins - (shift.unpaidBreakMins || 0));
  const hours = paidMins / 60;

  // Ordinary vs simplified daily overtime
  const ot = award.overtime;
  const ordinaryHours = Math.min(hours, ot.dailyThresholdHours);
  const otHours = Math.max(0, hours - ot.dailyThresholdHours);

  const base = level.base;
  let cost = ordinaryHours * base * mult;

  // Time-of-day loadings — weekdays only, ordinary hours only (simplified v1)
  const loadingLines = [];
  if (type === "weekday") {
    const dow = new Date(shift.date + "T12:00:00").getDay();
    for (const tl of award.timeLoadings) {
      if (!tl.daysOfWeek.includes(dow)) continue;
      const s0 = sh + sm / 60, s1 = s0 + hours;
      // Check the window on both sides of midnight so overnight shifts are caught
      const overlap = hourOverlap(s0, s1, tl.startHour, tl.endHour)
                    + hourOverlap(s0, s1, tl.startHour + 24, tl.endHour + 24);
      if (overlap > 0) {
        const amt = overlap * base * tl.pct;
        cost += amt;
        loadingLines.push({ id: tl.id, hours: round2(overlap), amount: round2(amt) });
      }
    }
  }

  // Overtime (simplified: daily threshold only in v1; weekly OT computed at roster level)
  let otCost = 0;
  if (otHours > 0) {
    const firstMult = isCasual ? ot.casualOTMult.first : ot.firstBlockMult;
    const thenMult  = isCasual ? ot.casualOTMult.then  : ot.thenMult;
    const firstHrs = Math.min(otHours, ot.firstBlockHours);
    const thenHrs  = Math.max(0, otHours - ot.firstBlockHours);
    otCost = firstHrs * base * firstMult + thenHrs * base * thenMult;
    cost += otCost;
  }

  const superAmt = cost * award.superRate;
  return {
    date: shift.date, dayType: type,
    hours: round2(hours), ordinaryHours: round2(ordinaryHours), otHours: round2(otHours),
    baseRate: base, multiplier: mult,
    wageCost: round2(cost), superCost: round2(superAmt),
    totalCost: round2(cost + superAmt),
    loadings: loadingLines, otCost: round2(otCost),
    unverifiedRate: !level.verified,
  };
}

/** Cost a whole roster: shifts[{...shift, workerId}], workers keyed by id. */
function costRoster(shifts, workersById, opts = {}) {
  const lines = [];
  const byWorker = {};
  for (const s of shifts) {
    const w = workersById[s.workerId];
    if (!w) continue;
    const c = costShift(s, w, opts);
    lines.push({ ...c, workerId: s.workerId, shiftId: s.id });
    (byWorker[s.workerId] = byWorker[s.workerId] || []).push(c);
  }
  // Weekly OT flag (v1: flag, don't auto-price — needs roster-cycle rules)
  const weeklyOTFlags = [];
  for (const [workerId, cs] of Object.entries(byWorker)) {
    const w = workersById[workerId];
    const total = cs.reduce((t, c) => t + c.hours, 0);
    const award = getAward(w.awardCode || "MA000009");
    if (w.employmentType !== "casual" && total > award.overtime.weeklyThresholdHours) {
      weeklyOTFlags.push({ workerId, weeklyHours: round2(total), threshold: award.overtime.weeklyThresholdHours });
    }
  }
  const wage = round2(lines.reduce((t, l) => t + l.wageCost, 0));
  const superTotal = round2(lines.reduce((t, l) => t + l.superCost, 0));
  return {
    lines, weeklyOTFlags,
    totals: {
      hours: round2(lines.reduce((t, l) => t + l.hours, 0)),
      wage, super: superTotal, total: round2(wage + superTotal),
    },
    hasUnverifiedRates: lines.some((l) => l.unverifiedRate),
  };
}

/** Every rate still needing verification against the official pay guide. */
function listUnverifiedRates(code = "MA000009") {
  const a = getAward(code);
  const out = [];
  for (const [k, v] of Object.entries(a.levels)) if (!v.verified) out.push(`${code} ${k} base $${v.base}`);
  for (const tl of a.timeLoadings) if (!tl.verified) out.push(`${code} loading ${tl.id} ${tl.pct * 100}%`);
  if (!a.overtime.verified) out.push(`${code} overtime multipliers`);
  return out;
}

function hourOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { AWARD_CONFIGS, getAward, dayType, costShift, costRoster, listUnverifiedRates };
