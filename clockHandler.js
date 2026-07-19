"use strict";

const { sendText, sendLocationRequest } = require("./whatsapp");
const { checkGeofence } = require("./geofence");

/**
 * Handles the clock in/out flow. Two-step by necessity: WhatsApp can only
 * get a location when the user deliberately shares one (there is no silent
 * background read, unlike a native app) — so "in"/"out" as text triggers a
 * location request, and the actual clock event happens when the location
 * message arrives.
 */

/**
 * Step 1: staff texts "in" or "out".
 */
async function requestClockAction(from, action, deps) {
  deps.pendingActions.set(from, action);
  const label = action === "clock_in" ? "clock in" : "clock out";
  await sendLocationRequest(from, `Share your location to ${label}.`);
}

/**
 * Step 2: staff shares a location, and we had a pending action for them.
 */
async function handleLocationForClockAction(from, staff, location, action, deps) {
  const { tenantStore, shiftsStore, pendingActions } = deps;

  const venue = await tenantStore.findById(staff.tenantId);
  if (!venue || !venue.geofence) {
    console.error(`[clock] no geofence configured for tenant ${staff.tenantId}`);
    await sendText(from, "Something's not set up right on our end — please tell your manager: no venue location configured.");
    pendingActions.clear(from);
    return;
  }

  const result = checkGeofence(
    { lat: location.latitude, lng: location.longitude },
    venue.geofence
  );

  pendingActions.clear(from);

  if (action === "clock_in") {
    if (!result.withinRadius) {
      // No accuracy data from WhatsApp (see geofence.js) — we can't tell
      // "bad signal" from "actually not there", so we don't hard-block.
      // Record the attempt and point to the manager-override path (the
      // manager dashboard, build step 3, will surface this for approval).
      await recordFlaggedAttempt(shiftsStore, staff, location, result);
      await sendText(
        from,
        `You look to be about ${result.distanceMeters}m from the venue, which is outside the clock-in range. ` +
          `I've flagged this for your manager to review — they can approve it if needed.`
      );
      return;
    }

    const { shiftId } = await shiftsStore.openShift({
      tenantId: staff.tenantId,
      staffPhone: from,
      department: staff.department || null,
      clockIn: {
        time: new Date().toISOString(),
        lat: location.latitude,
        lng: location.longitude,
        withinRadius: true,
        distanceMeters: result.distanceMeters,
      },
    });
    await sendText(from, `Clocked in, ${staff.name} — have a good shift! (${shiftId})`);
    return;
  }

  // action === "clock_out"
  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift) {
    await sendText(from, 'I don\'t see an open shift for you to clock out of. Message "in" if you haven\'t clocked in yet.');
    return;
  }

  await shiftsStore.closeShift(openShift.shiftId, {
    time: new Date().toISOString(),
    lat: location.latitude,
    lng: location.longitude,
    withinRadius: result.withinRadius,
    distanceMeters: result.distanceMeters,
  });

  const durationMs = Date.now() - new Date(openShift.clockIn.time).getTime();
  const hours = (durationMs / 1000 / 60 / 60).toFixed(1);
  await sendText(from, `Clocked out, ${staff.name} — that was a ${hours}hr shift. See you next time!`);
}

/**
 * Records an out-of-radius clock-in attempt so the (future) manager
 * dashboard has something to show and approve. The manager-facing override
 * UI itself is build step 3 — this just makes sure the data exists.
 */
async function recordFlaggedAttempt(shiftsStore, staff, location, result) {
  try {
    await shiftsStore.openShift({
      tenantId: staff.tenantId,
      staffPhone: staff.phone,
      department: staff.department || null,
      clockIn: {
        time: new Date().toISOString(),
        lat: location.latitude,
        lng: location.longitude,
        withinRadius: false,
        distanceMeters: result.distanceMeters,
        flaggedForReview: true,
      },
    });
  } catch (err) {
    console.error("[clock] failed to record flagged attempt:", err);
  }
}

module.exports = { requestClockAction, handleLocationForClockAction };
