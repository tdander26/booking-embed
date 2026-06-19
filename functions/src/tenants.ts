/**
 * Data layer for tenants (practices). The tenant doc id IS the URL slug and
 * holds both practice meta (owner, status) and the public branding fields.
 * All tenant-scoped data lives under `tenants/{slug}/…` (see firebase.tenantDb).
 */
import { db, ROOT, tenantRef } from './firebase';
import { notFound } from './util/http';
import type { Tenant } from './types';

const now = () => new Date().toISOString();

export async function loadTenant(id: string): Promise<Tenant | null> {
  const snap = await tenantRef(id).get();
  return snap.exists ? ({ slug: snap.id, ...snap.data() } as Tenant) : null;
}

/** A tenant that exists AND is active (suspended/missing => false). */
export async function tenantActive(id: string): Promise<Tenant | null> {
  const t = await loadTenant(id);
  return t && t.status === 'active' ? t : null;
}

/** Resolve the owning member id (used as the per-tenant "owner" fallback for
 * provider-less legacy event types). Throws if the tenant is unknown. */
export async function ownerMemberId(tenantId: string): Promise<string> {
  const t = await loadTenant(tenantId);
  if (!t) throw notFound('Unknown practice', 'no_tenant');
  return t.ownerMemberId;
}

export async function listTenants(): Promise<Tenant[]> {
  const q = await db.collection(ROOT.tenants).get();
  return q.docs
    .map((d) => ({ slug: d.id, ...d.data() }) as Tenant)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function createTenant(
  id: string,
  data: Omit<Tenant, 'slug' | 'createdAt' | 'updatedAt'>,
): Promise<Tenant> {
  const doc: Tenant = { ...data, slug: id, createdAt: now(), updatedAt: now() };
  await tenantRef(id).set(doc);
  return doc;
}

export async function updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant> {
  await tenantRef(id).set({ ...patch, updatedAt: now() }, { merge: true });
  const t = await loadTenant(id);
  if (!t) throw notFound('Unknown practice', 'no_tenant');
  return t;
}
