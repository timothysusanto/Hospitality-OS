"use strict";

/**
 * foodSafetyHandler.js — Digital food safety diary over WhatsApp
 * (Hospitality Edition, Core OS Phase 3).
 *
 * Everything happens in the chat the crew already uses:
 *
 *   Worker: temps
 *   Bot:    🌡 Temp run 1/4 — Walk-in fridge (0–5°C). Reply with the reading.
 *   Worker: 3.2
 *   Bot:    ✅ Walk-in fridge 3.2°C. 2/4 — Freezer (−15°C or colder)…
 *   Worker: -12
 *   Bot:    🔴 Freezer −12°C is OUT OF RANGE. What did you do about it?
 *   Worker: moved stock to freezer 2, called tech
 *   Bot:    Corrective action logged. 3/4 — Bain-marie (60°C+)…
 *
 *   Worker: clean            → today's cleaning tasks; "clean 2" ticks one off
 *   Worker: delivery bidfood 3.4  → receiving check, temp validated
 *   Worker: [photo]          → attaches to their last log entry (10-min window)
 *
 * Every entry stores who, when, value, pass/fail and corrective action —
 * the substantiation evidence Standard 3.2.2A expects, exportable from
 * /api/core/foodsafety/export.
 *
 * Units, cleaning tasks and prompt times live in Firestore at
 * tenants/{t}/settings/foodSafety — sensible kitchen defaults are seeded
 * on first use so the feature works before anyone configures anything.
 */

const { sendText } = require("./whatsapp");
const { getFirestoreDb } = require("./firebase");
const { storeImage } = require("./walletHandler");

const RUN_TTL_MS = 15 * 60 * 1000;
const PHOTO_ATTACH_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, object>} phone → active temp run */
const runs = new Map();
/** @type {Map<string, {ref: any, at: number}>} phone → last log ref for photo attach */
const lastLog = new Map();

const DEFAULT_SETTINGS = {
  units: [
    { id: "walkin",  label: "Walk-in fridge",  min: 0,   max: 5 },
    { id: "freezer", label: "Freezer",         min: -30, max: -15 },
    { id: "prep",    label: "Prep fridge",     min: 0,   max: 5 },
    { id: "hothold", label: "Bain-marie / hot hold", min: 60, max: 99 },
  ],
  cleaningTasks: [
    { id: "benches", label: "Benches & boards sanitised" },
    { id: "floors",  label: "Floors swept & mopped" },
    { id: "bins",    label: "Bins emptied & cleaned" },
    { id: "seals",   label: "Coolroom seals & handles" },
  ],
  scheduleTimes: ["07:00", "15:00", "21:00"],
  promptPhones: [],
  timezone: "Australia/Sydney",
};

async function getSettings(tenantId) {
  const db = getFirestoreDb();
  const ref = db.collection("tenants").doc(tenantId).collection("settings").doc("foodSafety");
  const doc = await ref.get();
  if (!doc.exists) { await ref.set(DEFAULT_SETTINGS); return { ...DEFAULT_SETTINGS }; }
  return { ...DEFAULT_SETTINGS, ...doc.data() };
}

function logsCol(tenantId) {
  return getFirestoreDb().collection("tenants").doc(tenantId).collection("foodSafetyLogs");
}

async function writeLog(tenantId, entry) {
  const ref = await logsCol(tenantId).add({
    ...entry,
    at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
  });
  return ref;
}

// ---------------------------------------------------------------------------
// "temps" — the guided temperature run
// ---------------------------------------------------------------------------
async function handleTempsCommand(from, staff, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) { await sendText(from, "Food safety diary isn't switched on yet — ask your manager.", sendOpts); return; }
  const settings = await getSettings(tenantId);
  if (!settings.units.length) { await sendText(from, "No units configured yet — ask your manager to set up the fridge list.", sendOpts); return; }
  runs.set(from, { units: settings.units, idx: 0, correctiveFor: null, startedAt: Date.now(), tenantId, byName: staff.name });
  const u = settings.units[0];
  await sendText(from,
    `🌡 Temp run — ${settings.units.length} units.\n1/${settings.units.length}: *${u.label}* (${rangeLabel(u)}).\n` +
    `Reply with the reading (e.g. 3.2). "skip" to skip a unit, "stop" to abort.`, sendOpts);
}

/** Returns true when the message belonged to an active temp run / corrective. */
async function handleFoodSafetyReply(from, staff, body, tenantId, deps, sendOpts) {
  const run = runs.get(from);
  if (!run) return false;
  if (Date.now() - run.startedAt > RUN_TTL_MS) { runs.delete(from); return false; }

  // Awaiting a corrective action for a failed reading
  if (run.correctiveFor) {
    await run.correctiveFor.update({ correctiveAction: body, correctiveBy: staff.name, correctiveAt: new Date().toISOString() });
    run.correctiveFor = null;
    await sendText(from, "📝 Corrective action logged.", sendOpts);
    return advanceRun(from, staff, run, sendOpts);
  }

  if (body === "stop" || body === "cancel") {
    runs.delete(from);
    await sendText(from, `Temp run stopped at ${run.idx}/${run.units.length}. Text "temps" to start again.`, sendOpts);
    return true;
  }
  if (body === "skip") {
    const u = run.units[run.idx];
    await writeLog(tenantId, { kind: "temp", unitId: u.id, unit: u.label, value: null, pass: null, skipped: true, byPhone: from, byName: staff.name });
    run.idx++;
    return advanceRun(from, staff, run, sendOpts, `⏭ ${u.label} skipped.`);
  }

  const value = parseTemp(body);
  if (value === null) {
    await sendText(from, `That doesn't look like a temperature. Reply with a number like 3.2 (or −18 for the freezer), "skip", or "stop".`, sendOpts);
    return true;
  }

  const u = run.units[run.idx];
  const pass = value >= u.min && value <= u.max;
  const ref = await writeLog(tenantId, { kind: "temp", unitId: u.id, unit: u.label, value, pass, byPhone: from, byName: staff.name });
  lastLog.set(from, { ref, at: Date.now() });
  run.idx++;

  if (!pass) {
    run.correctiveFor = ref;
    await sendText(from,
      `🔴 *${u.label} ${value}°C is OUT OF RANGE* (${rangeLabel(u)}).\nWhat did you do about it? (e.g. "moved stock, called tech") — this is recorded.`, sendOpts);
    return true;
  }
  return advanceRun(from, staff, run, sendOpts, `✅ ${u.label} ${value}°C.`);
}

async function advanceRun(from, staff, run, sendOpts, prefix = "") {
  if (run.idx >= run.units.length) {
    runs.delete(from);
    const fails = run.units.length; // recomputed in summary below is overkill — keep message simple
    await sendText(from, `${prefix ? prefix + "\n" : ""}🏁 Temp run complete — ${run.units.length} units logged, ${new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}. You can send a photo of the last probe reading to attach it.`, sendOpts);
    return true;
  }
  const u = run.units[run.idx];
  await sendText(from, `${prefix ? prefix + " " : ""}${run.idx + 1}/${run.units.length}: *${u.label}* (${rangeLabel(u)}) — reading?`, sendOpts);
  return true;
}

// ---------------------------------------------------------------------------
// "clean" — today's checklist
// ---------------------------------------------------------------------------
async function handleCleanCommand(from, staff, body, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) { await sendText(from, "Food safety diary isn't switched on yet — ask your manager.", sendOpts); return; }
  const settings = await getSettings(tenantId);
  const today = new Date().toISOString().slice(0, 10);
  const doneSnap = await logsCol(tenantId).where("date", "==", today).where("kind", "==", "cleaning").get();
  const doneIds = new Set(doneSnap.docs.map((d) => d.data().taskId));

  const arg = body.replace(/^clean\s*/, "").trim();
  if (arg) {
    const n = parseInt(arg, 10);
    const task = !isNaN(n) ? settings.cleaningTasks[n - 1]
      : settings.cleaningTasks.find((t) => t.id === arg || t.label.toLowerCase().includes(arg));
    if (!task) { await sendText(from, `Couldn't find that task. Text "clean" to see the numbered list.`, sendOpts); return; }
    if (doneIds.has(task.id)) { await sendText(from, `${task.label} — already done today. ✅`, sendOpts); return; }
    const ref = await writeLog(tenantId, { kind: "cleaning", taskId: task.id, task: task.label, byPhone: from, byName: staff.name });
    lastLog.set(from, { ref, at: Date.now() });
    await sendText(from, `🧽 ${task.label} — done, logged to you. Send a photo if you want it attached.`, sendOpts);
    return;
  }

  const lines = settings.cleaningTasks.map((t, i) => `${doneIds.has(t.id) ? "✅" : "⬜"} ${i + 1}. ${t.label}`);
  await sendText(from, `🧽 Today's cleaning:\n${lines.join("\n")}\n\nReply "clean 2" (or "clean bins") to tick one off.`, sendOpts);
}

// ---------------------------------------------------------------------------
// "delivery <supplier> [temp]" — receiving check
// ---------------------------------------------------------------------------
async function handleDeliveryCommand(from, staff, body, tenantId, deps, sendOpts) {
  const db = getFirestoreDb();
  if (!db) { await sendText(from, "Food safety diary isn't switched on yet — ask your manager.", sendOpts); return; }
  const m = body.match(/^delivery\s+([a-z0-9 &''-]+?)(?:\s+(-?\d+(?:\.\d+)?))?\s*$/i);
  if (!m) { await sendText(from, `Log a delivery like: "delivery bidfood 3.4" (chilled temp) or just "delivery bidfood".`, sendOpts); return; }
  const supplier = m[1].trim();
  const value = m[2] !== undefined ? parseFloat(m[2]) : null;
  const pass = value === null ? null : value <= 5;
  const ref = await writeLog(tenantId, { kind: "delivery", supplier, value, pass, byPhone: from, byName: staff.name });
  lastLog.set(from, { ref, at: Date.now() });
  if (pass === false) {
    runs.set(from, { units: [], idx: 0, correctiveFor: ref, startedAt: Date.now(), tenantId, byName: staff.name });
    await sendText(from, `🔴 ${supplier} received at ${value}°C — that's over 5°C for chilled goods. What did you do? (reject/accept + why) — this is recorded.`, sendOpts);
  } else {
    await sendText(from, `🚚 ${supplier} delivery logged${value !== null ? ` at ${value}°C ✅` : ""}. Send a photo of the docket to attach it.`, sendOpts);
  }
}

// ---------------------------------------------------------------------------
// Photo → attach to the last diary entry (returns false → wallet takes it)
// ---------------------------------------------------------------------------
async function handleFoodSafetyPhoto(from, staff, image, tenantId, deps, sendOpts) {
  const last = lastLog.get(from);
  if (!last || Date.now() - last.at > PHOTO_ATTACH_TTL_MS) return false;
  let photoUrl = null;
  try {
    const { fetchMediaBinary } = require("./whatsapp");
    const media = await fetchMediaBinary(image.id, sendOpts);
    if (media) photoUrl = await storeImage(tenantId, `foodsafety-${from}`, media.buffer, media.mimeType);
  } catch (e) { /* attach the media id regardless */ }
  await last.ref.update({ photoMediaId: image.id, photoUrl: photoUrl || null });
  lastLog.delete(from);
  await sendText(from, "📎 Photo attached to your last log entry.", sendOpts);
  return true;
}

// ---------------------------------------------------------------------------
function parseTemp(body) {
  const m = String(body).replace("−", "-").match(/^\s*(-?\d+(?:\.\d+)?)\s*(?:c|°c)?\s*$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v >= -40 && v <= 120 ? v : null;
}
function rangeLabel(u) {
  if (u.max <= 0) return `${u.max}°C or colder`;
  if (u.min >= 60) return `${u.min}°C or hotter`;
  return `${u.min}–${u.max}°C`;
}

module.exports = {
  handleTempsCommand, handleFoodSafetyReply, handleCleanCommand,
  handleDeliveryCommand, handleFoodSafetyPhoto, getSettings, DEFAULT_SETTINGS,
};
