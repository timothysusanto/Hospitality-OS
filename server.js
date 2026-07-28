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

// The single venue this build supports so far (see decisions log — multi-
// tenant support is a later step). The dashboard is scoped to this tenant.
const DASHBOARD_TENANT_ID = "demo-venue";

const app = express();
const { staffStore, tenantStore, shiftsStore, rosterStore, purchasesStore, backend } = buildStores();
const pendingActions = new InMemoryPendingActions();
const deps = { staffStore, tenantStore, shiftsStore, rosterStore, purchasesStore, pendingActions };

console.log(`[startup] data backend: ${backend}`);

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
    const [staff, openShifts, recentShifts, venue] = await Promise.all([
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
      shiftsStore.listOpenByTenant(DASHBOARD_TENANT_ID),
      shiftsStore.listRecentByTenant(DASHBOARD_TENANT_ID, since),
      tenantStore.findById(DASHBOARD_TENANT_ID),
    ]);
    const seen = new Set();
    const shifts = [...openShifts, ...recentShifts].filter((s) => {
      if (seen.has(s.shiftId)) return false;
      seen.add(s.shiftId);
      return true;
    });
    res.json({ staff, shifts, venue });
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
 * GET /api/roster?week=YYYY-MM-DD — the roster grid data for one week:
 * the week's assignments plus each staff member's availability, so the
 * dashboard can tint cells and warn on conflicts.
 */
app.get("/api/roster", requireDashboardKey, async (req, res) => {
  try {
    const weekStart = String(req.query.week || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: "week must be YYYY-MM-DD (a Monday)." });
    }
    const [roster, staff] = await Promise.all([
      rosterStore.getWeek(DASHBOARD_TENANT_ID, weekStart),
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
    ]);
    res.json({ roster, staff });
  } catch (err) {
    console.error("[roster] failed to load week:", err);
    res.status(500).json({ error: "Failed to load roster." });
  }
});

/**
 * POST /api/roster — auto-save the whole week's assignments on every cell
 * click. Body: { week: "YYYY-MM-DD", assignments: {date: {phone: slot}} }.
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
    const saved = await rosterStore.saveWeek(DASHBOARD_TENANT_ID, week, assignments || {}, extras);
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

    // Collect each person's assigned days across the week.
    const perStaff = {};
    for (const [date, dayAssignments] of Object.entries(roster.assignments || {})) {
      for (const [phone, slot] of Object.entries(dayAssignments)) {
        if (!slot) continue;
        (perStaff[phone] = perStaff[phone] || []).push({ date, slot });
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
        return `${label} — ${SLOT_LABELS[e.slot] || e.slot}`;
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
