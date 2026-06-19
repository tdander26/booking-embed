/**
 * Runtime configuration: secrets (Google Secret Manager) + plain params, plus
 * a few constants. Secrets are read with `.value()` ONLY inside handlers at
 * runtime — never at module load / deploy time — and must be listed in each
 * function's `secrets: [...]` binding (see index.ts).
 */
import { defineSecret, defineString } from 'firebase-functions/params';

export const REGION = 'us-central1';

// Time grid used for atomic overlap locking. Any two overlapping bookings are
// guaranteed to share at least one grid cell, so creating a lock doc per covered
// cell inside a transaction makes double-booking (even of overlapping, different-
// start slots) impossible. Keep small enough to divide common durations.
export const BASE_GRID_MINUTES = 5;

// Google OAuth (owner connects their own calendar once).
export const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
// Must EXACTLY match an authorized redirect URI in the Google Cloud console,
// e.g. https://your-app.web.app/api/google/callback
export const GOOGLE_REDIRECT_URI = defineString('GOOGLE_REDIRECT_URI', {
  default: '',
});

// Public base URL of the deployed app, used to build links in emails and the
// OAuth redirect. Falls back to the request origin when empty.
export const APP_BASE_URL = defineString('APP_BASE_URL', { default: '' });

// Bootstrap owner (legacy single-tenant). Still read as a fallback for the
// PLATFORM super-admin so existing deployments keep working without a new env.
export const OWNER_EMAIL = defineString('OWNER_EMAIL', { default: '' });

// Platform super-admin: this verified email can administer ANY tenant and mint
// signup codes. Falls back to OWNER_EMAIL when unset.
export const PLATFORM_OWNER_EMAIL = defineString('PLATFORM_OWNER_EMAIL', { default: '' });

// Shared signup access code (first-deploy fallback before minted codes exist).
// Self-serve onboarding accepts this value OR a matching hashed `signupCodes` doc.
export const SIGNUP_ACCESS_CODE = defineString('SIGNUP_ACCESS_CODE', { default: '' });

// Transactional email (Resend).
export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
export const EMAIL_FROM = defineString('EMAIL_FROM', {
  default: 'Bookings <onboarding@resend.dev>',
});

// Optional SMS (Twilio). Left unset => SMS reminders are silently skipped.
export const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
export const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
export const TWILIO_FROM_NUMBER = defineString('TWILIO_FROM_NUMBER', {
  default: '',
});

// All secrets a function may need bound to it.
export const ALL_SECRETS = [
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  RESEND_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
];

/** True inside the Firebase emulator — used to swap in mock Calendar/email. */
export const isEmulator = (): boolean =>
  process.env.FUNCTIONS_EMULATOR === 'true';
