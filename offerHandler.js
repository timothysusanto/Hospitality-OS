"use strict";

const { sendText } = require("./whatsapp");
const { acceptOffer, declineOffer } = require("./dispatch");

/**
 * Answering a shift offer over WhatsApp.
 *
 *   yes          -> take the only shift on offer
 *   yes H7K2     -> take that specific one, when several are open
 *   no / no H7K2 -> pass
 *
 * Parsing is forgiving, because these are typed one-handed while walking. The
 * one thing it will not do is guess which shift when more than one is pending —
 * accepting the wrong hotel sends somebody to the wrong side of the city.
 */

const YES_RE = /^(y|yes|yep|yeah|ok|okay|sure|take it|i'?ll take it)\b/;
const NO_RE = /^(n|no|nope|nah|pass|can'?t|cant)\b/;

/** Whether this message looks like an answer to an offer at all. */
function looksLikeOfferReply(body) {
  return YES_RE.test(body) || NO_RE.test(body);
}

/** Pulls a request ref out of "yes h7k2" / "yes ref h7k2". */
function extractRef(body) {
  const match = body.toUpperCase().match(/\b([ABCDEFGHJKMNPQRTUVWXYZ2346789]{4})\b/);
  return match ? match[1] : null;
}

function describeOffer(request) {
  const start = new Date(request.startsAt);
  const end = new Date(request.endsAt);
  const day = start.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  const t = (d) => d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  const role = request.role ? `${request.role} — ` : "";
  return `${role}${request.siteName || request.siteId}, ${day} ${t(start)}–${t(end)}`;
}

/**
 * Handles a yes/no reply. Returns true when the message was an offer answer,
 * so the router knows not to fall through to the help text.
 */
async function handleOfferReply(from, staff, body, deps, sendOpts = {}) {
  const { offersStore, requestsStore } = deps;
  const saidYes = YES_RE.test(body);
  const ref = extractRef(body);

  // Recently expired offers count as answerable: someone replying two minutes
  // after a ten-minute window closed is answering, and if seats are still open
  // there is no reason to turn them away. See offersStore.
  const pending = await offersStore.listAnswerableByPhone(from);

  if (!pending.length) {
    // Either they were too slow, or somebody else got it. Both are worth saying
    // out loud — silence here reads as the system being broken.
    await sendText(
      from,
      "You don't have any open shift offers right now. I'll message you as soon as something comes up.",
      sendOpts
    );
    return true;
  }

  let offer;
  if (ref) {
    offer = pending.find((o) => o.requestRef === ref);
    if (!offer) {
      await sendText(
        from,
        `I can't find an open offer with the code ${ref}. ${await listPendingText(pending, requestsStore)}`,
        sendOpts
      );
      return true;
    }
  } else if (pending.length === 1) {
    offer = pending[0];
  } else {
    // Never guess between two hotels.
    await sendText(
      from,
      `You've got ${pending.length} offers open — which one? ${await listPendingText(pending, requestsStore)}`,
      sendOpts
    );
    return true;
  }

  const request = await requestsStore.findById(offer.requestId);
  if (!request) {
    await offersStore.respond(offer.offerId, "expired");
    await sendText(from, "That shift has been withdrawn, sorry. I'll let you know about the next one.", sendOpts);
    return true;
  }

  if (!saidYes) {
    await declineOffer(offer, deps);
    await sendText(from, `No worries — passed on ${describeOffer(request)}.`, sendOpts);
    return true;
  }

  const result = await acceptOffer(offer, staff, deps, sendOpts);
  if (result.ok) {
    await sendText(
      from,
      `You're on: ${describeOffer(request)}.\nMessage "in" when you get there to clock on.`,
      sendOpts
    );
    return true;
  }

  // Lost the race, blocked by the compliance gate, or the request was pulled.
  // Say which — "already taken", "your RSA lapsed" and "cancelled" mean very
  // different things to someone who was about to travel across the city.
  const message = result.message
    ? result.message
    : result.reason === "ALREADY_FULL" || result.reason === "REQUEST_CLOSED"
      ? `Sorry — ${describeOffer(request)} has just been taken. You were quick, so you'll get the next one.`
      : "Couldn't lock that in just now — please try again in a moment.";
  await sendText(from, message, sendOpts);
  return true;
}

async function listPendingText(pending, requestsStore) {
  const lines = [];
  for (const offer of pending) {
    const request = await requestsStore.findById(offer.requestId);
    if (request) lines.push(`${offer.requestRef} — ${describeOffer(request)}`);
  }
  if (!lines.length) return "";
  return `Reply e.g. "yes ${pending[0].requestRef}".\n${lines.join("\n")}`;
}

module.exports = { handleOfferReply, looksLikeOfferReply, extractRef, describeOffer };
