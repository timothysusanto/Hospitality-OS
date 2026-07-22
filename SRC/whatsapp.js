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
 * @returns {Promise<object>} WhatsApp API response JSON
 */
async function sendText(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

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
 */
async function sendLocationRequest(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

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

module.exports = { sendText, sendLocationRequest };
