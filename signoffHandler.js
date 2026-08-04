"use strict";

const { sendText } = require("./whatsapp");
const { workedHours, clientFacingLine } = require("./margin");

/**
 * Timesheet sign-off from the supervisor's phone — build order step 6 of
 * docs/agencymodelshape.md.
 *
 *   →  Maria clocked in 06:52 · Ahmed 06:58 · Jo 07:12, 12 min late
 *   →  Shift complete — 24.0 hrs total.  [Approve] [Query]
 *   ←  Approve
 *   →  Signed off. This goes on your 5 Aug invoice.
 *
 * ## Approval is what makes an hour billable
 *
 * An unapproved shift is not an invoice line, it is a worklist item. A queried
 * shift is the same, plus a note. Neither reaches a client's bill until somebody
 * at the client has said the hours are right — which is what makes the invoice
 * defensible when it's disputed three weeks later.
 *
 * ## What a client is shown
 *
 * Hours, names and lateness. **Never a pay rate and never a margin** — a decision
 * taken with the owner from the design note's "Still open" list. Every message
 * this module sends to a client goes through margin.js's `clientFacingLine`,
 * which has no access to either.
 */

/** Wait this long after the last clock-out before asking, so a straggler is included. */
const SETTLE_MS = 20 * 60 * 1000;

/** Don't chase a sign-off forever — after this it's the operator's problem. */
const ASK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const APPROVE_RE = /^(approve|approved|ok|okay|yes|y|correct|fine|all good|signed off)\b/;
const QUERY_RE = /^(query|queried|dispute|wrong|no|not right|incorrect|check)\b/;

function localDateIso(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Groups a site's finished-but-unapproved shifts by the day they started, so a
 * supervisor approves a shift rather than a person at a time. One message about
 * "Tue 5 Aug, 3 people, 24.0 hrs" beats three messages about individuals.
 */
function groupForSignoff(shifts, now = new Date()) {
  const groups = new Map();
  for (const shift of shifts) {
    if (!shift.clockOut || shift.clockOut.denied) continue;
    if (shift.approvedAt || shift.queriedAt) continue;
    if (shift.clockIn && shift.clockIn.flaggedForReview) continue; // still a manager's call

    const out = new Date(shift.clockOut.time).getTime();
    if (now.getTime() - out < SETTLE_MS) continue;      // let stragglers clock out
    if (now.getTime() - out > ASK_WINDOW_MS) continue;  // too old to chase

    const key = `${shift.siteId || "no-site"}|${localDateIso(shift.clockIn.time)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shift);
  }
  return groups;
}

/**
 * Asks each site's requesters to sign off yesterday's shifts.
 *
 * Idempotent on `signoffAskedAt`, so the dispatcher's tick can call this every
 * thirty seconds without messaging a supervisor repeatedly.
 */
async function sweepSignoffs(tenantId, deps, sendOpts = {}, now = new Date()) {
  const { shiftsStore, siteStore, staffStore } = deps;
  const result = { asked: 0, groups: 0 };

  const since = new Date(now.getTime() - ASK_WINDOW_MS).toISOString();
  const shifts = await shiftsStore.listRecentByTenant(tenantId, since);
  const groups = groupForSignoff(shifts, now);

  for (const [key, group] of groups) {
    // Only ask once per group. If any shift in it has been asked about, the
    // supervisor already has the message.
    if (group.some((s) => s.signoffAskedAt)) continue;

    const siteId = key.split("|")[0];
    const site = siteId !== "no-site" ? await siteStore.findById(siteId) : null;
    const requesters = (site && site.requesters) || [];
    if (!requesters.length) continue; // nobody to ask; the operator approves it

    const lines = [];
    let totalHours = 0;
    for (const shift of group) {
      const person = await staffStore.findByPhone(shift.staffPhone);
      lines.push(`· ${clientFacingLine(shift, person && person.name)}`);
      totalHours += workedHours(shift);
    }

    const dateLabel = new Date(group[0].clockIn.time).toLocaleDateString("en-AU", {
      weekday: "short", day: "numeric", month: "short",
    });
    const body = [
      `Shift complete — ${site ? site.name : "your site"}, ${dateLabel}.`,
      ...lines,
      `${totalHours.toFixed(1)} hrs total.`,
      "Reply APPROVE to sign off, or QUERY plus a note if something's wrong.",
    ].join("\n");

    for (const requester of requesters) {
      try {
        await sendText(requester.phone, body, sendOpts);
        result.asked += 1;
      } catch (err) {
        console.error(`[signoff] couldn't ask ${requester.phone}:`, err.message);
      }
    }
    for (const shift of group) await shiftsStore.markSignoffAsked(shift.shiftId);
    result.groups += 1;
  }

  if (result.groups) {
    console.log(`[signoff] asked about ${result.groups} shift group(s), ${result.asked} message(s)`);
  }
  return result;
}

/** Whether a client's message is answering a sign-off request. */
function looksLikeSignoffReply(body) {
  return APPROVE_RE.test(body) || QUERY_RE.test(body);
}

/**
 * Handles APPROVE / QUERY from a requester.
 *
 * Applies to every shift they were last asked about, because that is what the
 * message they are replying to covered. Approving one person while silently
 * leaving two unapproved would be a worse surprise than approving the group.
 */
async function handleSignoffReply(from, sites, body, deps, sendOpts = {}, now = new Date()) {
  const { shiftsStore, staffStore } = deps;
  const tenantId = sites[0].tenantId;
  const siteIds = new Set(sites.map((s) => s.siteId));
  const approve = APPROVE_RE.test(body);

  const since = new Date(now.getTime() - ASK_WINDOW_MS).toISOString();
  const all = await shiftsStore.listRecentByTenant(tenantId, since);

  // The most recent group this requester was actually asked about.
  const asked = all
    .filter(
      (s) =>
        siteIds.has(s.siteId) && s.signoffAskedAt && !s.approvedAt && !s.queriedAt &&
        s.clockOut && !s.clockOut.denied
    )
    .sort((a, b) => (a.signoffAskedAt > b.signoffAskedAt ? -1 : 1));

  if (!asked.length) {
    await sendText(
      from,
      "Nothing waiting for your sign-off right now. I'll message you when a shift's finished.",
      sendOpts
    );
    return true;
  }

  const latestAsk = asked[0].signoffAskedAt;
  const group = asked.filter((s) => s.signoffAskedAt === latestAsk);

  const note = approve ? null : body.replace(QUERY_RE, "").trim() || null;
  for (const shift of group) {
    await shiftsStore.signOffShift(shift.shiftId, { approve, by: from, note });
  }

  if (approve) {
    const invoiceDate = new Date(group[0].clockIn.time).toLocaleDateString("en-AU", {
      day: "numeric", month: "short",
    });
    let hours = 0;
    for (const shift of group) hours += workedHours(shift);
    await sendText(
      from,
      `Signed off — ${hours.toFixed(1)} hrs. This goes on your ${invoiceDate} invoice.`,
      sendOpts
    );
    return true;
  }

  const names = [];
  for (const shift of group) {
    const person = await staffStore.findByPhone(shift.staffPhone);
    names.push(person ? person.name : shift.staffPhone);
  }
  await sendText(
    from,
    `Noted — I've flagged ${names.join(", ")} for review and held it off your invoice. ` +
      "Someone will call you today.",
    sendOpts
  );
  console.warn(`[signoff] queried by ${from}: ${note || "(no note)"}`);
  return true;
}

module.exports = {
  sweepSignoffs,
  handleSignoffReply,
  looksLikeSignoffReply,
  groupForSignoff,
  APPROVE_RE,
  QUERY_RE,
  SETTLE_MS,
  ASK_WINDOW_MS,
};
