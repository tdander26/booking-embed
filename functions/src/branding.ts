import { db, COL, BRANDING_DOC } from './firebase';
import type { Branding } from './types';

export const DEFAULT_BRANDING: Branding = {
  displayName: 'Dr. Todd Anderson',
  tagline: 'Book a time that works for you',
  brandColor: '#C9A84C',
  welcomeText: '',
  timezone: 'America/Chicago',
  updatedAt: new Date(0).toISOString(),
};

export async function loadBranding(): Promise<Branding> {
  const snap = await db.collection(COL.branding).doc(BRANDING_DOC).get();
  if (!snap.exists) return DEFAULT_BRANDING;
  return { ...DEFAULT_BRANDING, ...(snap.data() as Partial<Branding>) };
}

export async function saveBranding(patch: Partial<Branding>): Promise<Branding> {
  await db
    .collection(COL.branding)
    .doc(BRANDING_DOC)
    .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  return loadBranding();
}
