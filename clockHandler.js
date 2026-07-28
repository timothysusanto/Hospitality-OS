"use strict";

const { sendText, sendLocationRequest } = require("./whatsapp");
const { checkGeofence } = require("./geofence");

/**
 * Handles the clock in/out flow, plus mid-shift breaks. Clock in/out is
 * two-step by necessity: WhatsApp can only get a location when the user
 * deliberately shares one (there is no silent background read, unlike a
 * native app) — so "in"/"out" as text triggers a location request, and the
 * actual clock event happens when the location message arrives.
 *
 * Breaks don't need a location share (staff is already on-site) — "break"
 * and "back" act immediately on the text message alone.
 *
 * Every function here takes a `sendOpts` param, forwarded straight to
 * whatsapp.js — {} in a single-venue deployment (falls back to env vars),
 * or {phoneNumberId, token} once a venue has its own WhatsApp number.
 */

async function requestClockAction(from, action, deps, sendOpts = {}) {
  deps.pendingActions.set(from, action);
  const label = action === "clock_in" ? "clock in" : "clock out";
  await sendLocationRequest(from, `Share your location to ${label}.`, sendOpts);
}

async function handleLocationForClockAction(from, staff, location, action, deps, sendOpts = {}) {
  const { tenantStore, shiftsStore, pendingActions } = deps;

  const venue = await tenantStore.findById(staff.tenantId);
  if (!venue || !venue.geofence) {
    console.error(`[clock] no geofence configured for tenant ${staff.tenantId}`);
    await sendText(from, "Something's not set up right on our end — please tell your manager: no venue location configured.", sendOpts);
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
      await recordFlaggedAttempt(shiftsStore, staff, location, result);
      await sendText(
        from,
        `You look to be about ${result.distanceMeters}m from the venue, which is outside the clock-in range. ` +
          `I've flagged this for your manager to review — they can approve it if needed.`,
        sendOpts
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
    await sendText(from, `Clocked in, ${staff.name} — have a good shift! (${shiftId})`, sendOpts);
    return;
  }

  // action === "clock_out"
  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift) {
    await sendText(from, 'I don\'t see an open shift for you to clock out of. Message "in" if you haven\'t clocked in yet.', sendOpts);
    return;
  }

  if (hasActiveBreak(openShift)) {
    await sendText(from, 'You\'re still on break — message "back" to end your break before clocking out.', sendOpts);
    return;
  }

  await shiftsStore.closeShift(openShift.shiftId, {
    time: new Date().toISOString(),
    lat: location.latitude,
    lng: location.longitude,
    withinRadius: result.withinRadius,
    distanceMeters: result.distanceMeters,
  });

  const workedMs = shiftDurationMinusBreaks(openShift, Date.now());
  const hours = (workedMs / 1000 / 60 / 60).toFixed(1);
  await sendText(from, `Clocked out, ${staff.name} — that was a ${hours}hr shift. See you next time!`, sendOpts);
}

async function startBreak(from, staff, deps, sendOpts = {}) {
  const { shiftsStore } = deps;
  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift) {
    await sendText(from, 'You\'re not clocked in right now, so there\'s no shift to take a break from. Message "in" first.', sendOpts);
    return;
  }
  if (hasActiveBreak(openShift)) {
    await sendText(from, "You're already on break — message \"back\" when you're ready to resume.", sendOpts);
    return;
  }
  try {
    await shiftsStore.startBreak(openShift.shiftId, new Date().toISOString());
    await sendText(from, `Break started, ${staff.name} — message "back" when you're back on the floor.`, sendOpts);
  } catch (err) {
    console.error("[break] failed to start break:", err);
    await sendText(from, "Couldn't start your break just now — please try again in a moment.", sendOpts);
  }
}

async function endBreak(from, staff, deps, sendOpts = {}) {
  const { shiftsStore } = deps;
  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift || !hasActiveBreak(openShift)) {
    await sendText(from, 'You\'re not currently on a break. Message "break" to start one, or "out" to clock out.', sendOpts);
    return;
  }
  try {
    const updated = await shiftsStore.endBreak(openShift.shiftId, new Date().toISOString());
    const breaks = updated.breaks || [];
    const last = breaks[breaks.length - 1];
    const breakMinutes = Math.round((new Date(last.end) - new Date(last.start)) / 1000 / 60);
    await sendText(from, `Welcome back, ${staff.name} — that was a ${breakMinutes} min break.`, sendOpts);
  } catch (err) {
    console.error("[break] failed to end break:", err);
    await sendText(from, "Couldn't end your break just now — please try again in a moment.", sendOpts);
  }
}

function hasActiveBreak(shift) {
  const breaks = shift.breaks || [];
  const last = breaks[breaks.length - 1];
  return Boolean(last && !last.end);
}

function shiftDurationMinusBreaks(shift, nowMs) {
  const totalMs = nowMs - new Date(shift.clockIn.time).getTime();
  const breaks = shift.breaks || [];
  const breakMs = breaks.reduce((sum, b) => {
    if (!b.end) return sum;
    return sum + (new Date(b.end).getTime() - new Date(b.start).getTime());
  }, 0);
  return Math.max(0, totalMs - breakMs);
}

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

module.exports = { requestClockAction, handleLocationForClockAction, startBreak, endBreak };
