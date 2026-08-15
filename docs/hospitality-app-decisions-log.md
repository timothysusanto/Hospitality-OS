# HospitalityOS — Decisions Log
*Written: August 15, 2026 — reconstructed from shipped code and README, since this file was referenced but never created.*

## Purpose
Running record of product/architecture decisions, logged as they're made. Referenced by `README.md` and `docs/agencymodelshape.md`. This is the source of truth for *why* the system works the way it does — not just what it does.

---

## Core Architecture

### WhatsApp-first, browser-only dev workflow
Staff and (later) hotels interact entirely over WhatsApp — no app installs, no logins, no portal. Mothy's own workflow is also 100% browser-based: edit on GitHub → Railway auto-redeploys. No local installs, no terminal, ever (an explicit constraint, not a limitation worked around).

### Frontend unified, backend modular
No business logic in the webhook skeleton (step 1) — each capability (clock-in, dashboard, stock, P&L, alerts, recipe lookup) arrives as its own handler module. Staff never see or choose a "module."

### Secrets discipline
Secrets live only in Railway's Variables tab — never in code, never committed. `.gitignore` blocks `.env` as a backstop. Every webhook POST is signature-verified against `META_APP_SECRET` (`verifySignature.js`) — never disabled, including in testing.

---

## Clock In/Out (Build Step 2)

### Geofence flags, doesn't hard-block
Sharing location outside a site's radius gets **"flagged for your manager to review"**, not a hard rejection. Deliberate no-accuracy-data design — GPS accuracy varies too much on phones to justify a hard block, but a flag still surfaces real anomalies to a human.

### Site resolution comes from the roster, not a guess
With more than one site, the clock-in resolves against the person's **rostered shift for that day** — if unrostered anywhere, the bot refuses rather than guessing a building. With exactly one site, it's used automatically.

### Sites are a first-class Firestore collection
One geofence per building, not one radius per tenant. A clock-in is checked against the site tied to that person's rostered shift. Sites carry lat/long + radius (default 75m), added via the dashboard — no code edit, no redeploy needed to add a building.

---

## Agency Model (built on top of the core product)

**Context:** ~300 casuals, ~15 hotel sites, both staff and hotels already on WhatsApp. No portal, no logins, on either side.

### One pool, two lanes, one number
A hotel booking 4 housekeepers for next Tuesday and a hotel that just lost a night porter at 5am are different problems — one solved with data (planned lane), one won with speed (urgent lane).

**The lane is derived from shift start time, never declared.** Under 12 hours out = urgent (10-min blast waves); further out = planned (2-hour waves). The API structurally refuses to accept a manually-set priority — nobody at the hotel or in the office can pick urgency.

### Three availability states, not two
Available / unavailable / **unknown**. Silence is never a "yes," and it's never a "no" either — an unknown person simply waits for a later wave. This distinction is load-bearing for how wave 2 targets only the unknown, not everyone who hasn't said yes (so people who already said no stop getting pinged, which is what keeps a casual pool responsive instead of numb to the messages).

### Capture ladder — nobody in the office types availability
Ordered by leverage: `same` (repeat last week) → `none` (explicit unavailable) → `today` (opt-in same-day pool, self-expiring ~12hrs) → shorthand text (`mon am pm, fri all`) → signed one-tap link to a 7×3 grid (no login required). Weekly cycle: ask Wednesday, chase Friday, expire with the week.

### Dispatch is a tick loop, not timers
All dispatch state lives on the request documents themselves, so a mid-blast redeploy resumes rather than abandons a half-filled request. `DISPATCH_DISABLED=1` exists specifically so a second instance can point at the same Firestore project without two loops blasting the same request simultaneously.

### Client intake: one number, two conversations
Sender identity — not a separate channel — decides whether an incoming WhatsApp message is a hotel ordering staff or a worker responding to a shift. Checked in order: registered requester on a site → staff collection → else told to have their manager register them.

**Never dispatch on an unconfirmed parse.** A structural guard, not a rule the code has to remember to follow: drafts are stored with `confirmedAt: null`, and the blast engine's work list excludes anything unconfirmed — so a mis-parsed "30" instead of "3:00" physically cannot go out as thirty shift offers.

### Compliance is a gate, not a display panel
A document that exists and has expired **blocks** the person — no configuration needed, since an expired credential is a liability regardless of settings. A document a *role* requires but the person doesn't hold also blocks — but this part is configurable per tenant (`POST /api/settings/compliance`), since only the operator knows what their clients demand. The gate re-runs at wave-build time *and* again the instant someone accepts, since a planned lane's 2-hour accept window is long enough for a document to lapse inside it.

**The fortnight hours cap evaluates every 14-day window containing the shift, not just the window ending at it** — otherwise accepting shifts in a certain order can slip someone over a cap that direct math would have caught.

### Pay rates are never visible to a site/client
Every client-facing message goes through one formatter with no access to rate or margin data, with tests asserting nothing leaks. If a hotel negotiated directly with a casual, the margin model would break — so the boundary is structural, not procedural.

**On-costs compound on the loaded wage, not the base.** Casual loading is part of the wage, so super/payroll tax/workers' comp apply on top of the loaded figure. Getting this wrong (computing off base) silently turns a real margin into a loss.

**An absent rate is `null`, never zero.** A shift missing a bill rate reports as "unbillable," not "$0 revenue"; missing a pay rate flags rather than displaying as 100% margin.

### Reports never re-derive a rule
Fill rate reads the stored `outcome`, latency reads offer timestamps, margin calls the same function the invoicing view uses. Nothing in the reporting layer recomputes business logic that already lives elsewhere — because a second implementation eventually disagrees with the first.

**A zero denominator reports `null`, not 0%.** "0% fill rate" and "no requests yet" would look identical otherwise, and only one of those is a problem worth flagging.

**Cancelled requests count as neither a hit nor a miss** — a hotel changing its mind shouldn't drag the fill rate down.

---

## Log Format Going Forward
Add new dated entries below as decisions are made — log immediately, don't batch.

### Aug 15, 2026
- Confirmed `Hospitality-OS` is the actual app repo (distinct from `kitchenfounder-workspace`, which is Claw's general memory/products workspace — the two were previously conflated).
- Found this file and `docs/backend-build-scope.md` were referenced throughout the README but never actually created — both written today to close that gap.
- Repo is currently public — recommend setting to private via GitHub repo Settings.
