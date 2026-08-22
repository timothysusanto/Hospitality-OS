"use strict";

const { sendText } = require("./whatsapp");
const { requestClockAction, handleLocationForClockAction, startBreak, endBreak } = require("./clockHandler");
const { handleAvailCommand, handleDateException, handleRosterQuery } = require("./availabilityHandler");
const { handleSpendCommand } = require("./foodCostHandler");
const { handleOfferReply, looksLikeOfferReply } = require("./offerHandler");
const {
  looksLikeAvailabilityReply, handleSameAgain, handleNotAvailable,
  handleFreeToday, handleShorthand, SAME_RE, NONE_RE, TODAY_RE,
} = require("./availabilityCapture");
const { handleClientMessage, requesterSites } = require("./intakeHandler");

/**
 * Fallback tenant for a sender we can't attribute — matches server.js's
 * DASHBOARD_TENANT_ID. Only used to look up whether an unknown number is a
 * registered requester; it grants nothing on its own.
 */
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || "demo-venue";

/**
 * Route a single incoming WhatsApp message.
 *
 * ## One number, two conversations
 *
 * Staff and hotels run on the same WhatsApp number, and **sender identity
 * decides which conversation you're in** (docs/agencymodelshape.md step 4). The
 * order below matters:
 *
 *   1. A number registered as a requester on a site is a **client** ordering
 *      staff. Checked first, because a hotel manager who is also on the staff
 *      list — an agency's own supervisor covering a shift — is ordering when
 *      they type "need 3 housekeepers", not clocking in.
 *   2. A number in the staff collection is a **worker**.
 *   3. Anything else is asked to have its manager register it. Only registered
 *      numbers can order, and only registered numbers can work.
 *
 * A client's message never reaches the staff commands, so "no" from a hotel
 * cancelling a draft can't be read as declining a shift offer.
 *
 * @param {object} message   One entry from value.messages[] in the webhook payload
 * @param {object} deps      stores, pendingActions, and optionally `dispatcher`
 * @param {{tenantId: string, phoneNumberId: string, token: string|null}|null} tenantContext
 *   Which venue's WhatsApp number this message arrived on (multi-tenant
 *   support). Null in a single-venue deployment — every downstream call
 *   then falls back to the WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_TOKEN env vars.
 */
const { handleWalletCommand, handleWalletReply, handleCredentialPhoto } = require("./walletHandler");
const {
  handleTempsCommand, handleFoodSafetyReply, handleCleanCommand,
  handleDeliveryCommand, handleFoodSafetyPhoto,
} = require("./foodSafetyHandler");
const { handleTrainCommand, handleTrainingReply } = require("./trainingHandler");

async function handleIncoming(message, deps, tenantContext = null) {
  const { staffStore, pendingActions } = deps;
  const from = message.from;
  const type = message.type;

  // sendOpts is passed to every sendText/sendLocationRequest call below so
  // replies go out from the correct venue's WhatsApp number once a venue
  // has one of its own — see whatsapp.js.
  const sendOpts = tenantContext
    ? { phoneNumberId: tenantContext.phoneNumberId, token: tenantContext.token || undefined }
    : {};

  const staff = await staffStore.findByPhone(from);
  const tenantId = tenantContext?.tenantId || (staff && staff.tenantId) || DEFAULT_TENANT_ID;
  const clientSites = await requesterSites(tenantId, from, deps);

  console.log(
    `[incoming] from=${from} type=${type} tenant=${tenantId} ` +
      `as=${clientSites ? `client(${clientSites.map((s) => s.siteId).join("|")})` : staff ? `${staff.name}/${staff.role}` : "UNKNOWN"}`
  );

  // 1. A hotel ordering staff.
  if (clientSites && type === "text") {
    const body = (message.text?.body || "").trim().toLowerCase();
    await handleClientMessage(from, clientSites, body, deps, sendOpts);
    return;
  }
  if (clientSites) {
    await sendText(
      from,
      "Thanks — I can only read text messages here. Tell me what you need, e.g. " +
        '"3 housekeepers tomorrow 7am-3pm".',
      sendOpts
    );
    return;
  }

  if (!staff) {
    await sendText(
      from,
      "Hi! This number isn't registered yet. If you're staff, ask your manager to add you. " +
        "If you're booking staff, ask your manager to register this number for your hotel. " +
        "Then message again.",
      sendOpts
    );
    return;
  }

  if (type === "text") {
    const body = (message.text?.body || "").trim().toLowerCase();

    if (body === "in") {
      await requestClockAction(from, "clock_in", deps, sendOpts);
      return;
    }
    if (body === "out") {
      await requestClockAction(from, "clock_out", deps, sendOpts);
      return;
    }
    if (body === "break") {
      await startBreak(from, staff, deps, sendOpts);
      return;
    }
    if (body === "back") {
      await endBreak(from, staff, deps, sendOpts);
      return;
    }
    if (body === "avail" || body.startsWith("avail ")) {
      await handleAvailCommand(from, staff, body, deps, sendOpts);
      return;
    }
    if (body.startsWith("off ") || body.startsWith("on ")) {
      await handleDateException(from, staff, body, deps, sendOpts);
      return;
    }
    if (body === "roster") {
      await handleRosterQuery(from, staff, deps, sendOpts);
      return;
    }
    if (body === "spend" || body.startsWith("spend ")) {
      await handleSpendCommand(from, staff, body, deps, sendOpts);
      return;
    }
    // Credential wallet — "wallet" lists; and while a photo draft is pending
    // (10-min window), yes/no/corrections belong to it. handleWalletReply
    // returns false when nothing is pending, so it can never shadow the
    // availability words or a shift-offer yes/no.
    if (body === "wallet") {
      await handleWalletCommand(from, staff, tenantId, deps, sendOpts);
      return;
    }
    // Food safety diary (Hospitality Edition) — guided temp runs, cleaning
    // checklist, delivery receiving. Same pattern as the wallet: fixed words
    // first, then pending-gated reply hooks that return false when idle.
    if (body === "temps") {
      await handleTempsCommand(from, staff, tenantId, deps, sendOpts);
      return;
    }
    if (body === "clean" || body.startsWith("clean ")) {
      await handleCleanCommand(from, staff, body, tenantId, deps, sendOpts);
      return;
    }
    if (body.startsWith("delivery")) {
      await handleDeliveryCommand(from, staff, body, tenantId, deps, sendOpts);
      return;
    }
    if (body === "train" || body.startsWith("train ")) {
      await handleTrainCommand(from, staff, body, tenantId, deps, sendOpts);
      return;
    }
    if (await handleWalletReply(from, staff, body, tenantId, deps, sendOpts)) return;
    if (await handleFoodSafetyReply(from, staff, body, tenantId, deps, sendOpts)) return;
    if (await handleTrainingReply(from, staff, body, tenantId, deps, sendOpts)) return;
    // The weekly availability words — rungs 1, 2 and 5 of the capture ladder.
    if (looksLikeAvailabilityReply(body)) {
      if (TODAY_RE.test(body)) await handleFreeToday(from, staff, deps, sendOpts);
      else if (NONE_RE.test(body)) await handleNotAvailable(from, staff, deps, sendOpts);
      else if (SAME_RE.test(body)) await handleSameAgain(from, staff, deps, sendOpts);
      return;
    }
    // Answering a shift offer. Checked after the fixed words so it can never
    // shadow a clock or availability command, and only when the message
    // actually opens with a yes/no.
    if (looksLikeOfferReply(body)) {
      await handleOfferReply(from, staff, body, deps, sendOpts);
      return;
    }
    // Rung 4 — the shorthand. Last, because it is the only handler that reads a
    // free-form message, and it declines anything it can't parse into days and
    // blocks rather than guessing.
    if (await handleShorthand(from, staff, body, deps, sendOpts)) return;

    await sendText(
      from,
      `Hi ${staff.name} — commands: "in"/"out" to clock in/out, "break"/"back" for breaks, ` +
        `"yes"/"no" to answer a shift offer, "same" to repeat last week's availability, ` +
        `"today" to join today's pool, "mon am pm, fri all" to set your week, ` +
        `"roster" to see your shifts, "wallet" to see your credentials (or send a photo of one to file it), ` +
        `"temps" to run temperature checks, "clean" for the cleaning list, "train" for training modules, ` +
        `"spend 420 bidfood" to log a delivery.`,
      sendOpts
    );
    return;
  }

  if (type === "location") {
    const pending = pendingActions.get(from);
    if (!pending) {
      await sendText(from, "Thanks for the location — but I wasn't expecting one right now. Message \"in\" or \"out\" first.", sendOpts);
      return;
    }
    await handleLocationForClockAction(from, staff, message.location, pending, deps, sendOpts);
    return;
  }

  if (type === "image") {
    // A photo within 10 minutes of a diary entry attaches to it (probe
    // readings, delivery dockets); otherwise it's a credential for the wallet.
    if (await handleFoodSafetyPhoto(from, staff, message.image, tenantId, deps, sendOpts)) return;
    await handleCredentialPhoto(from, staff, message.image, tenantId, deps, sendOpts);
    return;
  }

  await sendText(from, `Received a ${type} message — this type isn't handled yet.`, sendOpts);
}

module.exports = { handleIncoming };
