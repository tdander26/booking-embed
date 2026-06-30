/**
 * Platform-wide email-send meter. Every actually-sent email (across all tenants)
 * is tallied here so the platform owner can watch volume against Resend's free
 * tier — 100 emails/day and 3,000/month — which is the binding cost constraint.
 *
 * One doc per UTC month at emailUsage/{YYYY-MM}. Resend's caps reset on the UTC
 * day, so the day buckets are keyed by UTC date to line up with the quota. The
 * meter is best-effort: a failed tally never blocks (or fails) the email send.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { db, ROOT } from '../firebase';

export type EmailKind = 'confirmation' | 'reminder' | 'cancellation' | 'other';

/** Classify a send from its idempotency key prefix (see notify.ts). */
export function classifyKind(idempotencyKey?: string): EmailKind {
  const prefix = (idempotencyKey ?? '').split('/')[0];
  if (prefix === 'reminder') return 'reminder';
  if (prefix === 'confirm' || prefix === 'confirm-provider') return 'confirmation';
  if (prefix === 'cancel' || prefix === 'cancel-provider') return 'cancellation';
  return 'other';
}

/** UTC 'YYYY-MM' (month doc id) and 'YYYY-MM-DD' (day bucket). */
function utcKeys(now: Date): { month: string; day: string } {
  const iso = now.toISOString();
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

/**
 * Tally one actually-sent email. Atomic increments via set+merge create the
 * month doc and any nested buckets on first write. Never throws.
 */
export async function recordEmailSend(
  opts: { tenantId?: string; kind: EmailKind },
  now: Date = new Date(),
): Promise<void> {
  try {
    const { month, day } = utcKeys(now);
    const inc = FieldValue.increment(1);
    const patch: Record<string, unknown> = {
      month,
      total: inc,
      byType: { [opts.kind]: inc },
      byDay: { [day]: inc },
      updatedAt: now.toISOString(),
    };
    if (opts.tenantId) patch.byTenant = { [opts.tenantId]: inc };
    await db.collection(ROOT.emailUsage).doc(month).set(patch, { merge: true });
  } catch (err) {
    logger.warn('email usage meter failed', { error: (err as Error).message });
  }
}

export interface EmailUsage {
  month: string; // UTC 'YYYY-MM'
  day: string; // UTC 'YYYY-MM-DD' (today)
  total: number; // this month
  today: number; // this UTC day
  byType: Record<string, number>;
  byDay: Record<string, number>;
  byTenant: Record<string, number>;
  /** Resend free-tier reference points (so the UI needn't hardcode them). */
  limits: { perDay: number; perMonth: number };
}

const RESEND_FREE = { perDay: 100, perMonth: 3000 };

/** Read the current UTC month's tally for the platform dashboard. */
export async function loadEmailUsage(now: Date = new Date()): Promise<EmailUsage> {
  const { month, day } = utcKeys(now);
  const snap = await db.collection(ROOT.emailUsage).doc(month).get();
  const d = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
  const byDay = (d.byDay as Record<string, number>) ?? {};
  return {
    month,
    day,
    total: (d.total as number) ?? 0,
    today: byDay[day] ?? 0,
    byType: (d.byType as Record<string, number>) ?? {},
    byDay,
    byTenant: (d.byTenant as Record<string, number>) ?? {},
    limits: RESEND_FREE,
  };
}
