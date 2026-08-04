#!/usr/bin/env node
"use strict";

/**
 * Message-cost model — the last open question in docs/agencymodelshape.md:
 * "Model the monthly number before quoting an agency — wave 3 of an urgent
 * blast can touch the whole pool."
 *
 * Run it:
 *   node scripts/message-cost.js
 *   node scripts/message-cost.js --pool 300 --planned 40 --urgent 25 --utility 0.0132
 *
 * ## Why this is a script and not a spreadsheet
 *
 * It imports WAVE_PLANS from dispatch.js, so the wave structure it prices is the
 * wave structure that actually runs. Change a wave in the engine and this
 * re-prices itself. A spreadsheet drifts from the code the first week somebody
 * tunes a dial.
 *
 * ## What it does NOT know
 *
 * The per-message rate. WhatsApp rates change and vary by country and template
 * category, so they are inputs with clearly-labelled placeholder defaults rather
 * than numbers baked in. Get the real ones from
 * developers.facebook.com/docs/whatsapp/pricing and pass them in. Every figure
 * printed below is "volume × your rate", and the volumes are the part this can
 * be authoritative about.
 */

const { WAVE_PLANS } = require("../dispatch");

/* ------------------------------------------------------------------ inputs */

const DEFAULTS = {
  // The pool, and how much work comes through it.
  pool: 300,
  sites: 15,
  plannedPerWeek: 40,   // requests raised 12h+ ahead
  urgentPerWeek: 25,    // requests raised under 12h out
  seatsPerRequest: 2.5, // average headcount per request

  // How well the availability data is working. These are the cost levers.
  answeredPct: 70,      // share of the pool who answer the weekly ping
  availablePct: 25,     // share of the pool available for any given block
  freeTodayPct: 12,     // share of the pool in the free-today pool on a given day

  // Share of people offered a shift who accept it *inside that wave's window*.
  // Deliberately low: the urgent lane's window is ten minutes, so this is
  // "saw it and said yes in time", not "would have taken it eventually".
  acceptPerOfferPct: 6,

  // Rates. PLACEHOLDERS — see the note above. AUD per message.
  utility: 0.0132,      // utility-category template
  marketing: 0.0662,    // marketing-category template, for comparison only
  service: 0,           // replies inside the 24h customer-service window
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, "");
    if (!(key in out)) {
      console.error(`Unknown option --${key}. Known: ${Object.keys(out).join(", ")}`);
      process.exit(1);
    }
    const value = Number(argv[i + 1]);
    if (!Number.isFinite(value)) {
      console.error(`--${key} needs a number`);
      process.exit(1);
    }
    out[key] = value;
  }
  return out;
}

const cfg = parseArgs(process.argv);
const WEEKS_PER_MONTH = 52 / 12;

/* ------------------------------------------------------- volume, per lane */

/**
 * How many people one request's blast reaches.
 *
 * Each wave only fires if the previous one didn't fill the request, so the
 * expected reach is a weighted sum rather than the sum of every wave. That
 * distinction is most of the difference between a scary number and a real one.
 */
/**
 * Chance a wave that reached `audience` people fills the request.
 *
 * Expected acceptances are `audience × acceptPerOfferPct`; the wave fills if
 * that covers the seats needed. Capped at 95% because a wave can always miss —
 * everyone busy, everyone asleep, a hotel asking for eight people at once.
 */
function fillProbability(audience) {
  const expectedAccepts = audience * (cfg.acceptPerOfferPct / 100);
  const seats = Math.max(1, cfg.seatsPerRequest);
  return Math.min(0.95, expectedAccepts / seats);
}

function reachPerRequest(lane) {
  const plan = WAVE_PLANS[lane];
  const audience = {
    // Wave 1 planned: people who declared themselves available for that block.
    available: cfg.pool * (cfg.availablePct / 100),
    // Wave 1 urgent: today's opt-in pool.
    freeToday: cfg.pool * (cfg.freeTodayPct / 100),
    // Wave 2: people we have no answer from. Excludes anyone who said no,
    // which is why the answered rate is a cost lever and not just a nicety.
    unknown: cfg.pool * (1 - cfg.answeredPct / 100),
    // Wave 3 urgent: everybody, minus those already offered in earlier waves.
    all: cfg.pool,
  };

  const reachedBefore = [];
  let cumulativeProbability = 1;
  let expected = 0;
  const breakdown = [];

  for (let i = 0; i < plan.length; i++) {
    const tier = plan[i].tier;
    // Nobody is offered the same request twice, so later waves only add people
    // the earlier ones didn't reach.
    const alreadyReached = reachedBefore.reduce((a, b) => a + b, 0);
    const fresh = Math.max(0, audience[tier] - alreadyReached);
    reachedBefore.push(fresh);

    const contribution = fresh * cumulativeProbability;
    expected += contribution;
    breakdown.push({
      wave: i + 1,
      tier,
      audience: Math.round(fresh),
      firesPct: Math.round(cumulativeProbability * 100),
      expected: Math.round(contribution),
      fillPct: Math.round(fillProbability(fresh) * 100),
    });

    // Probability the next wave is needed at all. Derived from how many people
    // this wave reached rather than assumed: that is what makes a bigger
    // free-today pool show up as a saving instead of a cost, because a wave with
    // more people in it fills more often and the later waves never fire.
    cumulativeProbability *= 1 - fillProbability(fresh);
  }

  return { expected, breakdown, worstCase: reachedBefore.reduce((a, b) => a + b, 0) };
}

/* --------------------------------------------------------- the four streams */

function model() {
  const planned = reachPerRequest("planned");
  const urgent = reachPerRequest("urgent");

  // 1. Shift offers. The dominant term, from dispatch.js sendWave().
  const offersPerWeek =
    cfg.plannedPerWeek * planned.expected + cfg.urgentPerWeek * urgent.expected;

  // 2. The weekly availability ping, from availabilityCapture.js. Wednesday
  //    reaches everyone; Friday only chases people who stayed silent.
  const pingsPerWeek = cfg.pool + cfg.pool * (1 - cfg.answeredPct / 100);

  // 3. Sign-off requests, from signoffHandler.js. One per site per day it had
  //    staff on, per requester. Assumed one requester per site.
  const shiftDaysPerWeek = Math.min(7, cfg.sites > 0 ? 6 : 0);
  const signoffsPerWeek = cfg.sites * shiftDaysPerWeek;

  // 4. Status updates to the hotel, from dispatch.js notifyRequester(). Mostly
  //    FREE: the hotel confirmed the order minutes earlier, which opens a 24h
  //    service window. Only counted where a request outlives that window.
  const statusPerWeek = (cfg.plannedPerWeek + cfg.urgentPerWeek) * 0.15 * 3;

  const streams = [
    { name: "Shift offers", perWeek: offersPerWeek, category: "utility", note: "dispatch.js sendWave()" },
    { name: "Weekly availability ping", perWeek: pingsPerWeek, category: "utility", note: "Wed ask + Fri chase" },
    { name: "Sign-off requests", perWeek: signoffsPerWeek, category: "utility", note: "one per site per shift-day" },
    { name: "Hotel status updates", perWeek: statusPerWeek, category: "utility", note: "most are free — see notes" },
  ];

  return { planned, urgent, streams };
}

/* ------------------------------------------------------------------ output */

const money = (n) => `$${n.toFixed(2)}`;
/** Per-message rates are fractions of a cent — 2dp would round them to $0.01. */
const rate = (n) => `$${n.toFixed(4)}`;
const int = (n) => Math.round(n).toLocaleString("en-AU");

function bar(label, value, max, width = 28) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return `${label.padEnd(26)} ${"█".repeat(filled).padEnd(width)} ${int(value).padStart(8)}`;
}

const { planned, urgent, streams } = model();
const totalPerWeek = streams.reduce((sum, s) => sum + s.perWeek, 0);
const totalPerMonth = totalPerWeek * WEEKS_PER_MONTH;
const maxStream = Math.max(...streams.map((s) => s.perWeek));

console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  WhatsApp message-cost model                                         ║
║  Volumes are derived from the live WAVE_PLANS in dispatch.js.         ║
║  Rates are PLACEHOLDERS — pass your own with --utility / --marketing. ║
╚══════════════════════════════════════════════════════════════════════╝

Assumptions
  Pool ${cfg.pool} casuals across ${cfg.sites} sites
  ${cfg.plannedPerWeek} planned + ${cfg.urgentPerWeek} urgent requests/week (~${int((cfg.plannedPerWeek + cfg.urgentPerWeek) * cfg.seatsPerRequest)} seats/week)
  ${cfg.answeredPct}% answer the weekly ping · ${cfg.availablePct}% available per block · ${cfg.freeTodayPct}% in the free-today pool
  ${cfg.acceptPerOfferPct}% of people offered a shift accept inside that wave's window
`);

for (const [lane, m] of [["PLANNED", planned], ["URGENT", urgent]]) {
  console.log(`  ${lane} blast — reach per request`);
  for (const w of m.breakdown) {
    console.log(
      `    wave ${w.wave} (${w.tier.padEnd(9)}) audience ${String(w.audience).padStart(4)}` +
        ` · fills ${String(w.fillPct).padStart(3)}% · fires ${String(w.firesPct).padStart(3)}% of the time` +
        ` · expected ${String(w.expected).padStart(4)}`
    );
  }
  console.log(
    `    expected ${Math.round(m.expected)} messages/request` +
      `   (worst case, every wave fires: ${Math.round(m.worstCase)})\n`
  );
}

console.log("Monthly volume by stream");
for (const s of streams) {
  console.log("  " + bar(s.name, s.perWeek * WEEKS_PER_MONTH, maxStream * WEEKS_PER_MONTH));
}
console.log(`  ${"".padEnd(26)} ${"".padEnd(28)} ${int(totalPerMonth).padStart(8)}  total/month\n`);

console.log("Monthly cost");
const utilityCost = totalPerMonth * cfg.utility;
const marketingCost = totalPerMonth * cfg.marketing;
console.log(`  as UTILITY   @ ${rate(cfg.utility)}/msg   ${money(utilityCost).padStart(10)}`);
console.log(`  as MARKETING @ ${rate(cfg.marketing)}/msg   ${money(marketingCost).padStart(10)}`);
console.log(`  penalty for the wrong category:  ${money(marketingCost - utilityCost)}/month\n`);

const perSeat = utilityCost / ((cfg.plannedPerWeek + cfg.urgentPerWeek) * cfg.seatsPerRequest * WEEKS_PER_MONTH);
console.log(`  → ${money(perSeat)} of messaging per placement filled (utility rate)`);
console.log(`  → ${money(utilityCost / cfg.sites)} per site per month\n`);

console.log("Sensitivity — the levers worth pulling");
const base = totalPerMonth;
for (const [label, override] of [
  ["answered 70% → 90%", { answeredPct: 90 }],
  ["answered 70% → 40%", { answeredPct: 40 }],
  ["free-today 12% → 25%", { freeTodayPct: 25 }],
  ["available 25% → 15%", { availablePct: 15 }],
  ["urgent volume doubles", { urgentPerWeek: cfg.urgentPerWeek * 2 }],
]) {
  const saved = { ...cfg };
  Object.assign(cfg, override);
  const alt = model().streams.reduce((s, x) => s + x.perWeek, 0) * WEEKS_PER_MONTH;
  Object.assign(cfg, saved);
  const delta = ((alt - base) / base) * 100;
  const sign = delta >= 0 ? "+" : "";
  console.log(
    `  ${label.padEnd(24)} ${int(alt).padStart(8)} msgs  ${(sign + delta.toFixed(0) + "%").padStart(6)}` +
      `  ${money(alt * cfg.utility).padStart(10)}`
  );
}

console.log(`
Notes, and what to verify before you trust this
  1. CATEGORY IS THE BIGGEST LEVER. Shift offers, availability pings and
     sign-off requests are all transactional messages to people in an existing
     relationship with you, which is what "utility" means. Get your templates
     approved as utility, not marketing — the penalty above is the cost of
     getting that wrong. Have the category argument ready when you submit them.

  2. REPLIES ARE FREE. Anything sent inside the 24-hour window a person opens by
     messaging you costs nothing, which is why the design leans on staff texting
     "same", "today", "yes" and "in". Every one of those replies is free, and
     they are the majority of all traffic. Only the four streams above are paid.
     Meta has also been making utility templates free inside that window —
     confirm on the current pricing page, because if it holds, blasting the
     free-today pool costs nothing for the rest of their opt-in day.

  3. THE FREE-TODAY POOL IS A COST CONTROL, not just a speed feature. A bigger
     pool means urgent wave 1 fills more often, so waves 2 and 3 fire less. See
     the sensitivity table.

  4. ANSWERING THE PING IS A COST CONTROL TOO. Wave 2 targets people we have no
     answer from, so a pool that answers reliably shrinks the wave that would
     otherwise reach almost everybody.

  5. A WELL-INFORMED POOL ESCALATES SOONER AND WIDER. This model surfaced a
     real consequence of the wave design, confirmed against dispatch.js: wave 2
     targets people we have NO answer from, so the better your ping response
     rate, the emptier wave 2 becomes. An empty wave sends nothing and advance()
     walks straight to the next one in the same tick (dispatch.js line ~348), so
     at a 90% response rate urgent wave 2 has nobody in it and wave 3 — the
     whole pool, including everyone who said they were unavailable — fires one
     window earlier than intended. Run this with --answeredPct 90 to see it.
     Three ways to handle it, and it is a business call, not a code fix:
       a) exclude declared-unavailable from wave 3: cheapest, but lowers the
          chance of filling a genuine 5am emergency
       b) cap wave 3 at the fastest N responders: bounded cost, keeps the valve
       c) leave it: it is the documented last resort and it does fill shifts
     Nothing has been changed in the engine — decide, then tell me which.

  6. RATES ARE PLACEHOLDERS. Pull the current AUD numbers for your template
     categories from developers.facebook.com/docs/whatsapp/pricing and re-run
     with --utility and --marketing. Volumes are the trustworthy part here.
`);
