# Core OS — Phase 1 (Deskless Workforce OS)
Added 22 Aug 2026. Rostering v2 with live HIGA award costing, credential wallet with roster guard, payroll CSV and wage-compliance exports. This is the start of the two-layer rebuild (Core OS → Hospitality Edition) — see the product spec.

## What was added
- `award-engine.js` — config-driven HIGA (MA000009) interpretation. Pure module.
- `core-os-routes.js` — Express router mounted at **`/api/core`** in server.js, gated by `requireDashboardKey` (same `MANAGER_DASHBOARD_PASSWORD` as the existing dashboard). Namespaced to avoid the pre-existing `/api/roster`.
- `public/roster.html` — manager roster page at **`/roster`**. Light theme. Pass the key once as `/roster?key=YOUR_KEY` (it's remembered on the device), or it will prompt.

## URLs after deploy
- Page: `https://hospitality-os-production-3a88.up.railway.app/roster?key=…`
- API: `/api/core/workers`, `/api/core/roster?weekStart=YYYY-MM-DD`, `/api/core/roster/shift`,
  `/api/core/roster/publish`, `/api/core/wallet/:workerId`, `/api/core/wallet-alerts`,
  `/api/core/export/payroll.csv?weekStart=`, `/api/core/export/compliance-pack?from=&to=`
  (all take `?key=` or `X-Dashboard-Key`)

## Firestore (auto-created under tenants/demo-venue)
- `workers` { name, phone, employmentType: fulltime|parttime|casual, level: L1–L6, awardCode: "MA000009", active }
- `shifts`, `shiftAudit` (managed — audit trail incl. deletions)
- `credentials` { workerId, type: visa|rsa|white_card|ndis_screening|police_check|fss|first_aid|drivers_licence, expiryDate, number, fileUrl }
- `settings/publicHolidays` { dates: ["2026-12-25", …] } ← add NSW dates
If `FIREBASE_SERVICE_ACCOUNT_JSON` is missing, `/api/core/*` answers 503 with instructions instead of crashing.

## BEFORE FIRST LIVE PAY RUN — non-negotiable
1. Only HIGA **Level 1** is verified ($26.44 FT / $33.05 casual, 2026/27). L2–L6, evening/night
   loadings and OT multipliers are `verified: false` in `award-engine.js` — check each against the
   current Fair Work HIGA pay guide, correct, flip the flag. The docket shows an amber warning until done.
2. Run in parallel with the current payroll for one full cycle and reconcile to the cent.
3. Known v1 simplifications: weekly OT is flagged not auto-priced; loadings assume breaks fall
   outside loading windows; allowances (split shift, meal, laundry) not built yet.

## Phase 2 next
Wallet WhatsApp photo intake (worker sends a photo of their RSA → OCR expiry → stored), expiry
nudges to workers, then Hospitality Edition (food safety diary, multilingual training, KF Pro bundle).
