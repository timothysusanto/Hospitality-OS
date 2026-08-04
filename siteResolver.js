"use strict";

/**
 * Which building is this person supposed to be at right now?
 *
 * This is the whole of build order step 1 (docs/agencymodelshape.md): the
 * geofence a clock-in is checked against comes from the site on the assigned
 * shift, not from the tenant. An agency sends one pool of casuals to fifteen
 * hotels; a tenant-level geofence would flag fourteen of them.
 *
 * Resolution order, most specific first:
 *
 *   1. `shift`         — the open shift already names its site (clock-out,
 *                        breaks, manager review: always re-check against the
 *                        building the person was actually clocked in at).
 *   2. `roster`        — the assignment for that date names a site.
 *   3. `only-site`     — the tenant has exactly one active site, so there is
 *                        nothing to be ambiguous about. This is what makes a
 *                        single-venue deployment need no roster changes.
 *   4. `legacy-tenant` — no sites at all, but the tenant still carries the
 *                        pre-sites `geofence` field. Keeps deployments that
 *                        haven't created a site yet working unchanged.
 *
 * When none of those resolve, the answer is an explicit refusal with a
 * `reason`, never a guess. Guessing is how you get a clock-in validated
 * against the wrong hotel, which is worse than not validating it at all.
 */

/**
 * @typedef {import("./siteStore").SiteRecord} SiteRecord
 * @typedef {import("./siteStore").Geofence} Geofence
 *
 * @typedef {object} SiteResolution
 * @property {SiteRecord|null} site      The resolved site, or null. Null with a
 *   geofence means the legacy tenant fallback — there is no site document.
 * @property {Geofence|null} geofence    The geofence to check against.
 * @property {string|null} source        "shift" | "roster" | "only-site" | "legacy-tenant"
 * @property {string|null} reason        Why it failed: "NO_GEOFENCE_CONFIGURED" |
 *   "AMBIGUOUS_SITE" | "SITE_MISSING" | "SITE_HAS_NO_GEOFENCE"
 * @property {SiteRecord[]} candidates   The active sites in play when ambiguous,
 *   so the caller can name them in a message to staff.
 */

/** Hour of the local morning before which a clock-in may belong to yesterday. */
const NIGHT_SHIFT_CARRYOVER_HOUR = 5;

function fail(reason, candidates = []) {
  return { site: null, geofence: null, source: null, reason, candidates };
}

function resolved(site, source) {
  return { site, geofence: site.geofence, source, reason: null, candidates: [] };
}

/** Local YYYY-MM-DD for a Date — the roster is keyed in the venue's own days. */
function localDateIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The roster date(s) a clock-in at `at` could belong to. Normally just that
 * day. Before 05:00 it could also be the night shift that started yesterday —
 * "a night belongs to the date it starts on" (docs/agencymodelshape.md), so a
 * porter clocking in at 00:20 is looking for yesterday's assignment.
 * @param {Date} at @returns {string[]}
 */
function candidateRosterDates(at) {
  const dates = [localDateIso(at)];
  if (at.getHours() < NIGHT_SHIFT_CARRYOVER_HOUR) {
    const yesterday = new Date(at.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    dates.push(localDateIso(yesterday));
  }
  return dates;
}

/**
 * Resolves the site for a clock-in.
 *
 * @param {object} params
 * @param {object} params.staff             The staff record (needs tenantId, phone).
 * @param {Date} [params.at]               When the clock-in is happening. Defaults to now.
 * @param {string|null} [params.siteId]    A site already decided elsewhere — an open
 *   shift's own siteId, or an explicit override. Short-circuits everything below it.
 * @param {object} params.deps             { siteStore, rosterStore, tenantStore }
 * @returns {Promise<SiteResolution>}
 */
async function resolveSiteForClockIn({ staff, at = new Date(), siteId = null, deps }) {
  const { siteStore, rosterStore, tenantStore } = deps;
  const phone = staff.phone;
  const tenantId = staff.tenantId;

  // 1. Already decided — the shift names its site.
  if (siteId) {
    const site = await siteStore.findById(siteId);
    if (!site) return fail("SITE_MISSING");
    if (!site.geofence) return fail("SITE_HAS_NO_GEOFENCE");
    return resolved(site, "shift");
  }

  // 2. The roster assignment for this date.
  if (rosterStore && phone) {
    for (const dateIso of candidateRosterDates(at)) {
      const assignment = await rosterStore.findAssignment(tenantId, dateIso, phone);
      if (!assignment || !assignment.siteId) continue;
      const site = await siteStore.findById(assignment.siteId);
      // A rostered site that has since been deactivated is still where the
      // person was sent — honour it rather than falling through to a guess.
      if (site && site.geofence) return resolved(site, "roster");
      console.warn(
        `[sites] ${phone} is rostered to "${assignment.siteId}" on ${dateIso}, but that site ` +
          `${site ? "has no geofence" : "no longer exists"} — falling through`
      );
    }
  }

  // 3. Exactly one active site: unambiguous by definition.
  const allSites = await siteStore.listByTenant(tenantId, { includeInactive: true });
  const active = allSites.filter((s) => s.active !== false);
  const withGeofence = active.filter((s) => s.geofence);
  if (withGeofence.length === 1) return resolved(withGeofence[0], "only-site");

  // 4. The pre-sites tenant geofence — only for a tenant that has never had a
  //    site. Once one exists, deactivating it must not silently reopen a stale
  //    tenant-wide radius.
  if (allSites.length === 0 && tenantStore) {
    const tenant = await tenantStore.findById(tenantId);
    if (tenant && tenant.geofence) {
      return {
        site: null,
        geofence: tenant.geofence,
        source: "legacy-tenant",
        reason: null,
        candidates: [],
      };
    }
  }

  if (withGeofence.length > 1) return fail("AMBIGUOUS_SITE", withGeofence);
  return fail("NO_GEOFENCE_CONFIGURED", active);
}

/**
 * Staff-facing explanation for a resolution that failed. Deliberately says
 * what to do next rather than naming a field — the reader is a casual on a
 * loading dock, not an operator.
 * @param {SiteResolution} resolution
 */
function describeResolutionFailure(resolution) {
  switch (resolution.reason) {
    case "AMBIGUOUS_SITE": {
      const names = resolution.candidates.map((s) => s.name).join(", ");
      return (
        "I don't know which site you're at today, so I can't clock you in. " +
        `Ask your manager to put you on the roster for one of: ${names}.`
      );
    }
    case "SITE_MISSING":
      return "The site on your shift no longer exists — please tell your manager so they can reassign you.";
    case "SITE_HAS_NO_GEOFENCE":
    case "NO_GEOFENCE_CONFIGURED":
    default:
      return "Something's not set up right on our end — please tell your manager: no site location configured.";
  }
}

/** A short label for logs and shift records: the site name, or the legacy note. */
function resolutionLabel(resolution) {
  if (resolution.site) return `${resolution.site.name} (${resolution.site.siteId})`;
  if (resolution.source === "legacy-tenant") return "tenant geofence (no site configured)";
  return "unresolved";
}

module.exports = {
  resolveSiteForClockIn,
  describeResolutionFailure,
  resolutionLabel,
  candidateRosterDates,
  localDateIso,
  NIGHT_SHIFT_CARRYOVER_HOUR,
};
