# Core OS — Phase 2: Credential Wallet over WhatsApp
Added 22 Aug 2026. Workers file their own credentials by photographing them into WhatsApp; the system reads the card, confirms, stores it, reminds them before expiry, and feeds the roster guard from Phase 1.

## The worker flow (zero training needed)
1. Worker sends a photo of their RSA/visa/White Card to the venue WhatsApp.
2. Bot reads it (Claude vision) → "Looks like an RSA / RCG expiring 15 Mar 2027. Reply YES to save, or correct me like: rsa 15/03/2027".
3. Worker replies `yes` (or a correction) → saved to their wallet.
4. `wallet` command lists everything they hold with 🟢🟠🔴 status.
5. Automatic WhatsApp reminders at 60 / 30 / 7 days and on expiry — each sent once, markers stored on the credential so redeploys never re-spam.

## Manager side
- On `/roster`, tap any worker's name → their wallet: every credential, expiry status, whether it was filed by the worker on WhatsApp or added on the dashboard, plus a manual add form.
- Expired blocking credentials (visa, RSA, White Card, NDIS) already trip the Phase 1 roster guard.

## New files / touched files
- `credentialTypes.js` — shared registry (types, blocking flags, chat aliases)
- `walletHandler.js` — photo intake, AI extraction, confirm flow, `wallet` command
- `walletNudges.js` — 6-hourly expiry nudge loop (dispatcher pattern; `WALLET_NUDGES_DISABLED=1` to switch off)
- `whatsapp.js` — added `fetchMediaBinary` (Meta media download)
- `router.js` — `wallet` command + draft replies (placed so they can never shadow clock/offer/availability words: the reply hook returns false when no draft is pending), image messages now route to the wallet
- `core-os-routes.js` — credentials join workers by **phone** as well as id (WhatsApp staff are phone-keyed); wallet GET merges both; dashboard-added credentials enriched for nudges
- `public/roster.html` — wallet modal

## Railway env vars (Variables tab)
| Var | Needed for | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Reading cards from photos (model: claude-haiku-4-5) | Bot asks the worker to type type + expiry — still works |
| `FIREBASE_STORAGE_BUCKET` | Keeping the card photo (e.g. `hospitality-os-b9eab.appspot.com` — check the exact bucket name in Firebase console → Storage) | Only the WhatsApp media ID is kept (Meta holds media ~30 days) |
| `WALLET_NUDGES_DISABLED` | Set `1` on any second/debug instance | — |

## Test script (5 minutes, from your own phone as a registered staff number)
1. Text `wallet` → empty-wallet message.
2. Send a photo of any card with an expiry date → confirm flow → `yes`.
3. Text `wallet` → card listed with 🟢 status.
4. Add one manually from `/roster` (tap your name) with expiry ~20 days out → within 6 h (or on next redeploy) the 30-day nudge arrives on WhatsApp.
5. Check `in` / `out` / `roster` / availability words still behave exactly as before — the wallet hook only consumes messages while a photo draft is pending (10-min window).

## Known limits (deliberate, v1)
- Draft confirmations are in-memory (same trade-off as pendingActions) — redeploy mid-confirmation just means resending the photo.
- AI extraction accepts only high-confidence reads; anything else falls back to asking. Managers can see `source: whatsapp` vs `dashboard` on every credential — treat worker-filed entries as unverified until sighted.
- No document images are shown on the dashboard yet (Phase 3, with Storage viewing links).
