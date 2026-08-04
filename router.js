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

/**
 * Route a single incoming WhatsApp message.
 *
 * Build step 2 status: clock in/out and breaks are real. Stock (photo),
 * P&L (photo), and recipe lookup are still stubbed — each arrives as its
 * own handler module in later steps (frontend unified, backend modular —
 * decisions log).
 *
 * @param {object} message   One entry from value.messages[] in the webhook payload
 * @param {object} deps      { staffStore, tenantStore, shiftsStore, pendingActions }
 * @param {{tenantId: string, phoneNumberId: string, token: string|null}|null} tenantContext
 *   Which venue's WhatsApp number this message arrived on (multi-tenant
 *   support). Null in a single-venue deployment — every downstream call
 *   then falls back to the WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_TOKEN env vars.
 */
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

  console.log(
    `[incoming] from=${from} type=${type} tenant=${tenantContext?.tenantId || "(default)"} staff=${staff ? `${staff.name}/${staff.role}@${staff.tenantId}` : "UNKNOWN"}`
  );

  if (!staff) {
    await sendText(
      from,
      "Hi! This number isn't registered with any venue yet. Ask your manager to add you, then message again.",
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
        `"roster" to see your shifts, "spend 420 bidfood" to log a delivery.`,
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
    await sendText(from, `Got the photo, ${staff.name} — invoice/stock/P&L photo handling arrives in a later build step.`, sendOpts);
    return;
  }

  await sendText(from, `Received a ${type} message — this type isn't handled yet.`, sendOpts);
}

module.exports = { handleIncoming };
