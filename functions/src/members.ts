/**
 * Data layer for providers ("members") and their Google calendar connections.
 * All Firestore access for members lives here so the booking, availability,
 * calendar, and admin layers share one source of truth.
 *
 * Every function is TENANT-SCOPED: the first arg is the tenantId, and all paths
 * are built via tenantDb(tenantId) so cross-tenant access is structurally
 * impossible. Connections (tenants/{tid}/members/{id}/connections/{connId}) hold
 * refresh tokens and are SERVER-ONLY. Never include refreshToken in a
 * client-facing payload — use publicConnection().
 */
import { tenantDb, CONN_SUB } from './firebase';
import { sanitizeForDocId } from './util/ids';
import type { Member, MemberConnection, MemberCalendarRef, PublicProvider } from './types';

const now = () => new Date().toISOString();

// ---------- Members ----------

export async function loadMember(tenantId: string, id: string): Promise<Member | null> {
  const snap = await tenantDb(tenantId).members().doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Member) : null;
}

export async function listMembers(tenantId: string): Promise<Member[]> {
  const q = await tenantDb(tenantId).members().get();
  return q.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Member)
    .sort(byDisplayOrder);
}

export async function listActiveMembers(tenantId: string): Promise<Member[]> {
  return (await listMembers(tenantId)).filter((m) => m.active);
}

export async function loadMemberByEmail(
  tenantId: string,
  email: string,
): Promise<Member | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const q = await tenantDb(tenantId).members().where('email', '==', e).limit(1).get();
  const d = q.docs[0];
  return d ? ({ id: d.id, ...d.data() } as Member) : null;
}

export async function createMember(
  tenantId: string,
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
  await tenantDb(tenantId).members().doc(id).set(doc);
  return doc;
}

export async function updateMember(
  tenantId: string,
  id: string,
  patch: Partial<Member>,
): Promise<Member> {
  const next = { ...patch, updatedAt: now() };
  if (typeof next.email === 'string') next.email = next.email.trim().toLowerCase();
  await tenantDb(tenantId).members().doc(id).set(next, { merge: true });
  const m = await loadMember(tenantId, id);
  if (!m) throw new Error('member vanished after update');
  return m;
}

export async function deleteMember(tenantId: string, id: string): Promise<void> {
  // Delete the member doc + its connections subcollection (tokens).
  const memberRef = tenantDb(tenantId).members().doc(id);
  const conns = await memberRef.collection(CONN_SUB).get();
  const batch = memberRef.firestore.batch();
  conns.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(memberRef);
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

function connCol(tenantId: string, memberId: string) {
  return tenantDb(tenantId).members().doc(memberId).collection(CONN_SUB);
}

export async function loadConnections(
  tenantId: string,
  memberId: string,
): Promise<MemberConnection[]> {
  const q = await connCol(tenantId, memberId).get();
  return q.docs.map((d) => ({ id: d.id, ...d.data() }) as MemberConnection);
}

export async function loadActiveConnections(
  tenantId: string,
  memberId: string,
): Promise<MemberConnection[]> {
  return (await loadConnections(tenantId, memberId)).filter((c) => c.status === 'active');
}

export async function loadConnection(
  tenantId: string,
  memberId: string,
  cid: string,
): Promise<MemberConnection | null> {
  const snap = await connCol(tenantId, memberId).doc(cid).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as MemberConnection) : null;
}

/** Add or refresh a connection; preserves existing `selected` choices by calendarId. */
export async function upsertConnection(
  tenantId: string,
  memberId: string,
  input: {
    accountEmail: string;
    refreshToken: string;
    scope?: string;
    calendars: MemberCalendarRef[];
  },
): Promise<MemberConnection> {
  const cid = connId(input.accountEmail);
  const existing = await loadConnection(tenantId, memberId, cid);
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
  await connCol(tenantId, memberId).doc(cid).set(doc);

  // Default the write target on first-ever connection for this member.
  const member = await loadMember(tenantId, memberId);
  if (member && !member.writeConnectionId) {
    const primary = calendars.find((c) => c.primary && c.writable) ?? calendars.find((c) => c.writable);
    if (primary) {
      await updateMember(tenantId, memberId, {
        writeConnectionId: cid,
        writeCalendarId: primary.calendarId,
      });
    }
  }
  return doc;
}

export async function setConnectionCalendars(
  tenantId: string,
  memberId: string,
  cid: string,
  calendars: MemberCalendarRef[],
): Promise<void> {
  await connCol(tenantId, memberId).doc(cid).set({ calendars, updatedAt: now() }, { merge: true });
}

export async function setConnectionStatus(
  tenantId: string,
  memberId: string,
  cid: string,
  status: 'active' | 'revoked',
): Promise<void> {
  await connCol(tenantId, memberId).doc(cid).set({ status, updatedAt: now() }, { merge: true });
}

export async function deleteConnection(
  tenantId: string,
  memberId: string,
  cid: string,
): Promise<void> {
  await connCol(tenantId, memberId).doc(cid).delete();
  const member = await loadMember(tenantId, memberId);
  if (member?.writeConnectionId === cid) {
    await updateMember(tenantId, memberId, { writeConnectionId: '', writeCalendarId: '' });
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
