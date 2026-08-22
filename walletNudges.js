"use strict";

/**
 * walletNudges.js — Credential expiry reminders (Core OS Phase 2).
 *
 * Every 6 hours: find credentials expiring within 60 days (or already
 * expired), and message the worker on WhatsApp at the 60 / 30 / 7-day
 * marks and once after expiry. Each tier is sent at most once per
 * credential — markers live on the credential document (`nudgesSent`),
 * so this survives redeploys and never spams.
 *
 * Follows the dispatcher pattern: started once on boot from server.js,
 * disabled with WALLET_NUDGES_DISABLED=1 (e.g. a second debug instance
 * pointed at the same Firestore).
 */

const TIERS = [60, 30, 7, 0]; // 0 = expired notice
const INTERVAL_MS = 6 * 60 * 60 * 1000;

function startWalletNudges({ db, tenantId, send }) {
  if (!db) {
    console.warn("[nudges] Firestore not configured — expiry nudges off.");
    return null;
  }
  if (process.env.WALLET_NUDGES_DISABLED === "1") {
    console.log("[nudges] disabled by WALLET_NUDGES_DISABLED=1");
    return null;
  }

  async function tick() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const horizon = addDays(today, 60);
      const snap = await db.collection("tenants").doc(tenantId).collection("credentials")
        .where("expiryDate", "<=", horizon).get();

      for (const doc of snap.docs) {
        const c = doc.data();
        if (!c.expiryDate || !c.workerPhone) continue;
        const daysLeft = daysBetween(today, c.expiryDate);
        const sent = c.nudgesSent || {};

        // The tightest tier this credential has crossed that hasn't been sent.
        const due = TIERS.find((t) => daysLeft <= t && !sent[t]);
        if (due === undefined) continue;

        const label = c.label || c.type;
        const msg = daysLeft < 0
          ? `🔴 ${firstName(c.workerName)}, your ${label} EXPIRED on ${fmtDate(c.expiryDate)}. ` +
            `You may not be able to be rostered until it's renewed. When you have the new one, just send me a photo of it.`
          : `⏰ Heads up ${firstName(c.workerName)} — your ${label} expires ${fmtDate(c.expiryDate)} ` +
            `(${daysLeft} day${daysLeft === 1 ? "" : "s"}). Renew it in time and send me a photo of the new one so you stay rosterable.`;

        try {
          await send(c.workerPhone, msg);
          // Mark this tier AND every looser tier as sent, so a credential first
          // seen at 5 days out doesn't later fire the 30- and 60-day nudges too.
          const update = { ...sent };
          for (const t of TIERS) if (t >= due) update[t] = new Date().toISOString();
          await doc.ref.update({ nudgesSent: update });
          console.log(`[nudges] sent ${due}d nudge: ${label} → ${c.workerPhone}`);
        } catch (err) {
          console.error("[nudges] send failed:", err.message);
        }
      }
    } catch (err) {
      console.error("[nudges] tick failed:", err.message);
    }
  }

  tick(); // once on boot
  const handle = setInterval(tick, INTERVAL_MS);
  console.log("[nudges] credential expiry nudges running (every 6h)");
  return handle;
}

function addDays(ds, n) {
  const d = new Date(ds + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + "T12:00:00") - new Date(fromStr + "T12:00:00")) / 86400000);
}
function fmtDate(ds) {
  return new Date(ds + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
function firstName(n) { return (n || "there").split(" ")[0]; }

module.exports = { startWalletNudges };
