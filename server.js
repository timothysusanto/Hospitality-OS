"use strict";

/**
 * HospitalityOS — webhook skeleton (build step 1 of backend-build-scope.md).
 *
 * Proves the pipe: WhatsApp message -> Meta Cloud API -> this webhook ->
 * sender lookup -> reply through the Send API. Nothing else.
 */

const express = require("express");
const { verifyMetaSignature } = require("./verifySignature");
const { handleIncoming } = require("./router");
const { buildStores } = require("./stores");
const { InMemoryPendingActions } = require("./pendingActions");

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

app.listen(PORT, () => {
  console.log(`HospitalityOS webhook skeleton listening on :${PORT}`);
  console.log(`Webhook URL path: /webhook/whatsapp`);
});
