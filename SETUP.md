# Deploy checklist

End-to-end setup for a live deployment. Local dev needs none of this — see the
README "Run it locally" section.

## 0. Prerequisites

```bash
npm run install:all
```

`firebase-tools` is installed locally, so use `npx firebase ...` (or `npm run`
scripts) — no global install needed.

## 1. Create the Firebase project (Blaze plan)

1. Create a project at <https://console.firebase.google.com>.
2. Upgrade it to the **Blaze** (pay-as-you-go) plan. Required for Cloud Functions
   and the reminder cron. You stay at **$0** under the free quotas.
3. Put the project id in **`.firebaserc`** (replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`).
4. In the console: **Build → Authentication → Sign-in method → Google → Enable** (set a support email). Admin sign-in uses Google.
5. **Build → Firestore Database → Create database** (production mode).

## 2. Web config

In the console: **Project settings → General → Your apps → Web app** (create one).
Copy the config values into `web/.env.local`:

```
VITE_FB_API_KEY=...
VITE_FB_AUTH_DOMAIN=yourproj.firebaseapp.com
VITE_FB_PROJECT_ID=yourproj
VITE_FB_APP_ID=...
# leave VITE_USE_EMULATORS unset/empty for production builds
```

## 3. Decide your URL

Either the free Firebase domain (`https://<project>.web.app`) or a custom domain
(**Hosting → Add custom domain**). Call it `APP_BASE_URL`. Set it so emails link
correctly:

```bash
npx firebase functions:config:set   # not used (we use params); instead:
echo "APP_BASE_URL=https://<project>.web.app" >> functions/.env   # see step 6
```

## 4. Google Calendar OAuth

1. <https://console.cloud.google.com> → the SAME project → **APIs & Services**.
2. **Enable APIs**: "Google Calendar API".
3. **OAuth consent screen**: External, add your email as a test user (or publish).
   Scopes needed: `calendar.events` and `calendar.freebusy` (the app requests
   these automatically).
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - **Authorized redirect URI**: `https://<project>.web.app/api/google/callback`
     (use your real base URL). This must match exactly.
5. Note the **Client ID** and **Client secret**.

## 5. Resend (email)

1. Create an account at <https://resend.com>, add and **verify your sending
   domain** (DKIM/SPF DNS records). The free tier is 3,000/mo, 100/day.
2. Create an **API key**.
3. Your `EMAIL_FROM` must be on the verified domain, e.g.
   `Dr. Anderson <bookings@yourdomain.com>`.

## 6. Secrets & params

Secrets (stored in Google Secret Manager):

```bash
npx firebase functions:secrets:set GOOGLE_CLIENT_ID
npx firebase functions:secrets:set GOOGLE_CLIENT_SECRET
npx firebase functions:secrets:set RESEND_API_KEY
# Optional SMS:
npx firebase functions:secrets:set TWILIO_ACCOUNT_SID
npx firebase functions:secrets:set TWILIO_AUTH_TOKEN
```

Plain params — create **`functions/.env`** (or `functions/.env.<projectId>`):

```
APP_BASE_URL=https://<project>.web.app
GOOGLE_REDIRECT_URI=https://<project>.web.app/api/google/callback
EMAIL_FROM=Bookings <bookings@yourdomain.com>
# Optional SMS:
TWILIO_FROM_NUMBER=+15555550123
```

## 7. Deploy

```bash
npm run deploy        # hosting + functions + firestore rules + indexes
```

Or piecemeal: `npm run deploy:rules`, `npm run deploy:functions`, `npm run deploy:hosting`.

## 8. Make yourself an admin

```bash
# Sign in once with Google at https://<project>.web.app/admin,
# then grant the admin claim (needs service-account creds):
GCLOUD_PROJECT=<project> GOOGLE_APPLICATION_CREDENTIALS=service-account.json \
  npm run grant-admin -- doc@drtoddanderson.com
```

Get `service-account.json` from **Project settings → Service accounts → Generate
new private key**. Sign out and back in for the claim to take effect.

## 9. Seed (optional) and connect

- Optionally seed starter data into production:
  `GCLOUD_PROJECT=<project> GOOGLE_APPLICATION_CREDENTIALS=service-account.json node functions/scripts/seed.mjs --prod`
- In **/admin → Settings**, click **Connect Google Calendar** and complete consent.
- Define your **Availability** and **Event types**, set **Branding**.

## 10. Embed on your site

```html
<!-- Inline -->
<div class="booking-inline" data-url="https://<project>.web.app/?type=intro-call"></div>
<script src="https://<project>.web.app/embed.js"></script>

<!-- Floating button -->
<script src="https://<project>.web.app/embed.js"></script>
<script>
  Booking.initPopupButton({ url: "https://<project>.web.app/?type=intro-call", text: "Book a time" });
</script>
```

React to completed bookings on the host page:

```js
document.addEventListener('booking.event_scheduled', (e) => {
  console.log('Booked', e.detail.bookingId, e.detail.startUtc);
});
```

## Hardening (recommended before heavy public traffic)

The booking + cancel endpoints are public and unauthenticated (they must be —
anyone should be able to book). They are guarded by input validation, an
overlap-safe transaction, and a best-effort in-memory rate limit. For a hard
abuse ceiling:

- **Firebase App Check** on the `/api/bookings` and `/api/bookings/:id/cancel`
  routes (reCAPTCHA Enterprise on the web client + `enforceAppCheck` in the
  function). This is the strongest control against scripted spam of calendar
  invites / emails. The in-memory limiter is per-instance and only blunts bursts.
- **`trust proxy` hop count**: `functions/src/app.ts` sets `trust proxy` to `1`
  (one hop: Hosting → Cloud Run). If your topology differs, log the inbound
  `X-Forwarded-For` length once and set the number to match, so `req.ip` (the
  rate-limit key) is the real client IP and not spoofable.
- Optionally front the function with **Cloud Armor** rate rules.

## Enabling SMS reminders (optional, costs money)

1. Get a Twilio account, a number, and complete **A2P 10DLC** registration (US).
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (secrets) and `TWILIO_FROM_NUMBER` (param).
3. SMS goes out for any event type with **Collect phone number** enabled, alongside the email reminder. Budget ~$0.012–0.015 per text.
