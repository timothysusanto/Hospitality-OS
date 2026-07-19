"use strict";

const { sendText } = require("./whatsapp");
const { requestClockAction, handleLocationForClockAction } = require("./clockHandler");

/**
 * Route a single incoming WhatsApp message.
 *
 * Build step 2 status: clock in/out is real. Stock (photo), P&L (photo),
 * and recipe lookup are still stubbed — each arrives as its own handler
 * module in later steps (frontend unified, backend modular — decisions log).
 *
 * @param {object} message   One entry from value.messages[] in the webhook payload
 * @param {object} deps      { staffStore, tenantStore, shiftsStore, pendingActions }
 */
async function handleIncoming(message, deps) {
  const { staffStore, pendingActions } = deps;
  const from = message.from;
  const type = message.type;

  const staff = await staffStore.findByPhone(from);

  console.log(
    `[incoming] from=${from} type=${type} staff=${staff ? `${staff.name}/${staff.role}@${staff.tenantId}` : "UNKNOWN"}`
  );

  if (!staff) {
    await sendText(
      from,
      "Hi! This number isn't registered with any venue yet. Ask your manager to add you, then message again."
    );
    return;
  }

  if (type === "text") {
    const body = (message.text?.body || "").trim().toLowerCase();

    if (body === "in") {
      await requestClockAction(from, "clock_in", deps);
      return;
    }
    if (body === "out") {
      await requestClockAction(from, "clock_out", deps);
      return;
    }

    await sendText(
      from,
      `Hi ${staff.name} — message "in" or "out" to clock in/out. Photo-based stock and P&L flows arrive in a later build step.`
    );
    return;
  }

  if (type === "location") {
    const pending = pendingActions.get(from);
    if (!pending) {
      await sendText(from, "Thanks for the location — but I wasn't expecting one right now. Message \"in\" or \"out\" first.");
      return;
    }
    await handleLocationForClockAction(from, staff, message.location, pending, deps);
    return;
  }

  if (type === "image") {
    await sendText(from, `Got the photo, ${staff.name} — invoice/stock/P&L photo handling arrives in a later build step.`);
    return;
  }

  await sendText(from, `Received a ${type} message — this type isn't handled yet.`);
}

module.exports = { handleIncoming };
