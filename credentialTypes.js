"use strict";

/**
 * Credential types — single source of truth shared by the WhatsApp intake
 * (walletHandler.js), the dashboard API (core-os-routes.js) and the expiry
 * nudge loop (walletNudges.js).
 *
 * `blocking: true` → the roster guard refuses (with logged override) to
 * roster a worker whose credential of this type has expired.
 * `aliases` → what workers actually type on WhatsApp.
 */

const CREDENTIAL_TYPES = {
  visa:            { label: "Visa / right to work",     blocking: true,  aliases: ["visa", "rightowork", "right to work"] },
  rsa:             { label: "RSA / RCG",                blocking: true,  aliases: ["rsa", "rcg"] },
  white_card:      { label: "White Card",               blocking: true,  aliases: ["white", "whitecard", "white card"] },
  ndis_screening:  { label: "NDIS worker screening",    blocking: true,  aliases: ["ndis"] },
  police_check:    { label: "Police check",             blocking: false, aliases: ["police", "police check"] },
  fss:             { label: "Food Safety Supervisor",   blocking: false, aliases: ["fss", "food safety", "foodsafety"] },
  first_aid:       { label: "First aid",                blocking: false, aliases: ["firstaid", "first aid", "cpr"] },
  drivers_licence: { label: "Driver licence",           blocking: false, aliases: ["licence", "license", "drivers", "driver licence"] },
};

/** Resolve a worker-typed word ("rcg", "white card") to a type key, or null. */
function resolveType(word) {
  const w = String(word || "").trim().toLowerCase();
  for (const [key, t] of Object.entries(CREDENTIAL_TYPES)) {
    if (key === w || t.aliases.includes(w)) return key;
  }
  return null;
}

module.exports = { CREDENTIAL_TYPES, resolveType };
