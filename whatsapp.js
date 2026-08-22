"use strict";

/**
 * Minimal WhatsApp Cloud API client — send-side only.
 * Uses Node 18+ native fetch; no extra dependencies.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

const GRAPH_VERSION = "v21.0";

/**
 * Send a plain text message to a WhatsApp user.
 * Free within the 24h customer-service window opened by the user's message.
 *
 * @param {string} to    Recipient phone number in international format, no "+" (e.g. "61412345678")
 * @param {string} body  Message text
 * @param {{phoneNumberId?: string, token?: string}} [options]  Per-tenant overrides —
 *   used for multi-venue setups where each tenant has their own WhatsApp
 *   number/token. Falls back to the single-venue env vars if omitted, so
 *   existing single-tenant deployments keep working unchanged.
 * @returns {Promise<object>} WhatsApp API response JSON
 */
async function sendText(to, body, options = {}) {
  const phoneNumberId = options.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = options.token || process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error(
      "Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN environment variable."
    );
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Log the full error but don't crash the webhook — Meta retries on 5xx,
    // and a failed reply shouldn't take the whole pipe down.
    console.error("WhatsApp send failed:", res.status, JSON.stringify(json));
  }

  return json;
}

/**
 * Send an interactive "share your location" prompt — renders as a one-tap
 * button in WhatsApp that opens the native location picker. Nicer than
 * asking the user to find WhatsApp's location-share feature themselves.
 *
 * @param {string} to    Recipient phone number, international format, no "+"
 * @param {string} body  The message shown above the button
 * @param {{phoneNumberId?: string, token?: string}} [options]  Per-tenant overrides, see sendText.
 */
async function sendLocationRequest(to, body, options = {}) {
  const phoneNumberId = options.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = options.token || process.env.WHATSAPP_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error(
      "Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN environment variable."
    );
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: { text: body },
        action: { name: "send_location" },
      },
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("WhatsApp location request failed:", res.status, JSON.stringify(json));
  }
  return json;
}

/**
 * Download a media attachment (photo) a user sent us, by its media ID.
 * Two-step per Meta's docs: resolve the media ID to a short-lived CDN URL,
 * then fetch the binary with the same bearer token.
 *
 * @param {string} mediaId  message.image.id from the webhook payload
 * @param {{token?: string}} [options]  Per-tenant token override
 * @returns {Promise<{buffer: Buffer, mimeType: string}|null>} null on any failure
 */
async function fetchMediaBinary(mediaId, options = {}) {
  const token = options.token || process.env.WHATSAPP_TOKEN;
  if (!token) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json();
    if (!metaRes.ok || !meta.url) {
      console.error("[media] resolve failed:", metaRes.status, JSON.stringify(meta));
      return null;
    }
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!binRes.ok) {
      console.error("[media] download failed:", binRes.status);
      return null;
    }
    return { buffer: Buffer.from(await binRes.arrayBuffer()), mimeType: meta.mime_type || "image/jpeg" };
  } catch (err) {
    console.error("[media] error:", err.message);
    return null;
  }
}

module.exports = { sendText, sendLocationRequest, fetchMediaBinary };
