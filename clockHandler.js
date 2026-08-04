"use strict";

const { sendText, sendLocationRequest } = require("./whatsapp");
const { checkGeofence } = require("./geofence");
const { resolveSiteForClockIn, describeResolutionFailure, resolutionLabel } = require("./siteResolver");

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
 * The geofence comes from the **site** on the assigned shift, resolved by
 * siteResolver.js — not from the tenant. That is the point of build order
 * step 1 in docs/agencymodelshape.md: an agency sends one staff pool to
 * fifteen buildings, so a tenant-level radius would flag fourteen of them.
 * Clock-in resolves the site and stamps it on the shift; clock-out re-checks
 * against that same stamped site, so the two ends of a shift can never be
 * measured against different buildings.
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
  const { shiftsStore, pendingActions } = deps;
  const reported = { lat: location.latitude, lng: location.longitude };

  // The location we were waiting for has arrived — the pending action is spent
  // either way, so clear it before any branch can return early.
  pendingActions.clear(from);

  if (action === "clock_in") {
    await clockIn(from, staff, reported, deps, sendOpts);
    return;
  }
  await clockOut(from, staff, reported, deps, sendOpts);
}

async function clockIn(from, staff, reported, deps, sendOpts) {
  const { shiftsStore } = deps;

  const resolution = await resolveSiteForClockIn({ staff: { ...staff, phone: from }, deps });
  if (!resolution.geofence) {
    console.error(
      `[clock] cannot resolve a site for ${from} @ ${staff.tenantId}: ${resolution.reason}`
    );
    await sendText(from, describeResolutionFailure(resolution), sendOpts);
    return;
  }

  const result = checkGeofence(reported, resolution.geofence);
  const site = resolution.site;
  const siteLabel = site ? site.name : "the venue";
  console.log(
    `[clock] in ${from} site=${resolutionLabel(resolution)} via=${resolution.source} ` +
      `dist=${result.distanceMeters}m within=${result.withinRadius}`
  );

  if (!result.withinRadius) {
    await recordFlaggedAttempt(shiftsStore, staff, from, reported, result, resolution);
    await sendText(
      from,
      `You look to be about ${result.distanceMeters}m from ${siteLabel}, which is outside the clock-in range. ` +
        `I've flagged this for your manager to review — they can approve it if needed.`,
      sendOpts
    );
    return;
  }

  const { shiftId } = await shiftsStore.openShift({
    tenantId: staff.tenantId,
    staffPhone: from,
    department: staff.department || null,
    siteId: site ? site.siteId : null,
    siteName: site ? site.name : null,
    clockIn: {
      time: new Date().toISOString(),
      lat: reported.lat,
      lng: reported.lng,
      withinRadius: true,
      distanceMeters: result.distanceMeters,
      siteSource: resolution.source,
    },
  });
  await sendText(
    from,
    `Clocked in at ${siteLabel}, ${staff.name} — have a good shift! (${shiftId})`,
    sendOpts
  );
}

async function clockOut(from, staff, reported, deps, sendOpts) {
  const { shiftsStore } = deps;

  const openShift = await shiftsStore.findOpenShift(from);
  if (!openShift) {
    await sendText(from, 'I don\'t see an open shift for you to clock out of. Message "in" if you haven\'t clocked in yet.', sendOpts);
    return;
  }

  if (hasActiveBreak(openShift)) {
    await sendText(from, 'You\'re still on break — message "back" to end your break before clocking out.', sendOpts);
    return;
  }

  // Measured against the site stamped on this shift at clock-in, so both ends
  // of a shift are always compared to the same building.
  const resolution = await resolveSiteForClockIn({
    staff: { ...staff, phone: from },
    siteId: openShift.siteId || null,
    deps,
  });

  // A clock-out is never refused. Someone finishing a shift has already worked
  // the hours; losing them because a site was deleted mid-shift would be a
  // worse failure than an unverified location. Record what we know instead.
  const clockOutRecord = {
    time: new Date().toISOString(),
    lat: reported.lat,
    lng: reported.lng,
  };
  if (resolution.geofence) {
    const result = checkGeofence(reported, resolution.geofence);
    clockOutRecord.withinRadius = result.withinRadius;
    clockOutRecord.distanceMeters = result.distanceMeters;
  } else {
    console.warn(
      `[clock] out ${from} shift=${openShift.shiftId} unverified location: ${resolution.reason}`
    );
    clockOutRecord.withinRadius = null;
    clockOutRecord.distanceMeters = null;
    clockOutRecord.geofenceUnavailable = resolution.reason;
  }

  await shiftsStore.closeShift(openShift.shiftId, clockOutRecord);

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

/**
 * An out-of-radius clock-in still becomes a shift, flagged for review. It
 * carries the site it was measured against — without that, a manager looking
 * at "142m away" has no way to know which building the 142m was from.
 */
async function recordFlaggedAttempt(shiftsStore, staff, from, reported, result, resolution) {
  try {
    const site = resolution.site;
    await shiftsStore.openShift({
      tenantId: staff.tenantId,
      staffPhone: from,
      department: staff.department || null,
      siteId: site ? site.siteId : null,
      siteName: site ? site.name : null,
      clockIn: {
        time: new Date().toISOString(),
        lat: reported.lat,
        lng: reported.lng,
        withinRadius: false,
        distanceMeters: result.distanceMeters,
        siteSource: resolution.source,
        flaggedForReview: true,
      },
    });
  } catch (err) {
    console.error("[clock] failed to record flagged attempt:", err);
  }
}

module.exports = { requestClockAction, handleLocationForClockAction, startBreak, endBreak };
