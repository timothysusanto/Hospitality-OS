"use strict";

/**
 * HospitalityOS — webhook skeleton (build step 1 of backend-build-scope.md).
 *
 * Proves the pipe: WhatsApp message -> Meta Cloud API -> this webhook ->
 * sender lookup -> reply through the Send API. Nothing else.
 */

const express = require("express");
const path = require("path");
const { verifyMetaSignature } = require("./verifySignature");
const { sendText } = require("./whatsapp");
const { SLOT_LABELS } = require("./availabilityHandler");
const { handleIncoming } = require("./router");
const { buildStores } = require("./stores");
const { InMemoryPendingActions } = require("./pendingActions");
const { normalizeAssignment, normalizeAssignments } = require("./rosterStore");
const { normalizeGeofence, slugifySiteId, MIN_RADIUS_METERS, MAX_RADIUS_METERS } = require("./siteStore");
const { laneFor, seatsRemaining } = require("./requestsStore");
const { createDispatcher } = require("./dispatch");

// The single venue this build supports so far (see decisions log — multi-
// tenant support is a later step). The dashboard is scoped to this tenant.
const DASHBOARD_TENANT_ID = "demo-venue";

const app = express();
const {
  staffStore, tenantStore, siteStore, requestsStore, offersStore,
  shiftsStore, rosterStore, purchasesStore, backend,
} = buildStores();
const pendingActions = new InMemoryPendingActions();
const deps = {
  staffStore, tenantStore, siteStore, requestsStore, offersStore,
  shiftsStore, rosterStore, purchasesStore, pendingActions,
};

console.log(`[startup] data backend: ${backend}`);

/**
 * The blast engine's tick loop (docs/agencymodelshape.md step 2). All dispatch
 * state lives on the request documents, so starting this on boot picks up any
 * blast that was mid-flight when the process last stopped.
 *
 * Set DISPATCH_DISABLED=1 to run the server without it — useful when pointing
 * a second instance at the same Firestore project for debugging, so two tick
 * loops don't both blast the same request.
 */
const dispatcher = createDispatcher(DASHBOARD_TENANT_ID, deps, {});
if (process.env.DISPATCH_DISABLED === "1") {
  console.warn("[startup] DISPATCH_DISABLED=1 — the blast engine is NOT running");
} else {
  dispatcher.start();
}

// Capture the raw body — Meta's signature is computed over raw bytes,
// so verification must happen against them, not the parsed object.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * GET /webhook/whatsapp — Meta's one-time verification handshake.
 * Configured in the Meta App dashboard: Webhooks -> Callback URL + Verify Token.
 */
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[webhook] verification handshake OK");
    return res.status(200).send(challenge);
  }
  console.warn("[webhook] verification handshake FAILED");
  return res.sendStatus(403);
});

/**
 * POST /webhook/whatsapp — all incoming events.
 * Always 200 fast; process asynchronously. Meta retries on non-2xx and
 * slow responses, which causes duplicate processing.
 */
app.post("/webhook/whatsapp", (req, res) => {
  const signature = req.get("X-Hub-Signature-256");
  const appSecret = process.env.META_APP_SECRET;

  if (!verifyMetaSignature(req.rawBody, signature, appSecret)) {
    console.warn("[webhook] BAD SIGNATURE — rejecting");
    return res.sendStatus(403);
  }

  // Acknowledge immediately.
  res.sendStatus(200);

  // Then process. WhatsApp payload shape:
  // { entry: [ { changes: [ { value: { messages?: [...], statuses?: [...] } } ] } ] }
  const entries = req.body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      // Delivery/read receipts arrive as `statuses` — ignore in the skeleton.
      if (value.statuses) continue;

      // Which WhatsApp number this message arrived on. In a single-venue
      // deployment this is irrelevant (everything uses the env-var number).
      // In a multi-tenant setup, this is how we know which venue owns the
      // conversation *before* even looking up the sender as staff.
      const incomingPhoneNumberId = value.metadata?.phone_number_id || null;

      for (const message of value.messages ?? []) {
        resolveTenantAndHandle(message, incomingPhoneNumberId).catch((err) =>
          console.error("[handler] error:", err)
        );
      }
    }
  }
});

/**
 * Resolves which venue (tenant) owns the WhatsApp number a message arrived
 * on, then hands off to the router with that context attached. If no
 * matching tenant is found (e.g. phoneNumberId is missing, or this tenant
 * hasn't been given its own number yet), tenantContext is null — router.js
 * and clockHandler.js then fall back to the single-venue env vars, exactly
 * as before this change. This makes multi-tenant support additive, not a
 * breaking change to the existing single-venue deployment.
 */
async function resolveTenantAndHandle(message, incomingPhoneNumberId) {
  let tenantContext = null;
  if (incomingPhoneNumberId) {
    const tenant = await tenantStore.findByPhoneNumberId(incomingPhoneNumberId);
    if (tenant) {
      tenantContext = {
        tenantId: tenant.tenantId,
        phoneNumberId: tenant.phoneNumberId,
        token: tenant.whatsappToken || null,
      };
    }
  }
  await handleIncoming(message, deps, tenantContext);
}

/**
 * Manager dashboard (build step 3) — a page served directly by this server,
 * reading real data through the same admin Firestore connection the bot
 * already uses. No separate client-side Firebase config or security rules
 * needed: the browser never talks to Firestore directly, only to this
 * server's own API, which is gated by a shared key below.
 */
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

/**
 * Gate for everything under /api — requires a shared secret set as
 * MANAGER_DASHBOARD_PASSWORD in Railway's Variables tab. Accepts the key as
 * either a query param (?key=...) or an X-Dashboard-Key header.
 * If the env var isn't set at all, every request is rejected — safer than
 * silently allowing open access.
 */
function requireDashboardKey(req, res, next) {
  const expected = process.env.MANAGER_DASHBOARD_PASSWORD;
  if (!expected) {
    return res.status(500).json({ error: "MANAGER_DASHBOARD_PASSWORD is not set on the server." });
  }
  const provided = req.query.key || req.get("X-Dashboard-Key");
  if (provided !== expected) {
    return res.status(401).json({ error: "Invalid or missing dashboard key." });
  }
  next();
}

/**
 * GET /api/dashboard — everything the dashboard page needs in one call:
 * the venue's staff list and every shift record for this tenant. Sorting
 * into "on shift now" / "needs review" / "history" happens client-side in
 * dashboard.html, not here — keeps this endpoint a single simple query per
 * collection (no compound Firestore indexes required).
 */
app.get("/api/dashboard", requireDashboardKey, async (_req, res) => {
  try {
    // Scale discipline: never ship the whole shift history to the browser.
    // The dashboard only renders open shifts + a recent window (history table
    // caps at 25, hours/variance use 7 days), so 14 days covers everything.
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const [staff, openShifts, recentShifts, venue, sites] = await Promise.all([
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
      shiftsStore.listOpenByTenant(DASHBOARD_TENANT_ID),
      shiftsStore.listRecentByTenant(DASHBOARD_TENANT_ID, since),
      tenantStore.findById(DASHBOARD_TENANT_ID),
      siteStore.listByTenant(DASHBOARD_TENANT_ID, { includeInactive: true }),
    ]);
    const seen = new Set();
    const shifts = [...openShifts, ...recentShifts].filter((s) => {
      if (seen.has(s.shiftId)) return false;
      seen.add(s.shiftId);
      return true;
    });
    res.json({ staff, shifts, venue, sites });
  } catch (err) {
    console.error("[dashboard] failed to load data:", err);
    res.status(500).json({ error: "Failed to load dashboard data." });
  }
});

/**
 * POST /api/shifts/:id/review — Approve or Deny a flagged out-of-radius
 * clock-in. Body: { approve: boolean }.
 */
app.post("/api/shifts/:id/review", requireDashboardKey, async (req, res) => {
  try {
    const approve = Boolean(req.body?.approve);
    const updated = await shiftsStore.reviewFlaggedShift(req.params.id, approve);
    res.json({ ok: true, shift: updated });
  } catch (err) {
    console.error("[dashboard] failed to review shift:", err);
    res.status(500).json({ error: "Failed to update that shift." });
  }
});

/**
 * POST /api/staff — add or update a staff member for this venue.
 * Body: { phone, name, role, department }. `phone` is the Firestore
 * document ID (international format, no "+"), same convention as manual
 * setup — this just does it through the dashboard instead of by hand.
 */
app.post("/api/staff", requireDashboardKey, async (req, res) => {
  try {
    const { phone, name, role, department } = req.body || {};
    if (!phone || !name) {
      return res.status(400).json({ error: "phone and name are required." });
    }
    if (!["owner", "manager", "staff"].includes(role)) {
      return res.status(400).json({ error: 'role must be "owner", "manager", or "staff".' });
    }
    const wageRate = req.body.wageRate != null ? Number(req.body.wageRate) : null;
    if (wageRate != null && (!isFinite(wageRate) || wageRate < 0)) {
      return res.status(400).json({ error: "wageRate must be a non-negative number." });
    }
    await staffStore.upsert({
      phone: String(phone).trim(),
      tenantId: DASHBOARD_TENANT_ID,
      name: String(name).trim(),
      role,
      department: department ? String(department).trim() : null,
      wageRate,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[dashboard] failed to add staff:", err);
    res.status(500).json({ error: "Failed to add staff member." });
  }
});


/**
 * Sites — the buildings staff get sent to, and where the clock-in geofence
 * now lives (docs/agencymodelshape.md, build order step 1).
 *
 * GET /api/sites — every site for this tenant, inactive ones included so the
 * dashboard can show them greyed rather than silently losing them. Also
 * reports whether the tenant is still leaning on its pre-sites `geofence`
 * field, which is the one thing an operator needs prompting to fix.
 */
app.get("/api/sites", requireDashboardKey, async (_req, res) => {
  try {
    const [sites, venue] = await Promise.all([
      siteStore.listByTenant(DASHBOARD_TENANT_ID, { includeInactive: true }),
      tenantStore.findById(DASHBOARD_TENANT_ID),
    ]);
    res.json({
      sites,
      // True while clock-ins are still being checked against the tenant-level
      // radius because no site exists yet — see siteResolver.js step 4.
      usingLegacyTenantGeofence: sites.length === 0 && Boolean(venue && venue.geofence),
      legacyTenantGeofence: (venue && venue.geofence) || null,
    });
  } catch (err) {
    console.error("[sites] failed to list:", err);
    res.status(500).json({ error: "Failed to load sites." });
  }
});

/**
 * POST /api/sites — create or update a site.
 * Body: { siteId?, name, address?, geofence: {lat, lng, radiusMeters},
 *         requesters?: [{phone, name}], billRates?: {[role]: number} }
 *
 * `siteId` is a slug derived from the name when not supplied, so it reads
 * usefully on a shift record. It is never regenerated on update — renaming
 * "Hilton Sydney" must not orphan the shifts that reference hilton-sydney.
 */
app.post("/api/sites", requireDashboardKey, async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required." });

    const siteId = body.siteId ? slugifySiteId(body.siteId) : slugifySiteId(name);
    if (!siteId) {
      return res.status(400).json({ error: "name must contain at least one letter or number." });
    }

    // A site without coordinates can't validate a clock-in, so refuse the
    // half-configured version rather than storing a site that silently flags
    // everyone sent to it.
    const geofence = normalizeGeofence(body.geofence);
    if (!geofence) {
      return res.status(400).json({
        error:
          "geofence must be {lat, lng, radiusMeters} with a valid latitude and longitude. " +
          `radiusMeters is clamped to ${MIN_RADIUS_METERS}-${MAX_RADIUS_METERS}m.`,
      });
    }

    const requesters = Array.isArray(body.requesters)
      ? body.requesters
          .map((r) => ({
            phone: String((r && r.phone) || "").replace(/[^\d]/g, ""),
            name: r && r.name ? String(r.name).trim() : null,
          }))
          .filter((r) => r.phone)
      : undefined;

    let billRates;
    if (body.billRates && typeof body.billRates === "object") {
      billRates = {};
      for (const [role, rate] of Object.entries(body.billRates)) {
        const n = Number(rate);
        if (isFinite(n) && n >= 0) billRates[String(role).trim()] = n;
      }
    }

    const site = await siteStore.upsert(siteId, {
      tenantId: DASHBOARD_TENANT_ID,
      name,
      address: body.address,
      geofence,
      ...(requesters ? { requesters } : {}),
      ...(billRates ? { billRates } : {}),
      active: body.active !== false,
    });
    res.json({ ok: true, site });
  } catch (err) {
    console.error("[sites] failed to save:", err);
    res.status(500).json({ error: "Failed to save site." });
  }
});

/**
 * POST /api/sites/:id/active — deactivate or reactivate a site.
 * Body: { active: boolean }. Sites are never hard-deleted: shifts reference
 * them by id, and an invoice from three months ago still has to name the
 * building it was worked at.
 */
app.post("/api/sites/:id/active", requireDashboardKey, async (req, res) => {
  try {
    const site = await siteStore.setActive(req.params.id, Boolean(req.body?.active));
    res.json({ ok: true, site });
  } catch (err) {
    if (err.message === "SITE_NOT_FOUND") {
      return res.status(404).json({ error: "No site with that id." });
    }
    console.error("[sites] failed to change active state:", err);
    res.status(500).json({ error: "Failed to update site." });
  }
});

/**
 * Staffing requests and the blast engine (docs/agencymodelshape.md step 2).
 *
 * GET /api/requests — live requests first, then the last 7 days, each with a
 * summary of its offers so the operator can see a blast working: which wave
 * it's on, who's been asked, who has answered.
 */
app.get("/api/requests", requireDashboardKey, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [open, recent] = await Promise.all([
      requestsStore.listOpen(DASHBOARD_TENANT_ID),
      requestsStore.listRecent(DASHBOARD_TENANT_ID, since),
    ]);
    const seen = new Set();
    const requests = [...open, ...recent].filter((r) => {
      if (seen.has(r.requestId)) return false;
      seen.add(r.requestId);
      return true;
    });

    const withOffers = await Promise.all(
      requests.map(async (request) => {
        const offers = await offersStore.listByRequest(request.requestId);
        const tally = { pending: 0, accepted: 0, declined: 0, expired: 0, lost: 0 };
        for (const offer of offers) {
          if (tally[offer.outcome] !== undefined) tally[offer.outcome] += 1;
        }
        return {
          ...request,
          seatsRemaining: seatsRemaining(request),
          offers: tally,
          offered: offers.length,
          accepted: offers
            .filter((o) => o.outcome === "accepted")
            .map((o) => ({ phone: o.phone, respondedAt: o.respondedAt })),
        };
      })
    );

    withOffers.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
    res.json({ requests: withOffers });
  } catch (err) {
    console.error("[requests] failed to list:", err);
    res.status(500).json({ error: "Failed to load requests." });
  }
});

/**
 * POST /api/requests — raise a staffing request and start the blast.
 * Body: { siteId, role?, startsAt, endsAt, headcount, requestedBy? }
 *
 * The lane is NOT accepted from the body. It is derived from `startsAt`, so
 * nobody can mark their own request urgent to jump the queue — under twelve
 * hours out is urgent, and that is the only way to become urgent.
 */
app.post("/api/requests", requireDashboardKey, async (req, res) => {
  try {
    const body = req.body || {};

    const site = body.siteId ? await siteStore.findById(String(body.siteId)) : null;
    if (!site || site.tenantId !== DASHBOARD_TENANT_ID) {
      return res.status(400).json({ error: "siteId must be one of this venue's sites." });
    }

    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return res.status(400).json({ error: "startsAt and endsAt must be valid date-times." });
    }
    if (endsAt <= startsAt) {
      return res.status(400).json({ error: "endsAt must be after startsAt." });
    }

    const headcount = Number(body.headcount);
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 50) {
      return res.status(400).json({ error: "headcount must be a whole number from 1 to 50." });
    }

    const request = await requestsStore.create({
      tenantId: DASHBOARD_TENANT_ID,
      siteId: site.siteId,
      siteName: site.name,
      role: body.role ? String(body.role).trim() : null,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      headcount,
      requestedBy: body.requestedBy ? String(body.requestedBy).replace(/[^\d]/g, "") : null,
      lane: laneFor(startsAt),
    });

    // Blast immediately rather than waiting up to a tick interval — at 5:40am
    // thirty seconds is thirty seconds.
    dispatcher.runOnce().catch((err) => console.error("[dispatch] kick failed:", err));

    res.json({ ok: true, request });
  } catch (err) {
    console.error("[requests] failed to create:", err);
    res.status(500).json({ error: "Failed to raise that request." });
  }
});

/**
 * POST /api/requests/:id/cancel — pull a request. Every still-pending offer is
 * expired so nobody accepts a shift that no longer exists.
 */
app.post("/api/requests/:id/cancel", requireDashboardKey, async (req, res) => {
  try {
    const request = await requestsStore.findById(req.params.id);
    if (!request || request.tenantId !== DASHBOARD_TENANT_ID) {
      return res.status(404).json({ error: "No request with that id." });
    }
    await offersStore.expirePending(request.requestId);
    const cancelled = await requestsStore.close(request.requestId, "cancelled");
    res.json({ ok: true, request: cancelled });
  } catch (err) {
    console.error("[requests] failed to cancel:", err);
    res.status(500).json({ error: "Failed to cancel that request." });
  }
});

/**
 * POST /api/dispatch/tick — run one pass of the blast engine now. The loop runs
 * on its own; this exists so an operator can force it after fixing whatever was
 * blocking a request, without waiting for the next tick.
 */
app.post("/api/dispatch/tick", requireDashboardKey, async (_req, res) => {
  try {
    const result = await dispatcher.runOnce();
    res.json({ ok: true, ...(result || { skipped: "a pass was already running" }) });
  } catch (err) {
    console.error("[dispatch] manual tick failed:", err);
    res.status(500).json({ error: "Dispatch pass failed." });
  }
});

/**
 * GET /api/roster?week=YYYY-MM-DD — the roster grid data for one week:
 * the week's assignments plus each staff member's availability, so the
 * dashboard can tint cells and warn on conflicts. Sites come along too —
 * an assignment names the building, so the grid needs the picker options.
 */
app.get("/api/roster", requireDashboardKey, async (req, res) => {
  try {
    const weekStart = String(req.query.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const [roster, staff, sites] = await Promise.all([
      rosterStore.getWeek(DASHBOARD_TENANT_ID, weekStart),
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
      // Inactive included so this payload is interchangeable with
      // /api/dashboard's — the client filters for the pickers itself.
      siteStore.listByTenant(DASHBOARD_TENANT_ID, { includeInactive: true }),
    ]);
    res.json({ roster, staff, sites });
  } catch (err) {
    console.error("[roster] failed to load week:", err);
    res.status(500).json({ error: "Failed to load roster." });
  }
});

/**
 * POST /api/roster — auto-save the whole week's assignments on every cell
 * click. Body: { week: "YYYY-MM-DD",
 *                assignments: {date: {phone: {slot, siteId} | "AM"}} }.
 *
 * Cells are normalized on the way in, and a siteId the tenant doesn't own is
 * stripped rather than stored: a dangling site reference on an assignment
 * becomes a geofence that can never match, which flags a staff member for
 * being exactly where they were told to be.
 */
app.post("/api/roster", requireDashboardKey, async (req, res) => {
  try {
    const { week, assignments } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week || ""))) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD." });
    }
    const numOrNull = (v) => (v === null ? null : v !== undefined ? Number(v) : undefined);
    const extras = {
      revenueForecast: numOrNull(req.body.revenueForecast),
      openingStock: numOrNull(req.body.openingStock),
      closingStock: numOrNull(req.body.closingStock),
    };
    const sites = await siteStore.listByTenant(DASHBOARD_TENANT_ID, { includeInactive: true });
    const knownSiteIds = new Set(sites.map((s) => s.siteId));
    const clean = normalizeAssignments(assignments, (siteId) => knownSiteIds.has(siteId));
    const saved = await rosterStore.saveWeek(DASHBOARD_TENANT_ID, week, clean, extras);
    res.json({ ok: true, roster: saved });
  } catch (err) {
    console.error("[roster] failed to save week:", err);
    res.status(500).json({ error: "Failed to save roster." });
  }
});

/**
 * POST /api/roster/publish — marks the week published and WhatsApps every
 * assigned staff member their shifts. Reports per-person delivery results:
 * business-initiated messages can fail outside WhatsApp's 24h customer
 * service window (the permanent fix is Meta template approval — alerts
 * build step), so the manager needs to see who actually got it.
 */
app.post("/api/roster/publish", requireDashboardKey, async (req, res) => {
  try {
    const { week } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week || ""))) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD." });
    }
    const roster = await rosterStore.getWeek(DASHBOARD_TENANT_ID, week);
    const wasPublished = roster.published;
    const staff = await staffStore.listByTenant(DASHBOARD_TENANT_ID);

    // Multi-tenant correctness: if this venue has its own WhatsApp number,
    // roster notifications must go out from it — not the default env-var
    // number. Falls back to {} (env vars) for the single-venue setup.
    const venue = await tenantStore.findById(DASHBOARD_TENANT_ID);
    const sendOpts = venue && venue.phoneNumberId
      ? { phoneNumberId: venue.phoneNumberId, token: venue.whatsappToken || undefined }
      : {};

    // Site names for the message body — a casual working three hotels this
    // week needs to be told which one, not just "Tue — AM".
    const sites = await siteStore.listByTenant(DASHBOARD_TENANT_ID, { includeInactive: true });
    const siteNames = new Map(sites.map((s) => [s.siteId, s.name]));

    // Collect each person's assigned days across the week.
    const perStaff = {};
    for (const [date, dayAssignments] of Object.entries(roster.assignments || {})) {
      for (const [phone, raw] of Object.entries(dayAssignments)) {
        const assignment = normalizeAssignment(raw);
        if (!assignment) continue;
        (perStaff[phone] = perStaff[phone] || []).push({ date, ...assignment });
      }
    }

    // At 500-staff scale, sequential sends would blow past request timeouts —
    // send in parallel batches instead. Batch size 10 keeps within WhatsApp
    // API rate comfort while finishing a 400-person publish in seconds.
    const jobs = Object.entries(perStaff).map(([phone, entries]) => {
      const person = staff.find((s) => s.phone === phone);
      entries.sort((a, b) => (a.date < b.date ? -1 : 1));
      const lines = entries.map((e) => {
        const label = new Date(e.date + "T00:00:00").toLocaleDateString("en-AU", {
          weekday: "short", day: "numeric", month: "short",
        });
        const site = e.siteId ? siteNames.get(e.siteId) : null;
        return `${label} — ${SLOT_LABELS[e.slot] || e.slot}${site ? ` @ ${site}` : ""}`;
      });
      const heading = wasPublished ? "Your roster has been updated" : "Your roster is out";
      const body = `${heading}, ${person ? person.name : ""}:\n${lines.join("\n")}`;
      return { phone, name: person ? person.name : phone, body };
    });

    const results = [];
    const BATCH = 10;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      const settled = await Promise.all(
        batch.map(async (job) => {
          try {
            const apiRes = await sendText(job.phone, job.body, sendOpts);
            return { phone: job.phone, name: job.name, sent: !(apiRes && apiRes.error) };
          } catch (err) {
            return { phone: job.phone, name: job.name, sent: false };
          }
        })
      );
      results.push(...settled);
    }

    await rosterStore.markPublished(DASHBOARD_TENANT_ID, week);
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[roster] failed to publish:", err);
    res.status(500).json({ error: "Failed to publish roster." });
  }
});


/**
 * Penalty-rate settings — a configurable cost-estimation engine, NOT award
 * interpretation. The AU/US presets in the dashboard pre-fill these fields
 * as editable starting points; the venue owner confirms them against their
 * own award / state law. Numbers here feed roster costing only, never pay.
 */
app.get("/api/settings/penalties", requireDashboardKey, async (_req, res) => {
  try {
    const venue = await tenantStore.findById(DASHBOARD_TENANT_ID);
    res.json({ penaltyRules: (venue && venue.penaltyRules) || null });
  } catch (err) {
    console.error("[settings] failed to load penalties:", err);
    res.status(500).json({ error: "Failed to load penalty settings." });
  }
});

app.post("/api/settings/penalties", requireDashboardKey, async (req, res) => {
  try {
    const r = req.body || {};
    const num = (v, min, max) => {
      const n = Number(v);
      return isFinite(n) && n >= min && n <= max ? n : null;
    };
    const penaltyRules = {
      saturday: num(r.saturday, 0.5, 5) ?? 1,
      sunday: num(r.sunday, 0.5, 5) ?? 1,
      publicHoliday: num(r.publicHoliday, 0.5, 5) ?? 1,
      overtimeWeeklyHours: num(r.overtimeWeeklyHours, 1, 168) ?? 40,
      overtimeMultiplier: num(r.overtimeMultiplier, 1, 5) ?? 1.5,
      publicHolidays: Array.isArray(r.publicHolidays)
        ? r.publicHolidays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).slice(0, 60)
        : [],
      preset: ["AU", "US", "custom"].includes(r.preset) ? r.preset : "custom",
      slotHours: {
        AM: num(r.slotHours && r.slotHours.AM, 0.5, 24) ?? 5,
        PM: num(r.slotHours && r.slotHours.PM, 0.5, 24) ?? 6,
        ALL: num(r.slotHours && r.slotHours.ALL, 0.5, 24) ?? 10,
      },
    };
    await tenantStore.updateSettings(DASHBOARD_TENANT_ID, { penaltyRules });
    res.json({ ok: true, penaltyRules });
  } catch (err) {
    console.error("[settings] failed to save penalties:", err);
    res.status(500).json({ error: "Failed to save penalty settings." });
  }
});


/**
 * GET /api/purchases?week=YYYY-MM-DD — the week's purchases (Mon..Sun),
 * newest first, plus the week total. Date filtering in JS: single-field
 * Firestore query keeps us index-free (same discipline as elsewhere).
 */
app.get("/api/purchases", requireDashboardKey, async (req, res) => {
  try {
    const weekStart = String(req.query.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const end = new Date(weekStart + "T12:00:00");
    end.setDate(end.getDate() + 7);
    const weekEnd = end.toISOString().slice(0, 10);
    const all = await purchasesStore.listByTenant(DASHBOARD_TENANT_ID);
    const purchases = all
      .filter((p) => p.date >= weekStart && p.date < weekEnd)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const total = purchases.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    res.json({ purchases, total });
  } catch (err) {
    console.error("[purchases] failed to list:", err);
    res.status(500).json({ error: "Failed to load purchases." });
  }
});

/**
 * POST /api/purchases — log a purchase from the dashboard.
 * Body: { date: "YYYY-MM-DD", amount, supplier }.
 */
app.post("/api/purchases", requireDashboardKey, async (req, res) => {
  try {
    const { date, amount, supplier } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD." });
    }
    const amt = Number(amount);
    if (!isFinite(amt) || amt <= 0 || amt > 1000000) {
      return res.status(400).json({ error: "amount must be a positive number." });
    }
    const record = await purchasesStore.add({
      tenantId: DASHBOARD_TENANT_ID,
      date,
      amount: amt,
      supplier: supplier ? String(supplier).trim().slice(0, 80) : null,
      source: "manual",
      loggedBy: null,
    });
    res.json({ ok: true, purchase: record });
  } catch (err) {
    console.error("[purchases] failed to add:", err);
    res.status(500).json({ error: "Failed to log that purchase." });
  }
});

/** DELETE /api/purchases/:id — remove a mis-entered purchase. */
app.delete("/api/purchases/:id", requireDashboardKey, async (req, res) => {
  try {
    await purchasesStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[purchases] failed to delete:", err);
    res.status(500).json({ error: "Failed to remove that purchase." });
  }
});


/**
 * POST /api/shifts/:id/close — manager force clock-out for forgotten
 * "out" texts (a nightly reality in kitchens). Closes the shift now with
 * no location, marked forcedByManager so reports can tell it apart.
 */
app.post("/api/shifts/:id/close", requireDashboardKey, async (req, res) => {
  try {
    const updated = await shiftsStore.closeShift(req.params.id, {
      time: new Date().toISOString(),
      forcedByManager: true,
    });
    res.json({ ok: true, shift: updated });
  } catch (err) {
    console.error("[dashboard] failed to force-close shift:", err);
    res.status(500).json({ error: "Failed to close that shift." });
  }
});


/**
 * POST /api/shifts/:id/amend — timesheet correction with audit trail.
 * Body: { clockInTime, clockOutTime, breakMinutes } (ISO strings / number).
 * Originals stay untouched on the shift document; reports flag amended
 * rows and include the original values.
 */
app.post("/api/shifts/:id/amend", requireDashboardKey, async (req, res) => {
  try {
    const { clockInTime, clockOutTime, breakMinutes } = req.body || {};
    const validIso = (v) => !v || !isNaN(new Date(v).getTime());
    if (!validIso(clockInTime) || !validIso(clockOutTime)) {
      return res.status(400).json({ error: "clockInTime/clockOutTime must be valid times." });
    }
    const bm = breakMinutes != null ? Number(breakMinutes) : null;
    if (bm != null && (!isFinite(bm) || bm < 0 || bm > 1440)) {
      return res.status(400).json({ error: "breakMinutes must be 0–1440." });
    }
    const updated = await shiftsStore.amendShift(req.params.id, {
      clockInTime, clockOutTime, breakMinutes: bm,
    });
    res.json({ ok: true, shift: updated });
  } catch (err) {
    console.error("[dashboard] failed to amend shift:", err);
    res.status(500).json({ error: "Failed to amend that shift." });
  }
});

/** Effective (amended-aware) times for a shift. Shared by both reports. */
function effectiveShift(s) {
  const inIso = (s.amended && s.amended.clockInTime) || s.clockIn.time;
  const outIso = (s.amended && s.amended.clockOutTime) || (s.clockOut && s.clockOut.time);
  const breakMs = s.amended && s.amended.breakMinutes != null
    ? s.amended.breakMinutes * 60000
    : (s.breaks || []).reduce((sum, b) => (b.end ? sum + (new Date(b.end) - new Date(b.start)) : sum), 0);
  return { inIso, outIso, breakMs };
}

function reportDayMultiplier(dateIso, rules) {
  if (!rules) return 1;
  if ((rules.publicHolidays || []).includes(dateIso)) return rules.publicHoliday || 1;
  const dow = new Date(dateIso + "T12:00:00").getDay();
  if (dow === 6) return rules.saturday || 1;
  if (dow === 0) return rules.sunday || 1;
  return 1;
}

function reportMondayOf(dateIso) {
  const d = new Date(dateIso + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/reports/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
 * The finance payment run: every closed shift in range with effective times,
 * paid hours, rate, day multiplier and pay; weekly overtime lines per staff;
 * per-staff and grand totals. Amended rows carry their originals — the
 * audit trail finance requires.
 */
app.get("/api/reports/payroll", requireDashboardKey, async (req, res) => {
  try {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD." });
    }
    const [staff, venue, shiftsRaw] = await Promise.all([
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
      tenantStore.findById(DASHBOARD_TENANT_ID),
      shiftsStore.listRecentByTenant(DASHBOARD_TENANT_ID, from),
    ]);
    const rules = venue && venue.penaltyRules;
    const endExclusive = new Date(to + "T12:00:00");
    endExclusive.setDate(endExclusive.getDate() + 1);
    const endIso = endExclusive.toISOString().slice(0, 10);

    const rows = [];
    const weekHours = {}; // `${phone}|${weekStart}` -> hours
    for (const s of shiftsRaw) {
      if (!s.clockOut || s.clockOut.denied) continue;
      const eff = effectiveShift(s);
      if (!eff.outIso) continue;
      const dateIso = eff.inIso.slice(0, 10);
      if (dateIso < from || dateIso >= endIso) continue;
      const person = staff.find((x) => x.phone === s.staffPhone);
      const rate = person && person.wageRate != null ? Number(person.wageRate) : null;
      const hours = Math.max(0, (new Date(eff.outIso) - new Date(eff.inIso) - eff.breakMs) / 3600000);
      const mult = reportDayMultiplier(dateIso, rules);
      const pay = rate != null ? hours * rate * mult : null;
      const key = `${s.staffPhone}|${reportMondayOf(dateIso)}`;
      weekHours[key] = (weekHours[key] || 0) + hours;
      rows.push({
        staffPhone: s.staffPhone,
        name: person ? person.name : s.staffPhone,
        date: dateIso,
        clockIn: eff.inIso,
        clockOut: eff.outIso,
        breakMinutes: Math.round(eff.breakMs / 60000),
        hours: Number(hours.toFixed(2)),
        rate,
        multiplier: mult,
        pay: pay != null ? Number(pay.toFixed(2)) : null,
        amended: Boolean(s.amended),
        originalClockIn: s.amended ? s.clockIn.time : null,
        originalClockOut: s.amended && s.clockOut ? s.clockOut.time : null,
        forcedByManager: Boolean(s.clockOut && s.clockOut.forcedByManager),
      });
    }

    // Weekly overtime premium lines (base-rate premium, matching the dashboard).
    const otRows = [];
    if (rules && rules.overtimeWeeklyHours) {
      for (const [key, hours] of Object.entries(weekHours)) {
        const over = hours - rules.overtimeWeeklyHours;
        if (over <= 0) continue;
        const [phone, weekStart] = key.split("|");
        const person = staff.find((x) => x.phone === phone);
        const rate = person && person.wageRate != null ? Number(person.wageRate) : null;
        if (rate == null) continue;
        otRows.push({
          staffPhone: phone,
          name: person ? person.name : phone,
          weekStart,
          overtimeHours: Number(over.toFixed(2)),
          premium: Number((over * rate * ((rules.overtimeMultiplier || 1) - 1)).toFixed(2)),
        });
      }
    }

    const perStaff = {};
    for (const r of rows) {
      const t = (perStaff[r.staffPhone] = perStaff[r.staffPhone] || { name: r.name, hours: 0, pay: 0, missingRate: false });
      t.hours += r.hours;
      if (r.pay != null) t.pay += r.pay; else t.missingRate = true;
    }
    for (const o of otRows) {
      const t = perStaff[o.staffPhone];
      if (t) t.pay += o.premium;
    }
    const grand = Object.values(perStaff).reduce(
      (g, t) => ({ hours: g.hours + t.hours, pay: g.pay + t.pay }), { hours: 0, pay: 0 }
    );
    res.json({ from, to, rows, otRows, perStaff, grand, rulesApplied: Boolean(rules) });
  } catch (err) {
    console.error("[reports] payroll failed:", err);
    res.status(500).json({ error: "Failed to build the payroll report." });
  }
});

/**
 * GET /api/reports/pnl?week=YYYY-MM-DD — the weekly P&L summary: revenue,
 * actual labour (amended-aware), food purchases / COGS, and the three
 * percentages management steers by.
 */
app.get("/api/reports/pnl", requireDashboardKey, async (req, res) => {
  try {
    const week = String(req.query.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const endD = new Date(week + "T12:00:00");
    endD.setDate(endD.getDate() + 7);
    const weekEnd = endD.toISOString().slice(0, 10);

    const [staff, venue, roster, shiftsRaw, purchasesAll] = await Promise.all([
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
      tenantStore.findById(DASHBOARD_TENANT_ID),
      rosterStore.getWeek(DASHBOARD_TENANT_ID, week),
      shiftsStore.listRecentByTenant(DASHBOARD_TENANT_ID, week),
      purchasesStore.listByTenant(DASHBOARD_TENANT_ID),
    ]);
    const rules = venue && venue.penaltyRules;

    let labour = 0;
    const wh = {};
    for (const s of shiftsRaw) {
      if (!s.clockOut || s.clockOut.denied) continue;
      const eff = effectiveShift(s);
      if (!eff.outIso) continue;
      const dateIso = eff.inIso.slice(0, 10);
      if (dateIso < week || dateIso >= weekEnd) continue;
      const person = staff.find((x) => x.phone === s.staffPhone);
      if (!person || person.wageRate == null) continue;
      const hours = Math.max(0, (new Date(eff.outIso) - new Date(eff.inIso) - eff.breakMs) / 3600000);
      labour += hours * Number(person.wageRate) * reportDayMultiplier(dateIso, rules);
      wh[s.staffPhone] = (wh[s.staffPhone] || 0) + hours;
    }
    if (rules && rules.overtimeWeeklyHours) {
      for (const [phone, hours] of Object.entries(wh)) {
        const over = hours - rules.overtimeWeeklyHours;
        if (over <= 0) continue;
        const person = staff.find((x) => x.phone === phone);
        if (person && person.wageRate != null) {
          labour += over * Number(person.wageRate) * ((rules.overtimeMultiplier || 1) - 1);
        }
      }
    }

    const purchases = purchasesAll
      .filter((p) => p.date >= week && p.date < weekEnd)
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const hasStocktake = roster.openingStock != null && roster.closingStock != null;
    const cogs = hasStocktake ? Number(roster.openingStock) + purchases - Number(roster.closingStock) : purchases;
    const revenue = roster.revenueForecast != null ? Number(roster.revenueForecast) : null;

    const pct = (x) => (revenue > 0 ? Number(((x / revenue) * 100).toFixed(2)) : null);
    res.json({
      week, weekEnd,
      revenue,
      labourCost: Number(labour.toFixed(2)),
      purchases: Number(purchases.toFixed(2)),
      openingStock: roster.openingStock,
      closingStock: roster.closingStock,
      cogs: Number(cogs.toFixed(2)),
      cogsBasis: hasStocktake ? "stocktake" : "purchases",
      labourPct: pct(labour),
      foodPct: pct(cogs),
      primePct: revenue > 0 ? Number((((labour + cogs) / revenue) * 100).toFixed(2)) : null,
    });
  } catch (err) {
    console.error("[reports] pnl failed:", err);
    res.status(500).json({ error: "Failed to build the P&L report." });
  }
});

// Simple liveness probe for the host / uptime checks.
app.get("/health", (_req, res) => res.json({ ok: true, service: "hospitality-os", step: 2, backend }));

const PORT = process.env.PORT || 3000;

// Fail fast on missing configuration rather than failing weirdly later.
const required = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "META_APP_SECRET"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[startup] WARNING — missing env vars: ${missing.join(", ")}`);
  console.warn("[startup] The server will start, but webhook verification and replies will fail until these are set.");
}
if (!process.env.MANAGER_DASHBOARD_PASSWORD) {
  console.warn("[startup] MANAGER_DASHBOARD_PASSWORD is not set — /dashboard will load but its data API will reject all requests until it's set.");
}

app.listen(PORT, () => {
  console.log(`HospitalityOS webhook skeleton listening on :${PORT}`);
  console.log(`Webhook URL path: /webhook/whatsapp`);
});
