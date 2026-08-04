# HospitalityOS — Webhook Skeleton (Build Step 1)

WhatsApp-first operations platform for F&B. This is **step 1 of the build order**
in `docs/backend-build-scope.md`: prove the pipe —
WhatsApp message → Meta Cloud API → this webhook → sender lookup → reply.

No business logic lives here yet. Clock-in (step 2), the manager dashboard
(step 3), and vision-based stock/P&L flows (steps 4–5) each arrive as separate
handler modules. Frontend unified, backend modular — see
`docs/hospitality-app-decisions-log.md`.

**This project is designed to run 100% in the browser — no installs on your
PC.** GitHub hosts the code, Railway runs it, Meta connects to it. Your
computer only needs a web browser.

## What you need (all free to create, browser-only)

- A GitHub account — github.com
- A Railway account — railway.app (sign in with GitHub; hosting ≈ $5/month)
- A Meta developer app with the WhatsApp product added —
  developers.facebook.com → Create App → type **Business** → add **WhatsApp**

## Step 1 — Put the code on GitHub (browser upload)

1. github.com → **New repository** → name it `hospitality-os` → Create
2. On the empty repo page, click **"uploading an existing file"**
3. Unzip the project on your PC (right-click → Extract; built into
   Windows/Mac, nothing to install) and drag **all files and folders** into
   the upload box
4. Click **Commit changes**

## Step 2 — Deploy on Railway

1. railway.app → **New Project** → **Deploy from GitHub repo** →
   select `hospitality-os`
2. Railway auto-detects Node, installs dependencies, and starts the server —
   on Railway's machines, not yours
3. Go to **Settings → Networking → Generate Domain** — you get a permanent
   public URL like `https://hospitality-os-production.up.railway.app`

## Step 3 — Set the secrets (Railway → Variables tab)

Add these five (a simple web form — you never create a `.env` file):

| Variable | Where it comes from |
|---|---|
| `WHATSAPP_TOKEN` | Meta dashboard → WhatsApp → API Setup |
| `WHATSAPP_PHONE_NUMBER_ID` | Same page, just below the token |
| `WHATSAPP_VERIFY_TOKEN` | Any password-like string **you invent** — you'll type the same value into Meta in Step 4 |
| `META_APP_SECRET` | Meta dashboard → App Settings → Basic → App Secret |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | See "Set up Firebase" below. Leave blank to run on in-memory data for early testing. |

Railway redeploys automatically after you save variables.

## Set up Firebase (browser-only, needed from build step 2 onward)

1. console.firebase.google.com → **Add project** → name it (e.g. `hospitality-os`)
2. Left sidebar → **Build → Firestore Database** → Create database → start in
   **production mode** (we control access with security rules, not test mode)
3. Gear icon (top left) → **Project settings → Service accounts** →
   **Generate new private key** — downloads a `.json` file
4. Open that file in any text editor, copy the **entire contents**, and paste
   it as the value of `FIREBASE_SERVICE_ACCOUNT_JSON` in Railway. Railway's
   variable box accepts multi-line/JSON values fine.
5. Add your building as a **site** from the dashboard — **Sites → + Add site**.
   Right-click the spot on Google Maps and the coordinates are the first thing
   in the menu; paste them into Latitude and Longitude and leave the radius at
   75m. The clock-in geofence comes from the site, so nothing works until at
   least one exists. (Sites live in Firestore, so no code edit and no redeploy.)

The first time a clock-out happens, Firestore may reply with an error
containing a link to create a composite index (needed for the
"find my open shift" query) — click the link, it builds the index for you,
no config needed beyond that one click.

## Step 4 — Connect Meta to your Railway URL

1. Meta App dashboard → WhatsApp → **Configuration**
2. Callback URL: `https://<your-railway-domain>/webhook/whatsapp`
3. Verify token: the exact value you invented for `WHATSAPP_VERIFY_TOKEN`
4. Click **Verify and save** — Railway's deploy logs should show
   `verification handshake OK`
5. Under **Webhook fields**, subscribe to **messages**

## Step 5 — Register your own phone number

The skeleton only replies fully to numbers it recognises. Edit the seed
record — in the browser:

1. In your GitHub repo, open `src/store.js`
2. Click the **pencil icon** (Edit this file)
3. Replace `61400000000` with your own number — international format,
   country code, **no +** (e.g. an Australian 0412 345 678 becomes
   `61412345678`)
4. **Commit changes** — Railway redeploys in about a minute

That edit-on-GitHub → auto-redeploy loop is your entire dev workflow from
now on. No terminal, ever.

## Step 6 — Test the pipe

Send a WhatsApp message from your phone to the test number shown on
Meta's **API Setup** page. Try the full clock in/out flow:

1. Text **"in"** → the bot replies with a one-tap **share location** button
2. Tap it → if you're within range of the site you're rostered to, you get
   **"Clocked in at [site], [name] — have a good shift!"**
3. Text **"out"** → share location again → **"Clocked out — that was a
   0.0hr shift"** (0.0hr is correct if you test in/out within the same
   minute — real shifts will show real hours)

Message from an unregistered number and you get the polite
"not registered" reply. Share a location from far outside the site's
radius and you'll get the "flagged for your manager to review" reply
instead of a hard block — that's the deliberate no-accuracy-data design
from the decisions log working as intended.

With more than one site, the site is taken from your **rostered shift** for
that day, so put yourself on the Service Board first. If you're not rostered
anywhere the bot says so rather than guessing a building — an unresolved site
is refused, not flagged. With exactly one site it's used automatically and the
roster doesn't come into it.

## What's next (build order)

| Step | What | Status |
|---|---|---|
| 1 | Webhook skeleton | ✅ |
| 2 | Clock in/out — GPS geofence, Firestore `shifts`, manager-review flagging | ✅ this repo |
| 3 | Manager dashboard (read-only: who's on shift, review flagged clock-ins) | next |
| 4 | Stock from invoice photo — Claude vision, confirm flow | |
| 5 | Daily P&L — fixed-cost setup + till photo | |
| 6 | Alerts — no-show, labour % (needs Meta template approval — start early!) | |
| 7 | Recipe lookup | |

### Agency model

`docs/agencymodelshape.md` sets out a second build order, for running this as a
labour-hire agency supplying casual staff to many hotels.

| Step | What | Status |
|---|---|---|
| 1 | Sites and a shift-level geofence | ✅ |
| 2 | Requests, offers and the blast engine | ✅ |
| 3 | Weekly availability and the free-today pool | next |
| 4 | Client intake over chat | |
| 5 | Compliance gate and hours cap | |
| 6 | Timesheet sign-off, bill rates, margin | |
| 7 | Reporting | |

**Step 1** put one geofence per building in a `sites` collection, so a clock-in
is checked against the site on that person's rostered shift instead of one
radius per tenant. Add sites from the dashboard's **Sites** section.

**Step 2** added staffing requests and the dispatch engine. Raise a request from
**Staffing Requests → + Raise request** and the blast starts immediately:

- **The lane is derived from the start time, never declared.** Under twelve
  hours out is urgent (10-minute waves), further out is planned (2-hour waves).
  Nobody picks a priority — the API refuses to accept one.
- Staff answer over WhatsApp with **"yes"** / **"no"**, or **"yes H7K2"** when
  they have more than one offer open. First come, first served, and the claim is
  atomic, so two people answering together can never take the same seat.
- Accepting books the person onto the Service Board at the request's site, which
  is what makes their clock-in resolve the right building.
- **Auto-backfill:** no clock-in fifteen minutes after a rostered start fires
  the urgent blast on its own. The supervisor notices the gap at 7:15; the
  replacement was accepted at 7:04.

The engine is a tick loop, not a set of timers: all dispatch state lives on the
request documents, so a redeploy mid-blast resumes instead of abandoning a
half-filled request. Set `DISPATCH_DISABLED=1` to run an instance without it —
needed if you ever point a second instance at the same Firestore project, so two
loops don't both blast the same request.

Two things step 2 deliberately does **not** do yet, because they are later
steps: waves 1 of both lanes (declared availability, the free-today pool) have
no data source until step 3 and are skipped, so a blast currently starts at
"everyone not already booked, ranked by reliability"; and no compliance gate is
applied until step 5.

## Security notes (do not skip)

- Secrets live **only** in Railway's Variables tab — never in the code, never
  committed to GitHub. `.gitignore` blocks `.env` files as a safety net.
- Every webhook POST is signature-verified against `META_APP_SECRET`
  (`src/verifySignature.js`). Never disable this, including in testing.
- When Firestore arrives (step 2): every document carries `tenantId`, and
  security rules must enforce it — see "Data safety & role-based access
  control" in the decisions log. The bot backend additionally passes every
  outgoing reply through a role-visibility check before sending; financial
  fields never reach staff-role numbers.

## Running locally instead (optional, developers only)

If you ever do work from a machine with Node 18+ installed:
`npm install`, copy `.env.example` to `.env` and fill it, then
`node --env-file=.env src/server.js` and tunnel with ngrok. The browser-only
path above is the recommended one.

`npm test` runs the suite (node's built-in test runner — no dependencies, so it
works on a fresh clone before `npm install`). It covers site resolution, the
clock in/out geofence path, and the dispatch engine — lane derivation, wave
progression, the first-come race, expiry, and backfill deduping — against the
in-memory stores. Time is injected rather than slept on, so the whole suite runs
in under a second.
