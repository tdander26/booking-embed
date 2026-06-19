import { logger } from 'firebase-functions';
import { db, COL } from '../firebase';
import { loadBranding } from '../branding';
import { sendBookingReminder } from '../notify';
import type { Booking, Branding } from '../types';

/**
 * Fires every 15 minutes. Finds confirmed bookings whose next reminder instant
 * has passed, sends the due reminder(s), and advances each booking's schedule.
 * Sends are idempotent (durable per-(booking,kind) guard), so a duplicate tick
 * or retry never double-sends.
 */
export async function runReminders(nowMs = Date.now()): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const q = await db
    .collection(COL.bookings)
    .where('status', '==', 'confirmed')
    .where('reminderDueUtc', '<=', nowIso)
    .orderBy('reminderDueUtc', 'asc')
    .limit(200)
    .get();
  if (q.empty) return;

  const branding = await loadBranding();
  for (const d of q.docs) {
    const booking = { id: d.id, ...d.data() } as Booking;
    await processBooking(booking, branding, nowMs).catch(() =>
      logger.error('Reminder processing failed', { bookingId: booking.id }),
    );
  }
}

async function processBooking(
  booking: Booking,
  branding: Branding,
  nowMs: number,
): Promise<void> {
  const startMs = new Date(booking.startUtc).getTime();
  const ref = db.collection(COL.bookings).doc(booking.id);

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
      await sendBookingReminder(booking, branding, minutesBefore);
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
