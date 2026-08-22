"use strict";

/**
 * foodSafetyRoutes.js — Hospitality Edition API (Core OS Phase 3).
 * Mounted at /api/core/foodsafety behind the same dashboard key.
 *
 *   GET  /today                    → units + today's readings, cleaning, deliveries, failures
 *   GET  /export?from=&to=         → 3.2.2A evidence pack CSV (all entries + corrective actions)
 *   GET  /settings  PUT /settings  → units / cleaning tasks / prompt times / prompt phones
 *   GET  /training?days=90         → training completions
 */

const express = require("express");
const { DEFAULT_SETTINGS } = require("./foodSafetyHandler");

module.exports = function foodSafetyRoutes({ db, tenantId }) {
  const router = express.Router();
  if (!db) {
    router.use((_req, res) => res.status(503).json({
      error: "Food safety diary needs Firestore. Set FIREBASE_SERVICE_ACCOUNT_JSON and redeploy.",
    }));
    return router;
  }
  const T = () => db.collection("tenants").doc(tenantId);
  const settingsRef = () => T().collection("settings").doc("foodSafety");

  async function getSettings() {
    const doc = await settingsRef().get();
    if (!doc.exists) { await settingsRef().set(DEFAULT_SETTINGS); return { ...DEFAULT_SETTINGS }; }
    return { ...DEFAULT_SETTINGS, ...doc.data() };
  }

  router.get("/today", async (_req, res) => {
    try {
      const settings = await getSettings();
      const today = new Date().toISOString().slice(0, 10);
      const snap = await T().collection("foodSafetyLogs").where("date", "==", today).get();
      const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.at.localeCompare(b.at));

      const temps = logs.filter((l) => l.kind === "temp");
      const unitStatus = settings.units.map((u) => {
        const readings = temps.filter((t) => t.unitId === u.id && !t.skipped);
        const latest = readings[readings.length - 1] || null;
        return { ...u, readings, latest, checkedCount: readings.length };
      });
      const cleaning = settings.cleaningTasks.map((t) => ({
        ...t, done: logs.find((l) => l.kind === "cleaning" && l.taskId === t.id) || null,
      }));
      res.json({
        date: today, settings, unitStatus, cleaning,
        deliveries: logs.filter((l) => l.kind === "delivery"),
        failures: logs.filter((l) => l.pass === false),
      });
    } catch (e) { err(res, e); }
  });

  router.get("/export", async (req, res) => {
    try {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: "from and to (YYYY-MM-DD) are required" });
      const snap = await T().collection("foodSafetyLogs")
        .where("date", ">=", from).where("date", "<=", to).get();
      const logs = snap.docs.map((d) => d.data()).sort((a, b) => a.at.localeCompare(b.at));
      const rows = [[
        "Date", "Time", "Type", "Item", "Value(°C)", "Result", "By",
        "CorrectiveAction", "CorrectiveBy", "PhotoEvidence",
      ]];
      for (const l of logs) {
        rows.push([
          l.date, l.at.slice(11, 16),
          l.kind, l.unit || l.task || l.supplier || "",
          l.value == null ? "" : l.value,
          l.skipped ? "SKIPPED" : l.pass === false ? "FAIL" : l.pass === true ? "PASS" : "recorded",
          l.byName || l.byPhone || "",
          l.correctiveAction || "", l.correctiveBy || "",
          l.photoUrl || (l.photoMediaId ? "photo on file (WhatsApp)" : ""),
        ]);
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=food_safety_evidence_${from}_${to}.csv`);
      res.send(rows.map((r) => r.map(csvCell).join(",")).join("\n"));
    } catch (e) { err(res, e); }
  });

  router.get("/settings", async (_req, res) => {
    try { res.json({ settings: await getSettings() }); } catch (e) { err(res, e); }
  });

  router.put("/settings", async (req, res) => {
    try {
      const allowed = ["units", "cleaningTasks", "scheduleTimes", "promptPhones", "timezone"];
      const patch = {};
      for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
      if (!Object.keys(patch).length) return res.status(400).json({ error: `Nothing to update. Allowed: ${allowed.join(", ")}` });
      await settingsRef().set(patch, { merge: true });
      res.json({ settings: await getSettings() });
    } catch (e) { err(res, e); }
  });

  router.get("/training", async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const snap = await T().collection("trainingRecords").where("completedAt", ">=", since).get();
      res.json({
        records: snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt)),
      });
    } catch (e) { err(res, e); }
  });

  return router;
};

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function err(res, e) {
  console.error("[foodsafety]", e);
  res.status(500).json({ error: e.message });
}
