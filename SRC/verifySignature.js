"use strict";

const crypto = require("crypto");

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 *
 * Meta signs every webhook POST with: sha256=HMAC_SHA256(app_secret, raw_body)
 * We must compare against the RAW body bytes — not the parsed JSON — which is
 * why server.js captures req.rawBody in the express.json() verify hook.
 *
 * Uses crypto.timingSafeEqual to avoid timing attacks.
 *
 * @param {Buffer} rawBody   Raw request body bytes
 * @param {string} signature Value of the X-Hub-Signature-256 header ("sha256=...")
 * @param {string} appSecret Meta App Secret (from developers.facebook.com app settings)
 * @returns {boolean}
 */
function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!signature || !signature.startsWith("sha256=") || !rawBody || !appSecret) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const received = signature.slice("sha256=".length);

  // timingSafeEqual throws if lengths differ — guard first.
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(received, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

module.exports = { verifyMetaSignature };
