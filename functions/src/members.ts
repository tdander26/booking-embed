/**
 * Data layer for providers ("members") and their Google calendar connections.
 * All Firestore access for members lives here so the booking, availability,
 * calendar, and admin layers share one source of truth.
 *
 * Connections (members/{id}/connections/{connId}) hold refresh tokens and are
 * SERVER-ONLY (Firestore rules deny all client access; the Admin SDK bypasses).
 * Never include refreshToken in any client-facing payload — use publicConnection().
 */
import { db, COL, CONN_SUB } from './firebase';
import { sanitizeForDocId } from './util/ids';
import type { Member, MemberConnection, MemberCalendarRef, PublicProvider } from './types';

const now = () => new Date().toISOString();

// ---------- Members ----------

export async function loadMember(id: string): Promise<Member | null> {
  const snap = await db.collection(COL.members).doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Member) : null;
}

export async function listMembers(): Promise<Member[]> {
  const q = await db.collection(COL.members).get();
  return q.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Member)
    .sort(byDisplayOrder);
}

export async function listActiveMembers(): Promise<Member[]> {
  return (await listMembers()).filter((m) => m.active);
}

export async function loadMemberByEmail(email: string): Promise<Member | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const q = await db.collection(COL.members).where('email', '==', e).limit(1).get();
  const d = q.docs[0];
  return d ? ({ id: d.id, ...d.data() } as Member) : null;
}

export async function createMember(
  id: string,
  data: Omit<Member, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Member> {
  const doc: Member = {
    ...data,
    email: data.email.trim().toLowerCase(),
    id,
    createdAt: now(),
    updatedAt: now(),
  };
  await db.collection(COL.members).doc(id).set(doc);
  return doc;
}

export async function updateMember(id: string, patch: Partial<Member>): Promise<Member> {
  const next = { ...patch, updatedAt: now() };
  if (typeof next.email === 'string') next.email = next.email.trim().toLowerCase();
  await db.collection(COL.members).doc(id).set(next, { merge: true });
  const m = await loadMember(id);
  if (!m) throw new Error('member vanished after update');
  return m;
}

export async function deleteMember(id: string): Promise<void> {
  // Delete the member doc + its connections subcollection (tokens).
  const conns = await db.collection(COL.members).doc(id).collection(CONN_SUB).get();
  const batch = db.batch();
  conns.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection(COL.members).doc(id));
  await batch.commit();
}

/** featured first, then sortOrder asc, then name. */
export function byDisplayOrder(a: Member, b: Member): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  return a.name.localeCompare(b.name);
}

export function publicProvider(m: Member): PublicProvider {
  return {
    id: m.id,
    name: m.name,
    title: m.title,
    avatarUrl: m.avatarUrl,
    bio: m.bio,
    featured: m.featured,
    sortOrder: m.sortOrder,
  };
}

// ---------- Connections (server-only) ----------

export const connId = (accountEmail: string) => sanitizeForDocId(accountEmail.toLowerCase());

export async function loadConnections(memberId: string): Promise<MemberConnection[]> {
  const q = await db.collection(COL.members).doc(memberId).collection(CONN_SUB).get();
  return q.docs.map((d) => ({ id: d.id, ...d.data() }) as MemberConnection);
}

export async function loadActiveConnections(memberId: string): Promise<MemberConnection[]> {
  return (await loadConnections(memberId)).filter((c) => c.status === 'active');
}

export async function loadConnection(
  memberId: string,
  cid: string,
): Promise<MemberConnection | null> {
  const snap = await db
    .collection(COL.members)
    .doc(memberId)
    .collection(CONN_SUB)
    .doc(cid)
    .get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as MemberConnection) : null;
}

/** Add or refresh a connection; preserves existing `selected` choices by calendarId. */
export async function upsertConnection(
  memberId: string,
  input: {
    accountEmail: string;
    refreshToken: string;
    scope?: string;
    calendars: MemberCalendarRef[];
  },
): Promise<MemberConnection> {
  const cid = connId(input.accountEmail);
  const existing = await loadConnection(memberId, cid);
  const priorSelected = new Map(
    (existing?.calendars ?? []).map((c) => [c.calendarId, c.selected]),
  );
  const calendars = input.calendars.map((c) => ({
    ...c,
    selected: priorSelected.has(c.calendarId) ? !!priorSelected.get(c.calendarId) : c.selected,
  }));
  const doc: MemberConnection = {
    id: cid,
    accountEmail: input.accountEmail.trim().toLowerCase(),
    refreshToken: input.refreshToken,
    scope: input.scope,
    status: 'active',
    calendars,
    lastSyncedAt: now(),
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  };
  await db.collection(COL.members).doc(memberId).collection(CONN_SUB).doc(cid).set(doc);

  // Default the write target on first-ever connection for this member.
  const member = await loadMember(memberId);
  if (member && !member.writeConnectionId) {
    const primary = calendars.find((c) => c.primary && c.writable) ?? calendars.find((c) => c.writable);
    if (primary) {
      await updateMember(memberId, { writeConnectionId: cid, writeCalendarId: primary.calendarId });
    }
  }
  return doc;
}

export async function setConnectionCalendars(
  memberId: string,
  cid: string,
  calendars: MemberCalendarRef[],
): Promise<void> {
  await db
    .collection(COL.members)
    .doc(memberId)
    .collection(CONN_SUB)
    .doc(cid)
    .set({ calendars, updatedAt: now() }, { merge: true });
}

export async function setConnectionStatus(
  memberId: string,
  cid: string,
  status: 'active' | 'revoked',
): Promise<void> {
  await db
    .collection(COL.members)
    .doc(memberId)
    .collection(CONN_SUB)
    .doc(cid)
    .set({ status, updatedAt: now() }, { merge: true });
}

export async function deleteConnection(memberId: string, cid: string): Promise<void> {
  await db.collection(COL.members).doc(memberId).collection(CONN_SUB).doc(cid).delete();
  const member = await loadMember(memberId);
  if (member?.writeConnectionId === cid) {
    await updateMember(memberId, { writeConnectionId: '', writeCalendarId: '' });
  }
}

/** Client-safe projection of a connection (NO refresh token). */
export function publicConnection(c: MemberConnection, member: Member | null) {
  return {
    id: c.id,
    accountEmail: c.accountEmail,
    status: c.status,
    lastSyncedAt: c.lastSyncedAt,
    createdAt: c.createdAt,
    calendars: c.calendars,
    isWriteConnection: member?.writeConnectionId === c.id,
  };
}
