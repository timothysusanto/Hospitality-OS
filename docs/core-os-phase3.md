# Core OS — Phase 3: Hospitality Edition
Added 22 Aug 2026. The food safety diary, scheduled check prompts, Standard 3.2.2A evidence export, and the first multilingual training module — all delivered through the WhatsApp the crew already uses, with a manager page at `/foodsafety`.

## Crew commands (WhatsApp)
| Text | What happens |
|---|---|
| `temps` | Guided temp run, unit by unit. Out-of-range → the bot demands a corrective action before continuing, and records it. |
| `clean` / `clean 2` / `clean bins` | Today's cleaning checklist / tick one off (logged to the person). |
| `delivery bidfood 3.4` | Receiving check; chilled temps over 5°C trigger the corrective-action flow. |
| *(photo)* | Within 10 min of a diary entry → attaches to it (probe display, docket). Otherwise it's treated as a credential for the wallet, as before. |
| `train` → `train 1 ne` | Food Safety Basics: 3 lessons + 3-question quiz in English, नेपाली or 中文. Pass mark 2. Completion recorded against the worker. |

## Manager page — `/foodsafety` (same key as `/roster`, cross-linked)
Today's readings per unit (pass/fail/not-checked), failures with their corrective actions, cleaning checklist status, deliveries, training completions, and the **evidence pack export** — a date-range CSV of every reading, cleaning record, delivery check, who logged it, every corrective action and photo reference. That CSV is the 3.2.2A substantiation pack for the EHO.

## Scheduled prompts — off by default, deliberately
No surprise messages on deploy day. Turn on with:
```
PUT /api/core/foodsafety/settings   (with ?key=…)
{ "promptPhones": ["61420878724"], "scheduleTimes": ["07:00","15:00","21:00"] }
```
Then at each time (venue timezone, default Australia/Sydney) those phones get "🌡 07:00 checks are due — text 'temps'…". `FOOD_SAFETY_PROMPTS_DISABLED=1` for debug instances.

## Configuration (seeded defaults, edit any time)
`tenants/demo-venue/settings/foodSafety` — units with min/max (defaults: walk-in 0–5, freezer ≤−15, prep 0–5, hot hold ≥60), cleaning tasks, schedule times, prompt phones, timezone. Editable via `PUT /settings` or the Firebase console. **Rename the units to your actual fridges before go-live** — the audit trail should read like your kitchen.

## Data
- `tenants/{t}/foodSafetyLogs` — every entry: kind (temp/cleaning/delivery), value, pass, byName/byPhone, at, correctiveAction/correctiveBy, photo refs
- `tenants/{t}/trainingRecords` — module, language, score, passed, completedAt

## Test script (10 minutes, from a registered staff number)
1. `temps` → enter readings for each unit; give one deliberately out of range → corrective-action prompt → answer it.
2. Send a photo straight after → "attached to your last log entry".
3. `clean` → `clean 1` → re-text `clean` → first task shows ✅.
4. `delivery test 7.5` → FAIL flow → corrective action.
5. `train 1 ne` → answer the quiz → check the completion appears on `/foodsafety`.
6. Open `/foodsafety` → all of the above visible; export the CSV for today.
7. Confirm `in`/`out`/`wallet`/photo-credential flows still behave — the diary photo hook only fires within 10 min of a diary entry.

## Known limits (deliberate, v1)
- Temp run and quiz state are in-memory (same trade-off as pendingActions) — a redeploy mid-run means restarting it.
- Translations (NE/ZH) are working drafts — have a native speaker review before relying on them for formal induction evidence.
- Traceability (supplier/batch at receiving) is the minimal `delivery` log for now; batch-level capture is a Phase 4 candidate.
- KitchenFounder Pro bundling is a Shopify-side action, not code: create a 100%-off single-use discount per Hospitality Edition venue for the membership product, and record the redemption against the tenant.
