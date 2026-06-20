import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION, ALL_SECRETS } from './config';
import { buildApp } from './app';
import { runReminders } from './scheduled/reminders';

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
