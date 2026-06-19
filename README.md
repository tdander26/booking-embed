# booking-embed

A self-hosted, embeddable **Calendly alternative**. Google-Calendar-synced
booking page with a drop-anywhere embed widget, email confirmations + reminders,
and multiple meeting types — running on the Firebase free tier for **~$0/month**.

> Built for general meetings (intro calls, consults). It is **not** wired into
> the Triad EHR and stores no PHI. If you ever point it at patient bookings,
> revisit the HIPAA boundary (Twilio/Resend BAAs, etc.) first.

## What it does

- **Booking page** — pick a meeting type → day → time → details → confirmed. Auto-detects the visitor's timezone (and lets them change it).
- **Google Calendar sync** — reads your real free/busy so it never double-books, and writes confirmed bookings (with an auto-created Google Meet link) straight to your calendar.
- **Embed** — an `<iframe>` snippet, a popup link, or a floating "Book a time" button you drop on any site (`/embed.js`). Auto-resizes; posts a `booking.event_scheduled` event to the host page.
- **Email** confirmations + reminders (Resend free tier). **SMS** reminders are built in but off by default (Twilio, opt-in).
- **Admin** (`/admin`, **Google sign-in**) — connect Google Calendar, define meeting types, set weekly availability, view/cancel bookings, set branding.
- **Multiple event types**, per-type duration, buffers, minimum notice, booking window, daily caps, and reminders.

**Design.** A premium dark theme out of the box — near-black surfaces, gold accents, Playfair Display headings + Inter body (self-hosted). The accent color is themeable per practice via Branding; the default is the Momentum gold (`#C9A84C`).

## Architecture

```
web/         Vite + React + TS + Tailwind
  booking/   public booking flow
  admin/     owner admin (code-split; Firebase only loads here)
  manage/    invitee reschedule/cancel page
  public/embed.js   the host-site embed loader
functions/   Firebase Cloud Functions (TypeScript)
  http/      one Express app behind the Hosting rewrite /api/** -> api
  scheduling/  DST-safe slot math + overlap-safe booking transaction
  calendar/  Google provider + mock provider (used in the emulator)
  email/ sms/ notify  Resend + Twilio, with a durable send-once guard
  scheduled/ reminders cron (onSchedule, every 15 min)
firestore.rules        public flow reads nothing sensitive; writes go through functions
```

**Why it's cheap & correct**

- One HTTP function behind a Hosting rewrite → the booking page and embed are **same-origin**, so no CORS and a single function to deploy.
- Times are stored as **UTC instants**; slot generation steps by exact minutes from a zone-anchored window (DST-safe). See [functions/src/scheduling/slots.ts](functions/src/scheduling/slots.ts).
- **No double-booking, ever:** each booking locks every fixed grid cell it covers inside a Firestore transaction, so even overlapping different-start slots collide. See [functions/src/scheduling/booking.ts](functions/src/scheduling/booking.ts).
- Reminders/confirmations use a **durable per-(booking, kind) send-once record** on top of Resend's idempotency key.
- `minInstances: 0`, free Firestore/Hosting tiers → idle cost is **$0** (the only paid requirement is the Blaze plan, which the reminder cron needs; Blaze still bills $0 under the free quotas).

## Run it locally in 60 seconds (no Google/Resend/Firebase account needed)

```bash
npm run install:all          # installs root + functions + web

# terminal 1 — emulators + seed data
npm run emulators            # Firestore + Auth + Functions + Hosting emulators
npm run seed                 # branding, a schedule, and 2 event types

# terminal 2 — the web app
cp web/.env.local.example web/.env.local   # defaults are fine for the emulator
npm run dev:web
```

Then open:

- **Booking page** → http://localhost:5173/
- **A single type** → http://localhost:5173/?type=intro-call
- **Embed demo** → http://localhost:5173/embed-demo.html
- **Admin** → http://localhost:5173/admin (Continue with Google; the Auth emulator lets you add a test account, and any signed-in user is treated as admin locally)

In the emulator a **mock calendar** is used (no real Google calls) and emails are
logged to the Functions emulator instead of sent — so the whole flow works offline.

## Deploy for real

See **[SETUP.md](SETUP.md)** for the full checklist: create a Firebase project,
set secrets, connect Google OAuth, verify a Resend domain, deploy, and grant
yourself the admin claim.

```bash
npm run deploy          # build + deploy hosting, functions, rules, indexes
```

## Cost summary

| Piece | Free tier | Typical solo cost |
| --- | --- | --- |
| Hosting + Firestore + Functions | generous | **$0** |
| Cloud Scheduler (reminder cron) | 3 free jobs | **$0** |
| Resend email | 3,000/mo, 100/day | **$0** |
| Twilio SMS (optional) | — | ~$0.012–0.015/text, only if enabled |
| Domain (optional) | — | ~$12/yr |
