import { DateTime } from 'luxon';
import { logger } from 'firebase-functions';
import { db, tenantDb } from './firebase';
import { sendEmail } from './email/resend';
import { sendSms } from './sms/twilio';
import {
  confirmationEmail,
  reminderEmail,
  cancellationEmail,
  rescheduleEmail,
  providerNewBookingEmail,
  providerCancellationEmail,
} from './email/templates';
import { loadMember } from './members';
import { manageUrl } from './util/urls';
import type { Booking, Branding } from './types';

/** The provider's notification email + the timezone to show them times in. */
async function providerContact(
  tenantId: string,
  booking: Booking,
  branding: Branding,
): Promise<{ email: string; tz: string } | null> {
  const member = await loadMember(tenantId, booking.memberId);
  if (!member?.email) return null;
  return { email: member.email, tz: member.timezone || branding.timezone };
}

/**
 * Durable "exactly once" guard. A deterministic doc id per (booking, kind) means
 * a duplicate cron tick, a retried function, or a double-submit collide and only
 * one send happens. Backs both email AND SMS (Twilio has no idempotency key).
 */
export async function sendOnce(
  tenantId: string,
  bookingId: string,
  kind: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const ref = tenantDb(tenantId).reminderSends().doc(`${bookingId}_${kind}`);
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
  tenantId: string,
  booking: Booking,
  branding: Branding,
): Promise<void> {
  // 1) The person scheduling (invitee).
  await sendOnce(tenantId, booking.id, 'confirm', async () => {
    const { subject, html, text } = confirmationEmail(booking, branding);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      from: branding.emailFrom,
      tenantId,
      idempotencyKey: `confirm/${booking.id}`,
    });
  });

  // 2) The person being scheduled with (provider).
  const provider = await providerContact(tenantId, booking, branding);
  if (provider) {
    await sendOnce(tenantId, booking.id, 'confirm-provider', async () => {
      const { subject, html, text } = providerNewBookingEmail(booking, branding, provider.tz);
      await sendEmail({
        to: provider.email,
        subject,
        html,
        text,
        from: branding.emailFrom,
        tenantId,
        idempotencyKey: `confirm-provider/${booking.id}`,
      });
    });
  }
}

export async function sendBookingReschedule(
  tenantId: string,
  booking: Booking,
  branding: Branding,
): Promise<void> {
  // Keyed by the NEW start so each distinct reschedule sends exactly once (a
  // retry to the same time is idempotent; a later move to another time fires).
  await sendOnce(tenantId, booking.id, `reschedule:${booking.startUtc}`, async () => {
    const { subject, html, text } = rescheduleEmail(booking, branding);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      from: branding.emailFrom,
      tenantId,
      idempotencyKey: `reschedule/${booking.id}/${booking.startUtc}`,
    });
  });
}

export async function sendBookingReminder(
  tenantId: string,
  booking: Booking,
  branding: Branding,
  minutesBefore: number,
): Promise<void> {
  await sendOnce(tenantId, booking.id, `reminder-${minutesBefore}`, async () => {
    const { subject, html, text } = reminderEmail(booking, branding, minutesBefore);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      from: branding.emailFrom,
      tenantId,
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
  tenantId: string,
  booking: Booking,
  branding: Branding,
): Promise<void> {
  await sendOnce(tenantId, booking.id, 'cancel', async () => {
    const { subject, html, text } = cancellationEmail(booking, branding);
    await sendEmail({
      to: booking.invitee.email,
      subject,
      html,
      text,
      from: branding.emailFrom,
      tenantId,
      idempotencyKey: `cancel/${booking.id}`,
    });
  });

  const provider = await providerContact(tenantId, booking, branding);
  if (provider) {
    await sendOnce(tenantId, booking.id, 'cancel-provider', async () => {
      const { subject, html, text } = providerCancellationEmail(booking, branding, provider.tz);
      await sendEmail({
        to: provider.email,
        subject,
        html,
        text,
        from: branding.emailFrom,
        tenantId,
        idempotencyKey: `cancel-provider/${booking.id}`,
      });
    });
  }
}

export { manageUrl };
