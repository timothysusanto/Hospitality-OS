# HospitalityOS — Backend Build Scope
*Written: August 15, 2026 — reconstructed from shipped code and README, since this file was referenced but never created.*

## Stack
- **Runtime:** Node.js 18+, Express, CommonJS
- **Messaging:** WhatsApp via Meta Cloud API — single webhook (`/webhook/whatsapp`), signature-verified against `META_APP_SECRET`
- **Database:** Firebase Firestore (`firebase.js`, `firebase-admin`)
- **Hosting:** Railway, auto-deploys from GitHub on push
- **Dev workflow:** 100% browser — edit files on GitHub, Railway redeploys automatically. No local installs required (optional local dev path exists for `node --env-file=.env server.js` + ngrok, but browser-only is the recommended path)
- **Testing:** Node's built-in test runner (`node --test`), zero dependencies, in-memory stores, injected time (not real sleeps) — full suite runs in under a second

## Environment Variables (Railway → Variables)
| Variable | Purpose |
|---|---|
| `WHATSAPP_TOKEN` | Meta dashboard → WhatsApp → API Setup |
| `WHATSAPP_PHONE_NUMBER_ID` | Same page |
| `WHATSAPP_VERIFY_TOKEN` | Operator-invented string, must match Meta config |
| `META_APP_SECRET` | Meta dashboard → App Settings → Basic |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase service account key (leave blank for in-memory testing) |
| `LINK_SIGNING_SECRET` | 16+ chars — required for signed one-tap availability links |
| `PUBLIC_BASE_URL` | Required alongside `LINK_SIGNING_SECRET` |
| `DISPATCH_DISABLED` | Set to `1` to run an instance without the dispatch tick loop (e.g. a second instance on the same Firestore project) |

## Main Product — Build Order
| Step | What | Status |
|---|---|---|
| 1 | Webhook skeleton — WhatsApp → Meta Cloud API → webhook → sender lookup → reply | ✅ Shipped |
| 2 | Clock in/out — GPS geofence, Firestore `shifts`, manager-review flagging for out-of-radius | ✅ Shipped |
| 3 | Manager dashboard (read-only: who's on shift, review flagged clock-ins) | Next |
| 4 | Stock from invoice photo — Claude vision, confirm flow | Planned |
| 5 | Daily P&L — fixed-cost setup + till photo | Planned |
| 6 | Alerts — no-show, labour % (needs Meta template approval — start early) | Planned |
| 7 | Recipe lookup | Planned |

**Key files (main product):** `server.js`, `router.js`, `whatsapp.js`, `verifySignature.js`, `store.js`/`stores.js`, `siteStore.js`, `siteResolver.js`, `geofence.js`, `shiftsStore.js`, `clockHandler.js`, `firebase.js`

## Agency Model — Build Order (extends the same codebase)
Second build order for running this as a labour-hire agency supplying casual staff across multiple hotel sites. Documented fully in `docs/agencymodelshape.md`.

| Step | What | Status |
|---|---|---|
| 1 | Sites + shift-level geofence | ✅ Shipped |
| 2 | Requests, offers, dispatch/blast engine | ✅ Shipped |
| 3 | Weekly availability + free-today pool | ✅ Shipped |
| 4 | Client intake over chat | ✅ Shipped |
| 5 | Compliance gate + fortnight hours cap | ✅ Shipped |
| 6 | Timesheet sign-off, bill rates, margin | ✅ Shipped |
| 7 | Reporting | ✅ Shipped |

**Key files (agency model):** `dispatch.js`, `requestParser.js`, `requestsStore.js`, `offerHandler.js`, `offersStore.js`, `availabilityHandler.js`, `availabilityCapture.js`, `availabilityBlocks.js`, `availabilityStore.js`, `freeTodayStore.js`, `intakeHandler.js`, `signedLinks.js`, `compliance.js`, `signoffHandler.js`, `margin.js`, `reliability.js`, `reports.js`, `pendingActions.js`, `tenantStore.js`, `purchasesStore.js`, `rosterStore.js`

**Key API endpoints:**
- `POST /api/sites/:id/requesters` — register a hotel's ordering number
- `POST /api/sites/:id/bill-rates` — set rate card per role
- `POST /api/settings/on-costs` — set super/payroll tax/workers' comp rates
- `POST /api/settings/compliance` — set which documents are required per role, per tenant
- `GET /api/compliance` — 30-day compliance pipeline
- `GET /api/hours` — committed hours per person (fortnight cap tracking)
- `GET /api/reports/margin` — margin split by lane (planned/urgent)
- `GET /api/reports/agency?from=&to=&week=` — full report bundle (fill rate, time to fill, lost demand, supply vs demand, margin, reliability, response latency, free-today by hour, client hours)

**Frontend:** `public/availability.html` (signed one-tap availability grid), `public/dashboard.html` (manager dashboard)

## Data Model Notes
- Every document carries `tenantId` — Firestore security rules must enforce it (referenced in README security notes, not yet fully detailed here — **open item**, see below).
- Sites live in Firestore with lat/long/radius — added via dashboard, no redeploy needed.
- Availability lives in a **document per person per week** (not a field on the staff record), since availability changes week to week.
- Requests carry `confirmedAt: null` until a hotel confirms — the blast engine's work list structurally excludes unconfirmed drafts.

## Open Items / Not Yet Documented Here
- Full Firestore security rules (referenced in README as needed for `tenantId` isolation — not yet written up in this doc)
- Exact vision/OCR flow for step 4 (stock from invoice photo) — README says "Claude vision, confirm flow" but implementation not yet built
- Meta message template approval process for step 6 alerts (README flags "start early" — no evidence yet this has been started)
- Whether/how this repo and `kitchenfounder-workspace` (Claw's memory repo) should cross-reference each other, since they currently exist as two separate, unlinked repos

## Security Notes (from README — do not skip)
- Secrets only in Railway Variables, never committed. `.gitignore` blocks `.env` as a backstop.
- Every webhook POST signature-verified against `META_APP_SECRET` — never disable, including in testing.
- Bot backend passes every outgoing reply through a role-visibility check before sending — financial fields never reach staff-role numbers (this is the same mechanism noted in the decisions log under "pay rates never visible to a site/client").
