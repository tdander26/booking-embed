import { DateTime } from 'luxon';
import { logger } from 'firebase-functions';
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { db, COL } from '../firebase';
import { BASE_GRID_MINUTES } from '../config';
import { coveredCells } from './slots';
import { computeAvailability, loadEventTypeById, loadSchedule } from './availability';
import { getCalendarProvider } from '../calendar/provider';
import { randomToken, sanitizeForDocId } from '../util/ids';
import { badRequest, conflict, notFound, serverError } from '../util/http';
import {
  sendBookingConfirmation,
  sendBookingCancellation,
} from '../notify';
import { loadBranding } from '../branding';
import type {
  Booking,
  BookingConfirmation,
  CreateBookingRequest,
} from '../types';

function lockId(calendarId: string, cell: number): string {
  return `${sanitizeForDocId(calendarId)}_${cell}`;
}

function canonicalIso(input: string): { ms: number; iso: string } {
  const ms = DateTime.fromISO(input, { setZone: true }).toMillis();
  if (Number.isNaN(ms)) throw badRequest('Invalid start time', 'bad_time');
  return { ms, iso: new Date(ms).toISOString() };
}

/** Reminder schedule: minutes-before values whose fire instant is still future. */
function buildReminderSchedule(
  startMs: number,
  remindersMinutesBefore: number[],
  nowMs: number,
): { remindersRemaining: number[]; reminderDueUtc: string | null } {
  const remaining = [...new Set(remindersMinutesBefore)]
    .filter((m) => m > 0 && startMs - m * 60_000 > nowMs)
    .sort((a, b) => b - a); // descending: largest minutes-before fires first
  if (remaining.length === 0) return { remindersRemaining: [], reminderDueUtc: null };
  const dueMs = startMs - remaining[0] * 60_000;
  return { remindersRemaining: remaining, reminderDueUtc: new Date(dueMs).toISOString() };
}

export async function createBooking(
  req: CreateBookingRequest,
  nowMs = Date.now(),
): Promise<{ booking: Booking; confirmation: BookingConfirmation }> {
  const eventType = await loadEventTypeById(req.eventTypeId);
  if (!eventType || !eventType.active) {
    throw notFound('Event type not found', 'no_event_type');
  }

  const { ms: startMs, iso: startIso } = canonicalIso(req.startUtc);
  const endMs = startMs + eventType.durationMinutes * 60_000;
  const endIso = new Date(endMs).toISOString();

  // Authoritative re-validation: the requested instant must be an offered slot
  // RIGHT NOW (re-checks availability windows, buffers, notice, calendar busy,
  // and existing bookings). The client's view may be stale.
  const start = DateTime.fromMillis(startMs, { zone: 'utc' });
  const avail = await computeAvailability({
    eventType,
    fromDate: start.minus({ days: 1 }).toFormat('yyyy-MM-dd'),
    toDate: start.plus({ days: 1 }).toFormat('yyyy-MM-dd'),
    inviteeTz: req.timezone,
    nowUtc: nowMs,
  });
  const offered = new Set(avail.days.flatMap((d) => d.slots));
  if (!offered.has(startIso)) {
    throw conflict('That time is no longer available.', 'slot_unavailable');
  }

  const { provider, calendarId } = await getCalendarProvider();

  // Per-day cap is enforced TRANSACTIONALLY via a counter doc. The read-path
  // filter in computeAvailability is only a UI pre-check and races under load.
  let dayCounterRef: DocumentReference | undefined;
  const dayCap = eventType.dailyBookingLimit;
  if (dayCap != null) {
    const schedule = await loadSchedule(eventType.availabilityScheduleId);
    const dayKey = DateTime.fromMillis(startMs, { zone: schedule.timezone }).toFormat(
      'yyyy-MM-dd',
    );
    dayCounterRef = db
      .collection(COL.dayCounters)
      .doc(`${sanitizeForDocId(calendarId)}_${dayKey}`);
  }

  // --- Atomic reservation + booking creation -----------------------------
  // Lock every grid cell the booking covers, so any overlapping concurrent
  // booking (even a different start time) collides on a shared cell and loses.
  const cells = coveredCells(startMs, endMs, BASE_GRID_MINUTES);
  const lockIds = cells.map((c) => lockId(calendarId, c));
  const bookingRef = db.collection(COL.bookings).doc();
  const bookingId = bookingRef.id;
  const cancelToken = randomToken();
  const nowIso = new Date(nowMs).toISOString();
  const { remindersRemaining, reminderDueUtc } = buildReminderSchedule(
    startMs,
    eventType.remindersMinutesBefore ?? [],
    nowMs,
  );

  const booking: Booking = {
    id: bookingId,
    eventTypeId: eventType.id,
    eventTypeName: eventType.name,
    startUtc: startIso,
    endUtc: endIso,
    durationMinutes: eventType.durationMinutes,
    invitee: {
      name: req.name.trim(),
      email: req.email.trim().toLowerCase(),
      phone: req.phone?.trim() || undefined,
      notes: req.notes?.trim() || undefined,
      timezone: req.timezone,
    },
    location: { type: eventType.location.type, details: eventType.location.details },
    status: 'confirmed',
    lockIds,
    dayCounterId: dayCounterRef?.id,
    cancelToken,
    reminderDueUtc,
    remindersRemaining,
    confirmationSent: false,
    createdAt: nowIso,
    source: req.source === 'embed' ? 'embed' : 'web',
  };

  try {
    await db.runTransaction(async (tx) => {
      const lockRefs = lockIds.map((id) => db.collection(COL.slotLocks).doc(id));
      // All reads first.
      const [snaps, counterSnap] = await Promise.all([
        Promise.all(lockRefs.map((r) => tx.get(r))),
        dayCounterRef ? tx.get(dayCounterRef) : Promise.resolve(null),
      ]);
      if (snaps.some((s) => s.exists)) {
        const e = new Error('SLOT_TAKEN');
        (e as Error & { code?: string }).code = 'SLOT_TAKEN';
        throw e;
      }
      if (dayCap != null && ((counterSnap?.get('count') as number | undefined) ?? 0) >= dayCap) {
        const e = new Error('DAY_FULL');
        (e as Error & { code?: string }).code = 'DAY_FULL';
        throw e;
      }
      // Then all writes.
      lockRefs.forEach((ref) =>
        tx.create(ref, {
          bookingId,
          eventTypeId: eventType.id,
          startUtc: startIso,
          endUtc: endIso,
          createdAt: nowIso,
        }),
      );
      if (dayCounterRef) {
        tx.set(
          dayCounterRef,
          { count: FieldValue.increment(1), updatedAt: nowIso },
          { merge: true },
        );
      }
      tx.set(bookingRef, booking);
    });
  } catch (err) {
    const code = (err as Error & { code?: string | number }).code;
    if (code === 'SLOT_TAKEN' || code === 6 /* ALREADY_EXISTS */) {
      throw conflict('That time was just booked by someone else.', 'slot_taken');
    }
    if (code === 'DAY_FULL') {
      throw conflict('That day is fully booked.', 'day_full');
    }
    throw err;
  }

  // --- Side effects AFTER the transaction commits ------------------------
  const branding = await loadBranding();
  const withMeet = eventType.location.type === 'google_meet';
  let meetUrl: string | undefined;
  let googleEventId: string | undefined;
  try {
    const created = await provider.createEvent(calendarId, {
      summary: `${eventType.name} — ${booking.invitee.name}`,
      description: buildEventDescription(booking, branding.displayName),
      startUtcIso: startIso,
      endUtcIso: endIso,
      attendeeEmail: booking.invitee.email,
      attendeeName: booking.invitee.name,
      withMeet,
    });
    googleEventId = created.eventId;
    meetUrl = created.meetUrl;
  } catch (err) {
    // Roll back so the slot frees up and the source of truth stays consistent.
    logger.error('Calendar event creation failed; rolling back booking', {
      bookingId,
    });
    await releaseBooking(booking).catch(() => undefined);
    throw serverError(
      'Could not reserve the time on the calendar. Please try again.',
      'calendar_failed',
    );
  }

  const location = { ...booking.location, meetUrl };
  await bookingRef.update({ googleEventId: googleEventId ?? null, location });
  booking.googleEventId = googleEventId;
  booking.location = location;

  // Confirmation email (idempotent; failure must not fail the booking).
  try {
    await sendBookingConfirmation(booking, branding);
    await bookingRef.update({ confirmationSent: true });
    booking.confirmationSent = true;
  } catch (err) {
    logger.error('Confirmation email failed', { bookingId });
  }

  const confirmation: BookingConfirmation = {
    bookingId,
    cancelToken,
    startUtc: startIso,
    endUtc: endIso,
    timezone: req.timezone,
    eventTypeName: eventType.name,
    location,
    displayName: branding.displayName,
  };
  return { booking, confirmation };
}

/** Delete the booking doc + its slot locks and free its day-cap slot (rollback). */
async function releaseBooking(booking: Booking): Promise<void> {
  const batch = db.batch();
  batch.delete(db.collection(COL.bookings).doc(booking.id));
  for (const id of booking.lockIds) {
    batch.delete(db.collection(COL.slotLocks).doc(id));
  }
  if (booking.dayCounterId) {
    batch.set(
      db.collection(COL.dayCounters).doc(booking.dayCounterId),
      { count: FieldValue.increment(-1) },
      { merge: true },
    );
  }
  await batch.commit();
}

export async function loadBookingForManage(
  bookingId: string,
  token: string,
): Promise<Booking> {
  const snap = await db.collection(COL.bookings).doc(bookingId).get();
  if (!snap.exists) throw notFound('Booking not found', 'no_booking');
  const booking = { id: snap.id, ...snap.data() } as Booking;
  if (!token || token !== booking.cancelToken) {
    throw notFound('Booking not found', 'no_booking'); // do not reveal existence
  }
  return booking;
}

export async function cancelBooking(
  bookingId: string,
  token: string,
  reason: string | undefined,
  nowMs = Date.now(),
): Promise<Booking> {
  const booking = await loadBookingForManage(bookingId, token);
  if (booking.status === 'cancelled') return booking; // idempotent

  const { provider, calendarId } = await getCalendarProvider();

  // Free the slot + mark cancelled.
  const batch = db.batch();
  batch.update(db.collection(COL.bookings).doc(bookingId), {
    status: 'cancelled',
    cancelledAt: new Date(nowMs).toISOString(),
    cancelReason: reason?.slice(0, 500) || null,
    reminderDueUtc: null,
    remindersRemaining: [],
  });
  for (const id of booking.lockIds) {
    batch.delete(db.collection(COL.slotLocks).doc(id));
  }
  if (booking.dayCounterId) {
    batch.set(
      db.collection(COL.dayCounters).doc(booking.dayCounterId),
      { count: FieldValue.increment(-1) },
      { merge: true },
    );
  }
  await batch.commit();

  // Remove the calendar event (best-effort).
  if (booking.googleEventId) {
    await provider
      .deleteEvent(calendarId, booking.googleEventId)
      .catch((err) => logger.error('Calendar delete failed', { bookingId }));
  }

  booking.status = 'cancelled';
  const branding = await loadBranding();
  await sendBookingCancellation(booking, branding).catch(() =>
    logger.error('Cancellation email failed', { bookingId }),
  );
  return booking;
}

function buildEventDescription(booking: Booking, host: string): string {
  const lines = [`Booked with ${host}.`];
  if (booking.invitee.notes) lines.push('', `Notes: ${booking.invitee.notes}`);
  if (booking.invitee.phone) lines.push(`Phone: ${booking.invitee.phone}`);
  return lines.join('\n');
}
