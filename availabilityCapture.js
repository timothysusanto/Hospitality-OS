"use strict";

const { sendText } = require("./whatsapp");
const { availabilityLink, isConfigured: linksConfigured } = require("./signedLinks");
const {
  BLOCKS, BLOCK_LABEL, weekStartOf, weekDates, parseShorthand, expandPattern,
  patternFromDays, describeDays, describePattern, describeWeek, normalizeBlocks,
} = require("./availabilityBlocks");
const { isSubmitted } = require("./availabilityStore");
const { minutesRemaining } = require("./freeTodayStore");

/**
 * Capture — nobody in the office types availability.
 *
 * The ladder from docs/agencymodelshape.md, in order of leverage. Each rung
 * catches most of whoever is left:
 *
 *   1. "same"           — one word repeats last week. Should resolve the clear
 *                         majority of a settled pool, and is the highest-leverage
 *                         thing in the whole design.
 *   2. standing pattern — captured once at onboarding, turns the weekly ping
 *                         into confirm-or-amend.
 *   3. the grid         — a signed one-tap link, twenty seconds, no login.
 *   4. shorthand        — "mon am pm, wed night, fri all", for the typists.
 *                         Costs nothing to keep, will always be a minority.
 *   5. "today"          — the free-today pool, the same-day answer.
 *
 * Weekly cycle: **ask Wednesday, chase Friday, expire with the week** — so
 * supply is on the board before the hotels' requests land.
 */

/** Local day-of-week for the two ping days. 3 = Wednesday, 5 = Friday. */
const ASK_DAY = 3;
const CHASE_DAY = 5;
/** Not before this hour, so nobody is pinged at 3am. */
const PING_HOUR = 9;

/** The week the weekly ping is about: always the one after the current week. */
function nextWeekStart(now = new Date()) {
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 7);
  return weekStartOf(next);
}

/* ------------------------------------------------------------- the ping text */

function linkLine(tenantId, phone, weekStart) {
  if (!linksConfigured()) {
    // Degrade to shorthand rather than sending a broken link. The operator sees
    // why in the logs; the staff member still has a way to answer.
    return 'Or type it, e.g. "mon am pm, wed night, fri all".';
  }
  return `Or tap to change it: ${availabilityLink(tenantId, phone, weekStart)}`;
}

/**
 * The Wednesday ping. Shape depends on what we already know about this person,
 * which is what turns it from a form into a one-tap confirmation:
 *
 *   - answered before   -> "Last week you were free X. Reply SAME."
 *   - standing pattern  -> "You normally work X. Reply SAME."
 *   - neither           -> the link and the shorthand hint.
 */
function buildPing({ staff, weekStart, previous, chase }) {
  const lines = [];
  lines.push(`${chase ? "Quick reminder — n" : "N"}ext week, ${describeWeek(weekStart)}.`);

  const previousDays = previous && isSubmitted(previous) ? previous.days : null;
  const standing = staff.standingPattern;

  if (previousDays && Object.keys(previousDays).length) {
    lines.push(`Last week you were free ${describeDays(previousDays)}.`);
    lines.push('Reply SAME to repeat it, or NONE if you can\'t work next week.');
  } else if (standing && Object.keys(standing).length) {
    lines.push(`You normally work ${describePattern(standing)}.`);
    lines.push('Reply SAME to confirm that, or NONE if you can\'t work next week.');
  } else {
    lines.push("Let us know which shifts you can work and you'll get offers as they come.");
    lines.push('Reply NONE if you can\'t work next week.');
  }

  lines.push(linkLine(staff.tenantId, staff.phone, weekStart));
  return lines.join("\n");
}

/**
 * Sends the weekly ping and the Friday chase.
 *
 * Idempotent on `askedAt` / `chasedAt`, so the dispatcher's 30-second tick can
 * call this all Wednesday without pinging anybody twice. Marking asked never
 * touches `submittedAt`: sending a question must not turn silence into an
 * answer.
 *
 * @returns {Promise<{asked: number, chased: number, weekStart: string}>}
 */
async function sweepWeeklyPings(tenantId, deps, sendOpts = {}, now = new Date()) {
  const { staffStore, availabilityStore } = deps;
  const weekStart = nextWeekStart(now);
  const result = { asked: 0, chased: 0, weekStart };
  if (!availabilityStore) return result;

  const day = now.getDay();
  const isAskDay = day === ASK_DAY;
  const isChaseDay = day === CHASE_DAY;
  if ((!isAskDay && !isChaseDay) || now.getHours() < PING_HOUR) return result;

  const pool = await staffStore.listByTenant(tenantId);

  for (const staff of pool) {
    const doc = await availabilityStore.find(tenantId, staff.phone, weekStart);

    // Already answered: never chase somebody who has replied.
    if (isSubmitted(doc)) continue;

    if (isAskDay && (!doc || !doc.askedAt)) {
      await sendPing(staff, weekStart, deps, sendOpts, false);
      await availabilityStore.markAsked(tenantId, staff.phone, weekStart, "askedAt");
      result.asked += 1;
      continue;
    }

    // Friday: only chase people who were actually asked and stayed silent.
    if (isChaseDay && doc && doc.askedAt && !doc.chasedAt) {
      await sendPing(staff, weekStart, deps, sendOpts, true);
      await availabilityStore.markAsked(tenantId, staff.phone, weekStart, "chasedAt");
      result.chased += 1;
    }
  }

  if (result.asked || result.chased) {
    console.log(
      `[availability] week ${weekStart}: asked ${result.asked}, chased ${result.chased}`
    );
  }
  return result;
}

async function sendPing(staff, weekStart, deps, sendOpts, chase) {
  const { availabilityStore } = deps;
  try {
    const previous = await availabilityStore.findPreviousSubmitted(
      staff.tenantId, staff.phone, weekStart
    );
    await sendText(staff.phone, buildPing({ staff, weekStart, previous, chase }), sendOpts);
  } catch (err) {
    // One unreachable number must not stop the other 299 pings.
    console.error(`[availability] ping to ${staff.phone} failed:`, err.message);
  }
}

/* ------------------------------------------------------- the staff-side words */

const SAME_RE = /^(same|same again|as usual|usual|repeat)\b/;
const NONE_RE = /^(none|nothing|not available|unavailable|no shifts)\b/;
const TODAY_RE = /^(today|free today|im free|i'?m free|available today)\b/;

/** Whether a message is one of the availability words. */
function looksLikeAvailabilityReply(body) {
  return SAME_RE.test(body) || NONE_RE.test(body) || TODAY_RE.test(body);
}

/**
 * "same" — rung 1. Repeats the most recent week they answered for, or their
 * standing pattern if they have never answered. Refuses rather than guessing
 * when there is neither, because inventing an answer here would put somebody on
 * a roster they never agreed to.
 */
async function handleSameAgain(from, staff, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const weekStart = nextWeekStart(now);

  const previous = await availabilityStore.findPreviousSubmitted(staff.tenantId, from, weekStart);
  let days = null;
  let source = null;

  if (previous && Object.keys(previous.days || {}).length) {
    days = expandPattern(patternFromDays(previous.days), weekStart);
    source = "same-again";
  } else if (staff.standingPattern && Object.keys(staff.standingPattern).length) {
    days = expandPattern(staff.standingPattern, weekStart);
    source = "standing-pattern";
  }

  if (!days || !Object.keys(days).length) {
    await sendText(
      from,
      "I don't have a previous week to copy yet. Tell me which shifts you can work — " +
        'e.g. "mon am pm, wed night, fri all" — and "same" will work from then on.',
      sendOpts
    );
    return true;
  }

  await availabilityStore.submit(staff.tenantId, from, weekStart, days, source);
  await sendText(
    from,
    `Locked in for ${describeWeek(weekStart)}: ${describeDays(days)}.\nYou'll get offers as they come.`,
    sendOpts
  );
  return true;
}

/**
 * "none" — an explicit no for the week. Recorded as a real answer, not silence,
 * so the blast engine stops offering them shifts instead of treating them as
 * merely unheard-from.
 */
async function handleNotAvailable(from, staff, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const weekStart = nextWeekStart(now);
  await availabilityStore.submitNone(staff.tenantId, from, weekStart, "shorthand");
  await sendText(
    from,
    `Noted — you're down as not available for ${describeWeek(weekStart)}. ` +
      'Message "same" or send your shifts any time if that changes.',
    sendOpts
  );
  return true;
}

/**
 * "today" — rung 5, the free-today pool. Opt-in, self-expiring, and the only
 * thing that can put somebody in it is this message from them.
 */
async function handleFreeToday(from, staff, deps, sendOpts = {}, now = new Date()) {
  const { freeTodayStore } = deps;
  if (!freeTodayStore) {
    await sendText(from, "The same-day pool isn't switched on yet — sorry.", sendOpts);
    return true;
  }
  const doc = await freeTodayStore.declare(staff.tenantId, from, now);
  const until = new Date(doc.expiresAt).toLocaleTimeString("en-AU", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const minutes = minutesRemaining(doc, now);
  await sendText(
    from,
    `You're in the pool for today until ${until} (${minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes} min`}).\n` +
      "You'll get first refusal on anything that comes up.",
    sendOpts
  );
  return true;
}

/**
 * Rung 4 — the text shorthand. Also the fallback for anything that parses as
 * days and blocks, so somebody who types their week out longhand is understood
 * without having to learn the exact format.
 *
 * Returns false when nothing readable was found, so the router can fall through
 * to the help text rather than claiming to have understood.
 */
async function handleShorthand(from, staff, body, deps, sendOpts = {}, now = new Date()) {
  const { availabilityStore } = deps;
  const { pattern, unknown } = parseShorthand(body);
  if (!Object.keys(pattern).length) return false;

  const weekStart = nextWeekStart(now);
  const days = expandPattern(pattern, weekStart);
  await availabilityStore.submit(staff.tenantId, from, weekStart, days, "shorthand");

  let reply = `Got it for ${describeWeek(weekStart)}: ${describeDays(days)}.`;
  if (unknown.length) reply += `\n(Didn't understand: ${unknown.join(", ")})`;
  await sendText(from, reply, sendOpts);
  return true;
}

/** Everything the availability grid page needs to render one person's week. */
function gridModel(doc, weekStart) {
  const days = (doc && doc.days) || {};
  return {
    weekStart,
    weekLabel: describeWeek(weekStart),
    blocks: BLOCKS.map((block) => ({ key: block, label: BLOCK_LABEL[block] })),
    dates: weekDates(weekStart).map((dateIso) => ({
      dateIso,
      label: new Date(`${dateIso}T12:00:00`).toLocaleDateString("en-AU", {
        weekday: "short", day: "numeric", month: "short",
      }),
      selected: normalizeBlocks(days[dateIso]),
    })),
    submittedAt: (doc && doc.submittedAt) || null,
  };
}

module.exports = {
  sweepWeeklyPings,
  buildPing,
  nextWeekStart,
  looksLikeAvailabilityReply,
  handleSameAgain,
  handleNotAvailable,
  handleFreeToday,
  handleShorthand,
  gridModel,
  SAME_RE,
  NONE_RE,
  TODAY_RE,
  ASK_DAY,
  CHASE_DAY,
  PING_HOUR,
};
