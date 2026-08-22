"use strict";

/**
 * foodSafetyPrompts.js — Scheduled check reminders (Core OS Phase 3).
 *
 * Every 5 minutes, compare the venue's local time against the configured
 * scheduleTimes (settings/foodSafety). When a slot comes due, prompt every
 * phone in promptPhones: "🌡 Temp checks due — text 'temps' to start."
 *
 * Prompts are OFF until a manager sets promptPhones (deliberate — no
 * surprise messages to the whole crew on deploy day). Configure with:
 *   PUT /api/core/foodsafety/settings  { "promptPhones": ["614…"], "scheduleTimes": ["07:00","15:00"] }
 *
 * Dedupe is in-memory per slot per day — worst case after a redeploy is one
 * repeated prompt, which is harmless.
 */

const CHECK_EVERY_MS = 5 * 60 * 1000;

function startFoodSafetyPrompts({ db, tenantId, send }) {
  if (!db) { console.warn("[fs-prompts] Firestore not configured — prompts off."); return null; }
  if (process.env.FOOD_SAFETY_PROMPTS_DISABLED === "1") {
    console.log("[fs-prompts] disabled by FOOD_SAFETY_PROMPTS_DISABLED=1");
    return null;
  }

  const sentToday = new Set(); // "YYYY-MM-DD HH:MM"

  async function tick() {
    try {
      const doc = await db.collection("tenants").doc(tenantId)
        .collection("settings").doc("foodSafety").get();
      if (!doc.exists) return;
      const s = doc.data();
      const phones = s.promptPhones || [];
      const times = s.scheduleTimes || [];
      if (!phones.length || !times.length) return;

      const nowParts = new Intl.DateTimeFormat("en-AU", {
        timeZone: s.timezone || "Australia/Sydney",
        hour: "2-digit", minute: "2-digit", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
      const get = (t) => nowParts.find((p) => p.type === t).value;
      const localDate = `${get("year")}-${get("month")}-${get("day")}`;
      const nowMins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);

      for (const t of times) {
        const [h, m] = t.split(":").map(Number);
        const slotMins = h * 60 + m;
        const key = `${localDate} ${t}`;
        // Fire within 10 minutes after the slot, once.
        if (nowMins >= slotMins && nowMins < slotMins + 10 && !sentToday.has(key)) {
          sentToday.add(key);
          for (const phone of phones) {
            try {
              await send(phone, `🌡 ${t} checks are due — text "temps" to run the temperature checks, "clean" for the cleaning list.`);
            } catch (e) { console.error("[fs-prompts] send failed:", e.message); }
          }
          console.log(`[fs-prompts] ${key} prompted ${phones.length} phone(s)`);
        }
      }
      // Keep the dedupe set from growing forever.
      for (const key of sentToday) if (!key.startsWith(localDate)) sentToday.delete(key);
    } catch (e) {
      console.error("[fs-prompts] tick failed:", e.message);
    }
  }

  tick();
  const handle = setInterval(tick, CHECK_EVERY_MS);
  console.log("[fs-prompts] food safety check prompts running (5-min tick)");
  return handle;
}

module.exports = { startFoodSafetyPrompts };
