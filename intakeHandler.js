"use strict";

const { sendText } = require("./whatsapp");
const { parseRequest, MISSING_PROMPT } = require("./requestParser");
const { laneFor, seatsRemaining } = require("./requestsStore");
const { looksLikeSignoffReply, handleSignoffReply } = require("./signoffHandler");

/**
 * Client intake over chat — build order step 4 of docs/agencymodelshape.md.
 * This is what stops the phone ringing.
 *
 * ## One number, two conversations
 *
 * Staff and hotels run on the same WhatsApp number. **Sender identity decides
 * which conversation you're in** — the same gate that already turns away
 * unregistered numbers in router.js. A number registered as a requester on a
 * site is in the hotel conversation; a number in the staff collection is in the
 * staff one; anything else is asked to have its manager register it.
 *
 * ## Never dispatch on an unconfirmed parse
 *
 * The parser produces a draft and this module reads it back in structured form.
 * **That confirm step is the contract, the audit trail, and the guard against
 * sending thirty people** because somebody typed "30" meaning "3:00". A draft is
 * stored as a real request with `confirmedAt: null`, which the blast engine's
 * `listOpen` already excludes — so an unconfirmed order physically cannot
 * dispatch, rather than relying on this module remembering not to.
 *
 * ## Phone calls aren't banned, they're out-competed
 *
 * When one happens anyway, the operator types it into the dashboard against the
 * requester's number, which lands in the same collection with the same fields.
 * A written trail of what was ordered is what wins invoice disputes.
 */

const CONFIRM_RE = /^(confirm|confirmed|yes|y|yep|correct|go|send it|do it|ok|okay)\b/;
const CANCEL_RE = /^(cancel|no|nope|stop|wrong|edit|change)\b/;
const STATUS_RE = /^(status|update|where|how'?s|any luck|progress)\b/;

/**
 * Formats a draft the way it will be worked, so a hotel confirms what will
 * actually happen rather than what they typed.
 */
function describeDraft(draft) {
  const start = new Date(draft.startsAt);
  const end = new Date(draft.endsAt);
  const day = start.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const t = (d) => d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  const role = draft.role ? titleCase(draft.role) : "Staff";
  return [
    `${draft.headcount} × ${role} — ${draft.siteName || draft.siteId}`,
    `${day}, ${t(start)}–${t(end)}`,
  ].join("\n");
}

function titleCase(text) {
  return String(text)
    .split(/[-\s]+/)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Is this sender ordering staff rather than working shifts?
 * @returns {Promise<object[]|null>} the sites they may order for, or null
 */
async function requesterSites(tenantId, phone, deps) {
  const { siteStore } = deps;
  if (!siteStore || !siteStore.findByRequesterPhone) return null;
  const sites = await siteStore.findByRequesterPhone(tenantId, phone);
  return sites.length ? sites : null;
}

/**
 * The hotel-side conversation. Returns true when the message was handled.
 *
 * @param {string} from
 * @param {object[]} sites   Sites this requester may order for.
 * @param {string} body      Lower-cased message text.
 */
async function handleClientMessage(from, sites, body, deps, sendOpts = {}, now = new Date()) {
  const { requestsStore } = deps;
  const tenantId = sites[0].tenantId;

  // An unconfirmed draft is the only thing that can be confirmed or cancelled,
  // so find it before deciding what the message means.
  const draft = await findPendingDraft(tenantId, from, deps);

  if (draft && CONFIRM_RE.test(body)) {
    await requestsStore.confirm(draft.requestId);
    await sendText(
      from,
      `Confirmed — ${draft.ref}. Searching now, I'll message you as people accept.`,
      sendOpts
    );
    // The tick loop picks it up; kick it so a 5:40am order doesn't wait 30s.
    if (deps.dispatcher) deps.dispatcher.runOnce().catch(() => {});
    return true;
  }

  if (draft && CANCEL_RE.test(body)) {
    await requestsStore.close(draft.requestId, "cancelled");
    await sendText(
      from,
      "Cancelled — nothing has gone out. Send the details again and I'll read them back to you.",
      sendOpts
    );
    return true;
  }

  if (STATUS_RE.test(body)) {
    await sendStatus(from, tenantId, deps, sendOpts);
    return true;
  }

  // Signing off finished shifts. Checked before the order parser, and only when
  // there is no draft on the table — otherwise "ok" confirming an order would be
  // read as approving a timesheet.
  if (!draft && looksLikeSignoffReply(body)) {
    await handleSignoffReply(from, sites, body, deps, sendOpts, now);
    return true;
  }

  // Anything else is an attempt to order.
  const { draft: parsed, missing } = parseRequest(body, {
    sites,
    defaultSiteId: sites.length === 1 ? sites[0].siteId : null,
    now,
  });

  if (missing.length) {
    // Ask, never assume. A guess here costs a hotel a shift.
    const asks = missing.map((key) => MISSING_PROMPT[key]).filter(Boolean);
    await sendText(
      from,
      `I can nearly do that — I just need ${joinWords(asks)}.\n` +
        'Something like: "3 housekeepers tomorrow 7am-3pm".',
      sendOpts
    );
    return true;
  }

  // A new order supersedes an unconfirmed one, so a hotel correcting themselves
  // doesn't leave a stale draft that could be confirmed later by accident.
  if (draft) await requestsStore.close(draft.requestId, "cancelled");

  const created = await requestsStore.create({
    tenantId,
    siteId: parsed.siteId,
    siteName: parsed.siteName,
    role: parsed.role,
    startsAt: parsed.startsAt,
    endsAt: parsed.endsAt,
    headcount: parsed.headcount,
    requestedBy: from,
    lane: laneFor(parsed.startsAt, now),
    now: now.toISOString(),
    // The whole point: not dispatchable until a human confirms this reading.
    confirmedAt: null,
  });

  const lines = [describeDraft(parsed)];
  if (parsed.inferredEnd) {
    // Say so, rather than quietly inventing an eight-hour shift.
    lines.push("(I've assumed an 8 hour shift — tell me if it's different.)");
  }
  if (created.lane === "urgent") lines.push("This one's urgent, so it'll go out to the fast responders first.");
  lines.push('Reply CONFIRM to send it, or CANCEL to start again.');

  await sendText(from, lines.join("\n"), sendOpts);
  return true;
}

/** The requester's one outstanding unconfirmed draft, if any. */
async function findPendingDraft(tenantId, phone, deps) {
  const { requestsStore } = deps;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await requestsStore.listRecent(tenantId, since);
  return recent
    .filter((r) => r.requestedBy === phone && r.outcome === "open" && !r.confirmedAt)
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0] || null;
}

/**
 * The status loop back to the hotel. Sent on request, and pushed by the blast
 * engine as people accept (see dispatch.js notifyFillProgress).
 */
async function sendStatus(from, tenantId, deps, sendOpts) {
  const { requestsStore, staffStore, offersStore } = deps;
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const recent = await requestsStore.listRecent(tenantId, since);
  const mine = recent
    .filter((r) => r.requestedBy === from && r.outcome !== "cancelled")
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));

  if (!mine.length) {
    await sendText(from, "Nothing on order at the moment. Send me what you need and I'll get on it.", sendOpts);
    return;
  }

  const lines = [];
  for (const request of mine.slice(0, 5)) {
    if (!request.confirmedAt) {
      lines.push(`${request.ref} — waiting on your CONFIRM.`);
      continue;
    }
    const offers = await offersStore.listByRequest(request.requestId);
    const names = [];
    for (const offer of offers.filter((o) => o.outcome === "accepted")) {
      const person = await staffStore.findByPhone(offer.phone);
      names.push(person ? person.name : offer.phone);
    }
    const head = `${request.ref} — ${request.filled} of ${request.headcount} filled`;
    lines.push(names.length ? `${head}: ${names.join(", ")}` : `${head}. ${seatsRemaining(request)} still searching.`);
  }
  await sendText(from, lines.join("\n"), sendOpts);
}

function joinWords(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

module.exports = {
  handleClientMessage,
  requesterSites,
  findPendingDraft,
  describeDraft,
  sendStatus,
  CONFIRM_RE,
  CANCEL_RE,
  STATUS_RE,
};
