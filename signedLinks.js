"use strict";

const crypto = require("crypto");

/**
 * Signed one-tap links — the mechanism behind rung 3 of the capture ladder in
 * docs/agencymodelshape.md: "a signed one-tap link — no login, no password".
 *
 * A casual is not going to create an account to tell you they can work Tuesday.
 * The link itself is the credential: it names who it is for and what week, and
 * it carries an HMAC so it cannot be edited or guessed.
 *
 * ## What this is and isn't
 *
 * It is a capability URL. Anyone holding the link can submit that one person's
 * availability for that one week, until it expires. That is an acceptable trade
 * for a low-value, self-reported, weekly-expiring fact, and it is the only
 * design that gets a 300-person pool to actually answer.
 *
 * It is NOT a session. The token grants exactly one scope, for one subject, and
 * expires. It must never be used to authorise anything that touches money,
 * personal data, or another person's record.
 *
 * Signing uses `LINK_SIGNING_SECRET`. If that isn't set the module refuses to
 * sign rather than falling back to something guessable — an unsigned link would
 * let anyone submit anyone's availability by editing a phone number in a URL.
 */

/** A week's answer is useless after the week, so the link needn't outlive it. */
const DEFAULT_TTL_MS = 10 * 24 * 60 * 60 * 1000;

function secret() {
  const value = process.env.LINK_SIGNING_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "LINK_SIGNING_SECRET is not set (or is under 16 characters). One-tap links " +
        "cannot be signed safely without it — set it in Railway's Variables tab."
    );
  }
  return value;
}

/** Whether links can be issued at all, so callers can degrade instead of throwing. */
function isConfigured() {
  const value = process.env.LINK_SIGNING_SECRET;
  return Boolean(value && value.length >= 16);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  return Buffer.from(String(text).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Mints a token for one subject, one scope, one week.
 * @param {{scope: string, tenantId: string, phone: string, weekStart: string, ttlMs?: number}} claims
 */
function sign(claims) {
  const payload = {
    s: claims.scope,
    t: claims.tenantId,
    p: claims.phone,
    w: claims.weekStart,
    x: Date.now() + (claims.ttlMs || DEFAULT_TTL_MS),
  };
  const body = base64url(JSON.stringify(payload));
  const mac = base64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verifies and decodes a token.
 *
 * @returns {{ok: true, claims: object} | {ok: false, reason: string}}
 *   Never throws on bad input — a mangled URL from a WhatsApp line-wrap is a
 *   normal event, not an exception.
 */
function verify(token) {
  if (!isConfigured()) return { ok: false, reason: "NOT_CONFIGURED" };
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [body, mac] = parts;

  let expected;
  try {
    expected = base64url(crypto.createHmac("sha256", secret()).update(body).digest());
  } catch {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  // Constant-time compare, so a wrong signature can't be narrowed down by
  // timing one character at a time.
  const given = fromBase64url(mac);
  const want = fromBase64url(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (!payload || typeof payload !== "object") return { ok: false, reason: "MALFORMED" };
  if (!payload.x || Date.now() > payload.x) return { ok: false, reason: "EXPIRED" };

  return {
    ok: true,
    claims: {
      scope: payload.s,
      tenantId: payload.t,
      phone: payload.p,
      weekStart: payload.w,
      expiresAt: new Date(payload.x).toISOString(),
    },
  };
}

/**
 * The full URL to put in a WhatsApp message. PUBLIC_BASE_URL is the deployment's
 * own domain; without it the link would be relative and useless in a chat.
 */
function availabilityLink(tenantId, phone, weekStart) {
  const token = sign({ scope: "availability", tenantId, phone, weekStart });
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/a/${token}`;
}

module.exports = { sign, verify, availabilityLink, isConfigured, DEFAULT_TTL_MS };
