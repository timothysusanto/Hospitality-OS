Agency model — system shape
Design note for extending Hospitality OS from a single-venue tool to a
labour-hire agency supplying casual staff to Sydney hotels.
Context: ~300 casuals, ~15 hotel sites, both staff and hotels already
on WhatsApp. No portal, no logins, no app installs on either side.
---
The shape: one pool, two lanes, one number
A hotel asking for four housekeepers next Tuesday and a hotel that just lost a
night porter at 5am are not the same business. The first is a matching problem
solved with data. The second is a race won with speed. They share a staff pool
and a phone number — and almost nothing else.
The lane is derived from the shift start time, never declared. Under twelve
hours out is urgent, otherwise planned. Nobody at the hotel picks a priority.
---
Availability: three blocks cover the clock
Free-typed time ranges fail at scale — too much typing, too many formats.
Hotels already cut the day into three shifts, so use those as the unit of
answer. Staff answer in blocks; the system stores real times, so matching
and reporting stay exact.
Block	Hours	What it is
AM	06:00–14:00	Housekeeping, breakfast, early F&B
PM	14:00–22:00	Lunch/dinner service, banquets, evening reception
Night	22:00–06:00	Night audit, security, overnight porter
No gaps, no overlaps, and the words already mean this to a hotel.
A person's week is a subset of 21 cells (7 days × 3 blocks). A shift
matches if its hours fall inside a declared block — a 17:00–23:00 dinner
service is simply PM.
A night belongs to the date it starts on. "Friday night" means Friday into
Saturday, because that is what staff mean. Payroll still splits at midnight;
the two are allowed to differ as long as it's deliberate.
Availability lives in a document per person per week, not as a field on
the staff record. A casual with a second job has a different answer every
week, and last month's answer must never be reused as this week's.
> **Three states, not two: available, unavailable, and unknown.** Silence is
> never a yes. Unknown isn't a failure either — it just means that person waits
> for a later wave.
---
Capture: nobody in the office types availability
Each rung catches most of whoever is left. Weekly cycle: ask Wednesday, chase
Friday, expire with the week — supply is on the board before the hotels'
requests land.
"Same again" — one button. A settled casual pool mostly repeats. This
single tap should resolve the clear majority of 300 people, and it's the
highest-leverage thing in the whole design.
A standing pattern, set once. "Normally free AM Mon–Fri", captured at
onboarding. Turns the weekly ping into confirm-or-amend.
The grid, for whoever changed. A signed one-tap link — no login, no
password — to a 7 × 3 chip grid. Twenty seconds. Becomes an in-chat form
later; staff won't notice the difference.
Text shorthand, for the people who like typing: `mon am pm, wed night, fri all`. Costs nothing to keep, will always be a minority.
The free-today pool — the same-day answer. A separate, opt-in,
self-expiring signal: tap once in the morning and you're a hot lead for ~12
hours, then it decays on its own. Opt-in makes it high-signal — nobody taps
it unless they want a shift today — and the incentive is real: first refusal
on today's work.
> **The roster is the only availability data that's never wrong.** Whoever is
> already booked is known with certainty. On a day with 120 people working,
> that's 40% of the pool filtered out with zero guessing — use it as a hard
> negative filter on both lanes.
---
Dispatch: one blast engine, configured twice
Waves, an atomic first-come claim, auto-expiry, and response timing — built
once. The two lanes are the same machine with different dials.
	Planned (12h+ out)	Urgent (under 12h)
Match on	Availability, compliance, hours cap	Who answers fast; availability is a hint
Wave 1	Available + compliant, ranked by reliability	Free-today pool, ranked by median response time
Wave 2	+2h — availability unknown but compliant	+10 min — unknown but compliant
Wave 3	—	+20 min — everyone compliant, flagged urgent
Accept window	2 hours	10 minutes, then next wave
Sells on	Price and consistency	Speed — bill it at a premium
A person with flawless availability data who replies in three hours is worthless
at 5:30am. Median response time is the most valuable number in a same-day
business, and it only exists if every offer records when it was sent and when
it was answered.
> **Auto-backfill closes the loop.** No clock-in fifteen minutes after a shift
> starts triggers the urgent blast automatically and tells the operator it's
> already running. The supervisor notices the gap at 7:15am; the replacement was
> accepted at 7:04.
---
Message flows
Both sides run on the same number. Sender identity decides which conversation
you're in — the same gate that already turns away unregistered staff in
`router.js`.
Staff, Wednesday:
```
→  Next week, 11–17 Aug.
   Last week you were free Mon AM, Wed AM/PM, Fri AM.
   [Same again] [Change it] [Not available]
←  Same again
→  Locked in. You'll get offers as they come.

←  today
→  You're in the pool for today until 8pm.
```
Hotel, 05:40:
```
←  need 3 housekeepers tomorrow 7am
→  3 × Housekeeping — Hilton Sydney
   Tue 5 Aug, 07:00–15:00
   [Confirm] [Edit]
←  Confirm
→  Searching — 41 people notified.
→  2 of 3 filled: Maria S., Ahmed K.
→  All 3 confirmed. Jo T. joins them.
```
Hotel, shift day:
```
→  Maria clocked in 06:52 · Ahmed 06:58 · Jo 07:12, 12 min late
→  Shift complete — 24.0 hrs total.  [Approve] [Query]
←  Approve
→  Signed off. This goes on your 5 Aug invoice.
```
Free text in, structured confirmation back. Never dispatch on an
unconfirmed parse — that confirm step is the contract, the audit trail, and
the guard against sending thirty people.
Only registered numbers can order. Requesters listed per site; unknown
numbers get asked to have their manager register.
Phone calls aren't banned, they're out-competed. When one happens, the
operator types it into the same thread so a record exists. A written trail of
what was ordered is what wins invoice disputes.
---
Data model
Every report depends on the shift carrying its site, the request it filled, and
both rates. Miss one field now and the report is impossible to reconstruct.
Collection	Fields
`sites/{siteId}` new	name · geofence {lat, lng, radiusMeters} · address · requesters[] · billRates{role}
`staff/{phone}`	tenantId · name · roles[] · payRate · standingPattern · compliance{rsa, police, visa, expiry} · reliability{offered, accepted, showed, late, noShow, medianResponseSec}
`availability/{tenant_phone_weekStart}` new	weekStart · days{"YYYY-MM-DD": ["AM","PM","NIGHT"]} · source · submittedAt
`freeToday/{phone}` new	declaredAt · expiresAt (self-expiring, never edited by an operator)
`requests/{requestId}` new	siteId · role · startsAt · endsAt · headcount · filled · requestedBy · lane · createdAt · confirmedAt · filledAt · outcome
`offers/{offerId}` new	requestId · phone · wave · sentAt · respondedAt · outcome (accepted/declined/expired)
`shifts/{shiftId}`	phone · siteId · requestId · role · clockIn · clockOut · flagged · payRate · billRate · approvedBy · approvedAt
`sites` replaces the single per-tenant geofence in `tenantStore.js` — an agency
sends people to fifteen buildings, so the geofence has to come off the assigned
shift, not off the tenant.
---
Reporting: every number splits by lane
Blending planned and urgent hides both. Reported apart, the urgent column
becomes a sales asset you can price against.
Report	Split	What it's for
Fill rate	planned / urgent	The headline number. A planned miss is an ops failure; an urgent miss is a supply problem.
Time to fill	urgent	Median minutes, request to confirmed. "87% of same-day filled, median 34 minutes" is the pitch.
Supply vs demand	7 × 3 grid	Declared headcount per day-block against demand. Shows you're twelve Night people short on weekends before you fail to fill.
Margin per placement	planned / urgent	Bill less pay less on-costs (casual loading, super, payroll tax, workers comp). Urgent skews to nights and weekends — billing it flat while paying penalties loses money.
Lost demand	by site & hour	Requests declined or unfilled. Invisible today because a phone call leaves no trace.
Reliability	per person	Offered, accepted, showed, late, no-showed. Feeds wave-1 ranking.
Response latency	per person	Median seconds to answer an offer. Your genuine top staff.
Free-today pool by hour	urgent	Thin at 5am Saturdays? A recruitment target, months early.
Compliance pipeline	30-day horizon	Who lapses soon and how many placements that endangers. Also a hard gate.
Fortnight hours cap	per person	Hours across all sites. Student-visa exposure, carried by the agency.
Client hours	per site	Invoicing, with sign-off status per shift.
---
Build order
Sites and shift-level geofence. Until the geofence comes off the assigned
shift rather than the tenant, clock-in flags every placement and no
downstream data is trustworthy.
Requests, offers, and the blast engine. Waves, atomic first-come claim,
auto-expiry, response timing. Serves both lanes from day one. With step 1,
auto-backfill on no-show falls out almost free.
Availability and the free-today pool. Three blocks, per-week documents,
the "same again" button, the grid link. Deliberately after the engine —
availability only serves the planned lane, and same-day is half the volume.
Client intake over chat. Parse, confirm, dispatch. Requester registry per
site. The status loop back to the hotel. This is what stops the phone
ringing.
Compliance gate and hours cap. Expiry blocks assignment; fortnight hours
across all sites block it too. A gate, not a display panel.
Timesheet sign-off, bill rates, margin. One-tap approval from the
supervisor's phone. The existing penalty-rate engine (`server.js`) already
computes the cost side; adding the bill side turns it into a margin report.
Reporting. Last, because it's mostly free by then.
---
Still open
One number or two. Sender identity can route staff and hotels through a
single line, which is cheaper and simpler. Two numbers buy separation of tone.
Decide before step 4.
Message costs at 300 staff. Weekly pings plus every offer are
business-initiated: approved templates, per-message cost. Model the monthly
number before quoting an agency — wave 3 of an urgent blast can touch the
whole pool.
Two hotels wanting the same person. First-come is fair and simple;
preferred-client priority earns more. Pick one before it happens on a
Saturday.
Who owns the pay rate conversation. If a hotel negotiates directly with a
casual, the margin model breaks quietly. Decide whether rates are ever visible
to the site.
Night shifts across midnight. Availability keyed to the starting date,
payroll split at midnight — settled here, but every future date query will
assume one or the other.
