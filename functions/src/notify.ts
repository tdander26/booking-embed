import { DateTime } from 'luxon';
import { logger } from 'firebase-functions';
import { db, COL } from './firebase';
import { sendEmail } from './email/resend';
import { sendSms } from './sms/twilio';
import {
  confirmationEmail,
  reminderEmail,
  cancellationEmail,
  providerNewBookingEmail,
  providerCancellationEmail,
} from './email/templates';
import { loadMember } from './members';
import { manageUrl } from './util/urls';
import type { Booking, Branding } from './types';

/** The provider's notification email + the timezone to show them times in. */
async function providerContact(
  booking: Booking,
  branding: Branding,
): Promise<{ email: string; tz: string } | null> {
  const member = await loadMember(booking.memberId);
  if (!member?.email) return null;
  return { email: member.email, tz: member.timezone || branding.timezone };
}

/**
 * Durable "exactly once" guard. A deterministic doc id per (booking, kind) means
 * a duplicate cron tick, a retried function, or a double-submit collide and only
 * one send happens. Backs both email AND SMS (Twilio has no idempotency key).
 */
export async function sendOnce(
  bookingId: string,
  kind: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const ref = db.collection(COL.reminderSends).doc(`${bookingId}_${kind}`);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { bookingId, kind, claimedAt: new Date().toISOString() });
    return true;
  });
  if (!claimed) return false;
  await fn();
  await ref.set({ sentAt: new Date().toISOString() }, { merge: true });
  return true;
}

export async function sendBookingConfirmation(
  booking: Booking,
  branding: Branding,
): Promise<void> {
  // 1) The person scheduling (invitee).
  await sendOnce(booking.id, 'confirm', async () => {
    const { subject, html, text } = confirmationEmail(booking, branding);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      idempotencyKey: `confirm/${booking.id}`,
    });
  });

  // 2) The person being scheduled with (provider).
  const provider = await providerContact(booking, branding);
  if (provider) {
    await sendOnce(booking.id, 'confirm-provider', async () => {
      const { subject, html, text } = providerNewBookingEmail(booking, branding, provider.tz);
      await sendEmail({
        to: provider.email,
        subject,
        html,
        text,
        idempotencyKey: `confirm-provider/${booking.id}`,
      });
    });
  }
}

export async function sendBookingReminder(
  booking: Booking,
  branding: Branding,
  minutesBefore: number,
): Promise<void> {
  await sendOnce(booking.id, `reminder-${minutesBefore}`, async () => {
    const { subject, html, text } = reminderEmail(booking, branding, minutesBefore);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      idempotencyKey: `reminder/${booking.id}/${minutesBefore}`,
    });
    if (booking.invitee.phone) {
      const when = DateTime.fromISO(booking.startUtc)
        .setZone(booking.invitee.timezone)
        .toLocaleString({
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
      await sendSms(
        booking.invitee.phone,
        `Reminder: ${booking.eventTypeName} with ${branding.displayName} on ${when}.`,
      ).catch((err) => logger.error('Reminder SMS failed', { bookingId: booking.id }));
    }
  });
}

export async function sendBookingCancellation(
  booking: Booking,
  branding: Branding,
): Promise<void> {
  await sendOnce(booking.id, 'cancel', async () => {
    const { subject, html, text } = cancellationEmail(booking, branding);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      idempotencyKey: `cancel/${booking.id}`,
    });
  });

  const provider = await providerContact(booking, branding);
  if (provider) {
    await sendOnce(booking.id, 'cancel-provider', async () => {
      const { subject, html, text } = providerCancellationEmail(booking, branding, provider.tz);
      await sendEmail({
        to: provider.email,
        subject,
        html,
        text,
        idempotencyKey: `cancel-provider/${booking.id}`,
      });
    });
  }
}

export { manageUrl };
