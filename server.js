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
const { handleIncoming } = require("./router");
const { buildStores } = require("./stores");
const { InMemoryPendingActions } = require("./pendingActions");

// The single venue this build supports so far (see decisions log — multi-
// tenant support is a later step). The dashboard is scoped to this tenant.
const DASHBOARD_TENANT_ID = "demo-venue";

const app = express();
const { staffStore, tenantStore, shiftsStore, backend } = buildStores();
const pendingActions = new InMemoryPendingActions();
const deps = { staffStore, tenantStore, shiftsStore, pendingActions };

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

      for (const message of value.messages ?? []) {
        handleIncoming(message, deps).catch((err) =>
          console.error("[handler] error:", err)
        );
      }
    }
  }
});

/**
 * Manager dashboard (build step 3) — a page served directly by this server,
 * reading real data through the same admin Firestore connection the bot
 * already uses. No separate client-side Firebase config or security rules
 * needed: the browser never talks to Firestore directly, only to this
 * server's own API, which is gated by a shared key below.
 */
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "dashboard.html"));
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
    const [staff, shifts, venue] = await Promise.all([
      staffStore.listByTenant(DASHBOARD_TENANT_ID),
      shiftsStore.listByTenant(DASHBOARD_TENANT_ID),
      tenantStore.findById(DASHBOARD_TENANT_ID),
    ]);
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
