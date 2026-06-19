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

// Per-tenant subcollection name constants — single source of truth.
export const COL = {
  members: 'members',
  eventTypes: 'eventTypes',
  schedules: 'availabilitySchedules',
  bookings: 'bookings',
  slotLocks: 'slotLocks',
  dayCounters: 'dayCounters',
  reminderSends: 'reminderSends',
} as const;

/** Root, platform-level collections (NOT tenant-scoped). */
export const ROOT = {
  tenants: 'tenants',
  oauthStates: 'oauthStates', // short-lived OAuth state; carries tenantId in the doc
  signupCodes: 'signupCodes', // hashed access codes
} as const;

/** Subcollection under members/{memberId} holding server-only Google connections. */
export const CONN_SUB = 'connections' as const;

/** The fallback tenant the live single-practice site is migrated into. Slug-less
 * legacy routes (/api/branding, /?type=…, /admin, /manage) resolve to this. */
export const DEFAULT_TENANT = 'momentum';

/** Reference to a tenant doc (tenants/{tenantId}). Branding fields live here. */
export function tenantRef(tenantId: string) {
  return db.collection(ROOT.tenants).doc(tenantId);
}

/**
 * Bound, tenant-scoped collection handles. Routing ALL data access through this
 * makes omitting the tenant structurally impossible — there is no flat
 * `db.collection(COL.x)` path left for tenant data, so a missing tenant won't
 * even compile. Every data-layer function takes `tenantId` as its first arg.
 */
export function tenantDb(tenantId: string) {
  const root = tenantRef(tenantId);
  return {
    root,
    members: () => root.collection(COL.members),
    eventTypes: () => root.collection(COL.eventTypes),
    schedules: () => root.collection(COL.schedules),
    bookings: () => root.collection(COL.bookings),
    slotLocks: () => root.collection(COL.slotLocks),
    dayCounters: () => root.collection(COL.dayCounters),
    reminderSends: () => root.collection(COL.reminderSends),
  };
}

/** Collection-group query across EVERY tenant's bookings — the reminder sweep.
 * Needs the COLLECTION_GROUP index on (status, reminderDueUtc). */
export function cgBookings() {
  return db.collectionGroup(COL.bookings);
}
