import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp();
}

export const db = getFirestore();
// Optional fields (invitee.phone/notes, etc.) are left undefined rather than
// written as null; without this the Admin SDK throws on set()/update().
db.settings({ ignoreUndefinedProperties: true });
export const auth = getAuth();

// Collection name constants — single source of truth.
export const COL = {
  branding: 'branding',
  members: 'members',
  eventTypes: 'eventTypes',
  schedules: 'availabilitySchedules',
  bookings: 'bookings',
  slotLocks: 'slotLocks',
  dayCounters: 'dayCounters',
  reminderSends: 'reminderSends',
  private: 'private',
  oauthStates: 'oauthStates',
} as const;

/** Subcollection under members/{memberId} holding server-only Google connections. */
export const CONN_SUB = 'connections' as const;

/** The single branding doc id and the single google-tokens doc id. */
export const BRANDING_DOC = 'public';
export const GOOGLE_TOKENS_PATH = { col: COL.private, doc: 'google' } as const;
