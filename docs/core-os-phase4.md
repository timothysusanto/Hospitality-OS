# Core OS — Phase 4: Multi-award engine + pilot readiness
Added 22 Aug 2026. The build that makes the horizontal claim testable: Cleaning Services and Security Services award templates in the engine, and manager self-serve crew management so a pilot contractor can onboard without touching Firebase.

**The Phase 4 gate from the product spec still stands: the new brand name goes on nothing until a cleaning or security contractor has run a real pay cycle on this.** This code makes that pilot possible; it does not replace it.

## What's new
- **award-engine.js** now carries three awards, selectable per worker:
  - `MA000009` Hospitality (HIGA) — Level 1 verified, others estimated
  - `MA000022` Cleaning Services — TEMPLATE. Bases seeded from the published 2025/26 minimums (L1 $25.85 / L2 $26.70 / L3 $28.12) uplifted 4.75% per the 2026 review → L1 $27.08 / L2 $27.97 / L3 $29.46, ALL `verified: false`
  - `MA000016` Security Services — TEMPLATE, all estimated
  - Simplifications to know: both new awards' shift-loading structures (cleaning early/afternoon/night 115%, permanent night 130%; security night/broken-shift spans) are approximated by a single time loading in v1. The docket shows the amber unverified warning for any worker on an unverified rate — by design.
- **Crew management on /roster:** "+ Crew" button adds a worker (name, WhatsApp number, employment type, award, level — level list follows the award). Tap a worker → wallet → "Edit details" to change anything or deactivate (they keep their history, leave the roster).
- **API:** `GET /api/core/awards`, `PUT /api/core/workers/:id`. Also fixed a bug where creating a worker with an invalid level for their award sent an error *and kept going* (double-response crash risk).

## Pilot checklist — cleaning or security contractor
1. **Before the demo:** verify MA000022 (or MA000016) rates against the current FWO pay guide; correct `award-engine.js`, flip `verified: true` per level. Check the shift-loading structure against how the contractor actually rosters (night office cleaning ≠ day cleaning).
2. **Onboarding (15 min, all self-serve now):** add their crew via "+ Crew" with WhatsApp numbers → workers text the venue number → clock-in/out, roster publishing, wallet all work day one. Skip the Hospitality Edition entirely — that's the point of the two layers.
3. **Credential fit:** cleaning/security crews care about police checks, visas, first aid, security licences. NOTE: a NSW/WA security licence isn't in `credentialTypes.js` yet — add `security_licence` (blocking) before a security pilot. One-line change in credentialTypes.js.
4. **Exit test:** one full pay cycle, their timesheets reconciled against their current payroll to the cent, using `/api/core/export/payroll.csv`.
5. **Only then:** the rename, per the spec's hard gate.

## Still deliberately missing (don't oversell in the pilot)
Allowances (broken shift, first aid, toilet cleaning, gun/dog allowances in security), auto-priced weekly OT (flagged only), part-time guaranteed-hours rules, multi-site geofences per worker. List these openly with the pilot customer — a known-gaps list builds more trust than a surprise.
