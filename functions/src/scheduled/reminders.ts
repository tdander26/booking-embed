import { logger } from 'firebase-functions';
import { cgBookings } from '../firebase';
import { loadBranding } from '../branding';
import { sendBookingReminder } from '../notify';
import type { Booking, Branding } from '../types';
import type { DocumentReference } from 'firebase-admin/firestore';

/**
 * Fires every 15 minutes. Finds confirmed bookings (across ALL tenants, via a
 * collection-group query) whose next reminder instant has passed, sends the due
 * reminder(s), and advances each booking's schedule. Sends are idempotent
 * (durable per-(tenant,booking,kind) guard), so a duplicate tick never
 * double-sends. Each booking carries its `tenantId` so we load the right
 * tenant's branding.
 */
export async function runReminders(nowMs = Date.now()): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const q = await cgBookings()
    .where('status', '==', 'confirmed')
    .where('reminderDueUtc', '<=', nowIso)
    .orderBy('reminderDueUtc', 'asc')
    .limit(200)
    .get();
  if (q.empty) return;

  // Load each tenant's branding once per sweep.
  const brandingByTenant = new Map<string, Branding>();
  const brandingFor = async (tenantId: string): Promise<Branding> => {
    const cached = brandingByTenant.get(tenantId);
    if (cached) return cached;
    const b = await loadBranding(tenantId);
    brandingByTenant.set(tenantId, b);
    return b;
  };

  for (const d of q.docs) {
    const booking = { id: d.id, ...d.data() } as Booking;
    if (!booking.tenantId) {
      // Pre-migration / malformed doc — skip, never crash the whole sweep.
      logger.warn('Reminder skipped: booking missing tenantId', { bookingId: booking.id });
      continue;
    }
    await processBooking(d.ref, booking, await brandingFor(booking.tenantId), nowMs).catch(() =>
      logger.error('Reminder processing failed', { bookingId: booking.id }),
    );
  }
}

async function processBooking(
  ref: DocumentReference,
  booking: Booking,
  branding: Branding,
  nowMs: number,
): Promise<void> {
  const startMs = new Date(booking.startUtc).getTime();

  // Event already started/passed — nothing left to remind about.
  if (startMs <= nowMs) {
    await ref.update({ remindersRemaining: [], reminderDueUtc: null });
    return;
  }

  const remaining = [...(booking.remindersRemaining ?? [])].sort((a, b) => b - a);
  const stillPending: number[] = [];
  for (const minutesBefore of remaining) {
    const dueMs = startMs - minutesBefore * 60_000;
    if (dueMs <= nowMs) {
      await sendBookingReminder(booking.tenantId, booking, branding, minutesBefore);
    } else {
      stillPending.push(minutesBefore);
    }
  }

  const nextDue = stillPending.length
    ? new Date(startMs - Math.max(...stillPending) * 60_000).toISOString()
    : null;
  await ref.update({
    remindersRemaining: stillPending.sort((a, b) => b - a),
    reminderDueUtc: nextDue,
  });
}
