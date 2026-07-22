"use strict";

/**
 * Geofence check — is a reported location within range of the venue?
 *
 * Note: WhatsApp's shared-location message does NOT include a GPS accuracy
 * radius (unlike native Core Location on iOS). We only get lat/lng. This is
 * why the radius itself must be generous (50-100m, per decisions log) —
 * it's absorbing normal GPS wobble on its own, not being told how much
 * wobble to expect.
 */

const EARTH_RADIUS_M = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine distance between two lat/lng points, in metres.
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * @param {{lat:number, lng:number}} reported   Location the staff member shared
 * @param {{lat:number, lng:number, radiusMeters:number}} venue
 * @returns {{ withinRadius: boolean, distanceMeters: number }}
 */
function checkGeofence(reported, venue) {
  const d = distanceMeters(reported.lat, reported.lng, venue.lat, venue.lng);
  return {
    withinRadius: d <= venue.radiusMeters,
    distanceMeters: Math.round(d),
  };
}

module.exports = { checkGeofence, distanceMeters };
