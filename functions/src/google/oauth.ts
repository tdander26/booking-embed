import { google } from 'googleapis';
import { db, COL, GOOGLE_TOKENS_PATH } from '../firebase';
import type { GoogleTokens } from '../types';

// Minimal scope set: read free/busy + create/delete events. The broad
// `calendar` scope is intentionally avoided (harder OAuth verification).
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

export type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

export function makeOAuthClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): OAuthClient {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** One-time consent URL. `state` is validated on the callback. */
export function buildConsentUrl(client: OAuthClient, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline', // returns a refresh_token
    prompt: 'consent', // force consent so a refresh_token is ALWAYS returned
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export async function loadGoogleTokens(): Promise<GoogleTokens | null> {
  const snap = await db
    .collection(GOOGLE_TOKENS_PATH.col)
    .doc(GOOGLE_TOKENS_PATH.doc)
    .get();
  return snap.exists ? (snap.data() as GoogleTokens) : null;
}

export async function saveGoogleTokens(t: GoogleTokens): Promise<void> {
  await db
    .collection(GOOGLE_TOKENS_PATH.col)
    .doc(GOOGLE_TOKENS_PATH.doc)
    .set(t, { merge: true });
}

export async function clearGoogleTokens(): Promise<void> {
  await db.collection(GOOGLE_TOKENS_PATH.col).doc(GOOGLE_TOKENS_PATH.doc).delete();
}

export { COL };
