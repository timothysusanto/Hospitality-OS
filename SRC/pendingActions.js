"use strict";

/**
 * Tracks "I asked this phone number for their location, and why" between
 * the text message ("in"/"out") and the location message that follows it.
 *
 * KNOWN LIMITATION: in-memory only. Fine for a single Railway instance at
 * MVP scale. If you ever run more than one instance, or want pending
 * actions to survive a redeploy, move this to Firestore or Redis — the
 * interface below (get/set/clear) is deliberately small so swapping the
 * backing store later doesn't touch any calling code.
 */

const ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes — don't honour a stale request

class InMemoryPendingActions {
  constructor() {
    /** @type {Map<string, {action: string, requestedAt: number}>} */
    this._pending = new Map();
  }

  /** @param {string} phone @param {string} action e.g. "clock_in" | "clock_out" */
  set(phone, action) {
    this._pending.set(phone, { action, requestedAt: Date.now() });
  }

  /** @param {string} phone @returns {string|null} */
  get(phone) {
    const entry = this._pending.get(phone);
    if (!entry) return null;
    if (Date.now() - entry.requestedAt > ACTION_TTL_MS) {
      this._pending.delete(phone);
      return null;
    }
    return entry.action;
  }

  /** @param {string} phone */
  clear(phone) {
    this._pending.delete(phone);
  }
}

module.exports = { InMemoryPendingActions };
