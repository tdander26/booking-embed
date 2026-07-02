/**
 * Branding read/write. Branding fields are folded into the tenant doc
 * (`tenants/{tenantId}`), which is exactly the public-readable surface, so there
 * is no separate branding singleton anymore.
 */
import { tenantRef } from './firebase';
import type { Branding, ThemeMode } from './types';

/** Built-in fallback reminder schedule (minutes before): 24 hours + 1 hour.
 * Used when neither the event type nor the practice sets one. */
export const DEFAULT_REMINDERS_MINUTES = [1440, 60];

export const DEFAULT_BRANDING: Branding = {
  displayName: 'Booking',
  tagline: 'Book a time that works for you',
  brandColor: '#C9A84C',
  welcomeText: '',
  timezone: 'America/Chicago',
  updatedAt: new Date(0).toISOString(),
};

/** Branding-relevant fields on the tenant doc (everything else stays private). */
function projectBranding(d: Record<string, unknown>): Branding {
  return {
    displayName: (d.displayName as string) ?? DEFAULT_BRANDING.displayName,
    tagline: (d.tagline as string) ?? DEFAULT_BRANDING.tagline,
    avatarUrl: d.avatarUrl as string | undefined,
    brandColor: (d.brandColor as string) ?? DEFAULT_BRANDING.brandColor,
    welcomeText: (d.welcomeText as string) ?? DEFAULT_BRANDING.welcomeText,
    timezone: (d.timezone as string) ?? DEFAULT_BRANDING.timezone,
    emailFrom: d.emailFrom as string | undefined,
    adsConversionId: d.adsConversionId as string | undefined,
    adsConversionLabel: d.adsConversionLabel as string | undefined,
    theme: ((d.theme as ThemeMode) ?? 'dark') as ThemeMode,
    defaultRemindersMinutesBefore: d.defaultRemindersMinutesBefore as number[] | undefined,
    updatedAt: (d.updatedAt as string) ?? DEFAULT_BRANDING.updatedAt,
  };
}

export async function loadBranding(tenantId: string): Promise<Branding> {
  const snap = await tenantRef(tenantId).get();
  if (!snap.exists) return DEFAULT_BRANDING;
  return projectBranding(snap.data() as Record<string, unknown>);
}

export async function saveBranding(
  tenantId: string,
  patch: Partial<Branding>,
): Promise<Branding> {
  await tenantRef(tenantId).set(
    { ...patch, updatedAt: new Date().toISOString() },
    { merge: true },
  );
  return loadBranding(tenantId);
}
