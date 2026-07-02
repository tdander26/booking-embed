import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION, ALL_SECRETS, RESEND_API_KEY } from './config';
import { buildApp } from './app';
import { runReminders } from './scheduled/reminders';
import { handleLabOrder } from './http/labOrders';
import { handleLabOrderAdmin } from './http/labOrdersAdmin';

// Secret-rebind marker: bump to force a redeploy after rotating a secret
// (e.g. RESEND_API_KEY), since Firebase skips deploys when only secret versions
// change. rev: 1

// Single HTTP function behind the Firebase Hosting rewrite `/api/** -> api`.
// Same-origin for both the booking page and the embedded iframe, so the public
// flow needs no CORS; Express still reflects CORS for any direct cross-origin
// callers.
export const api = onRequest(
  {
    region: REGION,
    secrets: ALL_SECRETS,
    memory: '256MiB',
    // minInstances stays at 0 (default) so idle cost is $0.
  },
  buildApp(),
);

// Reminder sweep. Requires the Blaze plan (provisions a Cloud Scheduler job).
export const reminders = onSchedule(
  {
    region: REGION,
    schedule: 'every 15 minutes',
    timeZone: 'Etc/UTC',
    secrets: ALL_SECRETS,
    memory: '256MiB',
  },
  async () => {
    await runReminders();
  },
);

// Standalone lab-order intake for the momentumhealthwellnessmn.com new-patient
// wizard. Deliberately SEPARATE from `api` (the booking app) so deploying it
// (`firebase deploy --only functions:labOrder`) never touches the live booking
// function. cors:true reflects the caller origin + handles preflight, so the
// static site (GitHub Pages / Vercel preview) can POST cross-origin.
export const labOrder = onRequest(
  {
    region: REGION,
    memory: '256MiB',
    cors: true,
    // Called directly (cross-origin) from the static website, so it must allow
    // unauthenticated invocation. Security is at the data layer: Firestore rules
    // deny all client reads, and the handler validates every field server-side.
    invoker: 'public',
    // Resend key powers the PHI-free "new lab order" email + free carrier text.
    secrets: [RESEND_API_KEY],
  },
  handleLabOrder,
);

// Authenticated admin viewer for lab orders (Google sign-in, email allowlist).
// Standalone — never touches the booking app. Returns PHI only to a verified
// allowlisted admin; Firestore still denies all direct client reads.
export const labOrderAdmin = onRequest(
  {
    region: REGION,
    memory: '256MiB',
    cors: true,
    invoker: 'public', // reachable by the browser; auth is enforced in-handler via ID token
  },
  handleLabOrderAdmin,
);
