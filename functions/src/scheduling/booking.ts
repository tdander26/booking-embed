import { DateTime } from 'luxon';
import { logger } from 'firebase-functions';
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { db, tenantDb } from '../firebase';
import { BASE_GRID_MINUTES, isEmulator } from '../config';
import { coveredCells } from './slots';
import { computeAvailability, loadEventTypeById, loadSchedule } from './availability';
import { getMemberCalendar, getConnectionProvider } from '../calendar/provider';
import { MockCalendarProvider, type CalendarProvider } from '../calendar/provider';
import { loadMember } from '../members';
import { ownerMemberId } from '../tenants';
import { validateAnswers, formatAnswersText } from './answers';
import { randomToken, sanitizeForDocId } from '../util/ids';
import { badRequest, conflict, notFound, serverError } from '../util/http';
import {
  sendBookingConfirmation,
  sendBookingCancellation,
  sendBookingReschedule,
} from '../notify';
import { loadBranding, DEFAULT_REMINDERS_MINUTES } from '../branding';
import type {
  Booking,
  BookingAnswer,
  BookingConfirmation,
  CreateBookingRequest,
  EventType,
  Member,
} from '../types';

/** Locks/counters are partitioned by MEMBER (the true concurrency domain), not
 * by calendar id: two providers can hold the same wall-clock cell, while two
 * bookings for the SAME member that overlap still collide on a shared cell. The
 * docs live UNDER the tenant (tenantDb), so the same member-id string in two
 * tenants can never collide. */
function lockId(memberId: string, cell: number): string {
  return `${sanitizeForDocId(memberId)}_${cell}`;
}

function canonicalIso(input: string): { ms: number; iso: string } {
  const ms = DateTime.fromISO(input, { setZone: true }).toMillis();
  if (Number.isNaN(ms)) throw badRequest('Invalid start time', 'bad_time');
  return { ms, iso: new Date(ms).toISOString() };
}

/**
 * Resolve the provider this booking is for. When the event type lists members,
 * `req.memberId` is required and must be one of them; otherwise we fall back to
 * the tenant owner so legacy single-provider types keep working.
 */
async function resolveMember(
  tenantId: string,
  eventType: EventType,
  req: CreateBookingRequest,
): Promise<{ memberId: string; member: Member | null }> {
  const offered = eventType.memberIds ?? [];
  if (offered.length > 0) {
    const chosen = req.memberId;
    if (!chosen || !offered.includes(chosen)) {
      throw badRequest('Please choose a provider.', 'member_required');
    }
    const member = await loadMember(tenantId, chosen);
    if (!member || !member.active) {
      throw notFound('Provider unavailable', 'no_member');
    }
    return { memberId: chosen, member };
  }
  // Legacy single-provider: honor an explicit memberId if given, else the owner.
  const memberId = req.memberId || (await ownerMemberId(tenantId));
  const member = await loadMember(tenantId, memberId);
  return { memberId, member };
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
  tenantId: string,
  req: CreateBookingRequest,
  nowMs = Date.now(),
): Promise<{ booking: Booking; confirmation: BookingConfirmation }> {
  const eventType = await loadEventTypeById(tenantId, req.eventTypeId);
  if (!eventType || !eventType.active) {
    throw notFound('Event type not found', 'no_event_type');
  }

  // A phone consult must capture a number to call.
  if (eventType.location.type === 'phone' && !req.phone?.trim()) {
    throw badRequest('A phone number is required for a phone consult.', 'phone_required');
  }

  // Resolve the provider (or legacy owner). Member-aware from here on.
  const { memberId, member } = await resolveMember(tenantId, eventType, req);
  const memberName = member?.name;

  // Validate custom intake answers against the CURRENT questions BEFORE the
  // transaction. Throws badRequest('invalid_answers', { fields }) on failure.
  const answers: BookingAnswer[] = validateAnswers(eventType, req.answers);

  const { ms: startMs, iso: startIso } = canonicalIso(req.startUtc);
  const endMs = startMs + eventType.durationMinutes * 60_000;
  const endIso = new Date(endMs).toISOString();

  // Authoritative re-validation: the requested instant must be an offered slot
  // RIGHT NOW for THIS member (re-checks availability windows, buffers, notice,
  // calendar busy, and existing bookings). The client's view may be stale.
  const start = DateTime.fromMillis(startMs, { zone: 'utc' });
  const avail = await computeAvailability({
    tenantId,
    eventType,
    memberId,
    fromDate: start.minus({ days: 1 }).toFormat('yyyy-MM-dd'),
    toDate: start.plus({ days: 1 }).toFormat('yyyy-MM-dd'),
    inviteeTz: req.timezone,
    nowUtc: nowMs,
  });
  const offered = new Set(avail.days.flatMap((d) => d.slots));
  if (!offered.has(startIso)) {
    throw conflict('That time is no longer available.', 'slot_unavailable');
  }

  // Per-member write target: a real Google calendar when this member has a write
  // connection, otherwise the mock provider (same as today's not-connected path).
  const rc = await getMemberCalendar(tenantId, memberId);
  const writeProvider: CalendarProvider = rc.write?.provider ?? new MockCalendarProvider();
  const writeCalendarId = rc.write?.calendarId ?? 'primary';
  const writeConnectionId = rc.write?.connectionId;

  // Per-day cap is enforced TRANSACTIONALLY via a counter doc keyed by MEMBER.
  // The read-path filter in computeAvailability is only a UI pre-check.
  let dayCounterRef: DocumentReference | undefined;
  const dayCap = eventType.dailyBookingLimit;
  if (dayCap != null) {
    // Count the day in the MEMBER's own schedule timezone (falls back to the
    // legacy event-type schedule when the member has no default schedule).
    const scheduleId = member?.defaultScheduleId || eventType.availabilityScheduleId;
    const schedule = scheduleId ? await loadSchedule(tenantId, scheduleId) : null;
    const zone = schedule?.timezone ?? 'utc';
    const dayKey = DateTime.fromMillis(startMs, { zone }).toFormat('yyyy-MM-dd');
    dayCounterRef = tenantDb(tenantId)
      .dayCounters()
      .doc(`${sanitizeForDocId(memberId)}_${dayKey}`);
  }

  // --- Atomic reservation + booking creation -----------------------------
  // Lock every grid cell the booking covers, so any overlapping concurrent
  // booking FOR THE SAME MEMBER (even a different start time) collides on a
  // shared cell and loses. Different members are in disjoint key partitions.
  const cells = coveredCells(startMs, endMs, BASE_GRID_MINUTES);
  const lockIds = cells.map((c) => lockId(memberId, c));
  const bookingRef = tenantDb(tenantId).bookings().doc();
  const bookingId = bookingRef.id;
  const cancelToken = randomToken();
  const nowIso = new Date(nowMs).toISOString();
  // Resolve the reminder schedule: an event type's own value wins; null/absent
  // inherits the practice default; absent there falls back to the built-in.
  // An explicit [] (event type or practice) means "no reminders" and is kept.
  const branding = await loadBranding(tenantId);
  const reminderMinutes =
    eventType.remindersMinutesBefore ??
    branding.defaultRemindersMinutesBefore ??
    DEFAULT_REMINDERS_MINUTES;
  const { remindersRemaining, reminderDueUtc } = buildReminderSchedule(
    startMs,
    reminderMinutes,
    nowMs,
  );

  const hasQuestions = (eventType.questions?.length ?? 0) > 0;

  // Compose the display name from first/last (new flow) or the legacy combined.
  const firstName = req.firstName?.trim() || undefined;
  const lastName = req.lastName?.trim() || undefined;
  const fullName =
    req.name?.trim() || [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!fullName) throw badRequest('Please enter your name.', 'name_required');

  const booking: Booking = {
    id: bookingId,
    tenantId,
    eventTypeId: eventType.id,
    eventTypeName: eventType.name,
    memberId,
    memberName,
    startUtc: startIso,
    endUtc: endIso,
    durationMinutes: eventType.durationMinutes,
    invitee: {
      name: fullName,
      firstName,
      lastName,
      email: req.email.trim().toLowerCase(),
      phone: req.phone?.trim() || undefined,
      // The legacy free-text notes box only applies when there are no custom
      // questions; when questions exist, answers replace it.
      notes: hasQuestions ? undefined : req.notes?.trim() || undefined,
      timezone: req.timezone,
    },
    answers: answers.length > 0 ? answers : undefined,
    location: { type: eventType.location.type, details: eventType.location.details },
    status: 'confirmed',
    calendarRef: writeConnectionId
      ? { connectionId: writeConnectionId, calendarId: writeCalendarId }
      : undefined,
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
      const lockRefs = lockIds.map((id) => tenantDb(tenantId).slotLocks().doc(id));
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
          memberId,
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
  // (branding was already loaded above to resolve the reminder schedule)
  const host = memberName ?? branding.displayName;
  const withMeet = eventType.location.type === 'google_meet';
  let meetUrl: string | undefined;
  let googleEventId: string | undefined;
  try {
    const created = await writeProvider.createEvent(writeCalendarId, {
      summary: `${eventType.name} — ${booking.invitee.name}`,
      description: buildEventDescription(booking, host),
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
    await releaseBooking(tenantId, booking).catch(() => undefined);
    throw serverError(
      'Could not reserve the time on the calendar. Please try again.',
      'calendar_failed',
    );
  }

  const location = { ...booking.location, meetUrl };
  // If we fell back to the mock provider in PRODUCTION (this member has no
  // connected/writable calendar), flag it so staff are alerted the event never
  // reached a real calendar. The mock returns no meetUrl, so no dead Meet link
  // is ever emailed. (Emulator demos are intentionally not flagged.)
  const googleSyncError = !rc.write && !isEmulator() ? 'no_write_calendar' : undefined;
  await bookingRef.update({
    googleEventId: googleEventId ?? null,
    location,
    googleSyncError: googleSyncError ?? null,
  });
  booking.googleEventId = googleEventId;
  booking.location = location;
  booking.googleSyncError = googleSyncError;

  // Confirmation email (idempotent; failure must not fail the booking).
  try {
    await sendBookingConfirmation(tenantId, booking, branding);
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
    providerName: memberName ?? branding.displayName,
  };
  return { booking, confirmation };
}

/** Delete the booking doc + its slot locks and free its day-cap slot (rollback).
 * Uses the booking's STORED lockIds/dayCounterId so legacy and new bookings both
 * release the correct docs. */
async function releaseBooking(tenantId: string, booking: Booking): Promise<void> {
  const t = tenantDb(tenantId);
  const batch = db.batch();
  batch.delete(t.bookings().doc(booking.id));
  for (const id of booking.lockIds) {
    batch.delete(t.slotLocks().doc(id));
  }
  if (booking.dayCounterId) {
    batch.set(
      t.dayCounters().doc(booking.dayCounterId),
      { count: FieldValue.increment(-1) },
      { merge: true },
    );
  }
  await batch.commit();
}

export async function loadBookingForManage(
  tenantId: string,
  bookingId: string,
  token: string,
): Promise<Booking> {
  const snap = await tenantDb(tenantId).bookings().doc(bookingId).get();
  if (!snap.exists) throw notFound('Booking not found', 'no_booking');
  const booking = { id: snap.id, ...snap.data() } as Booking;
  if (!token || token !== booking.cancelToken) {
    throw notFound('Booking not found', 'no_booking'); // do not reveal existence
  }
  return booking;
}

export async function cancelBooking(
  tenantId: string,
  bookingId: string,
  token: string,
  reason: string | undefined,
  nowMs = Date.now(),
): Promise<Booking> {
  const booking = await loadBookingForManage(tenantId, bookingId, token);
  if (booking.status === 'cancelled') return booking; // idempotent

  // Delete the event with the SAME account token + calendar it was created on.
  // Prefer the booking's snapshotted calendarRef (connection + calendar) so a
  // later write-target reassignment to another account can't orphan the event;
  // fall back to the member's current write target for legacy bookings.
  const memberId = booking.memberId || (await ownerMemberId(tenantId));
  let provider: CalendarProvider;
  let calendarId: string;
  if (booking.calendarRef?.connectionId) {
    const conn = await getConnectionProvider(tenantId, memberId, booking.calendarRef.connectionId);
    provider = conn.provider;
    calendarId = booking.calendarRef.calendarId;
  } else {
    const rc = await getMemberCalendar(tenantId, memberId);
    provider = rc.write?.provider ?? new MockCalendarProvider();
    calendarId = rc.write?.calendarId ?? 'primary';
  }

  // Free the slot + mark cancelled.
  const t = tenantDb(tenantId);
  const batch = db.batch();
  batch.update(t.bookings().doc(bookingId), {
    status: 'cancelled',
    cancelledAt: new Date(nowMs).toISOString(),
    cancelReason: reason?.slice(0, 500) || null,
    reminderDueUtc: null,
    remindersRemaining: [],
  });
  for (const id of booking.lockIds) {
    batch.delete(t.slotLocks().doc(id));
  }
  if (booking.dayCounterId) {
    batch.set(
      t.dayCounters().doc(booking.dayCounterId),
      { count: FieldValue.increment(-1) },
      { merge: true },
    );
  }
  await batch.commit();

  // Remove the calendar event (best-effort). Skip mock ids (never on a real cal).
  if (booking.googleEventId && !booking.googleEventId.startsWith('mock_')) {
    await provider
      .deleteEvent(calendarId, booking.googleEventId)
      .catch((err) => logger.error('Calendar delete failed', { bookingId }));
  }

  booking.status = 'cancelled';
  const branding = await loadBranding(tenantId);
  await sendBookingCancellation(tenantId, booking, branding).catch(() =>
    logger.error('Cancellation email failed', { bookingId }),
  );
  return booking;
}

/**
 * Move an existing booking to a new time. Mirrors createBooking's guarantees:
 * re-validates the new slot for the member, atomically swaps the slot locks (and
 * per-day counter if the day changed), then moves the calendar event (the
 * provider has no update op, so we create the new event and delete the old) and
 * emails the invitee. The DB is the source of truth; calendar/email are
 * best-effort and flagged on failure.
 */
export async function rescheduleBooking(
  tenantId: string,
  bookingId: string,
  token: string,
  newStartUtc: string,
  nowMs = Date.now(),
): Promise<Booking> {
  const booking = await loadBookingForManage(tenantId, bookingId, token);
  if (booking.status === 'cancelled') {
    throw conflict("This appointment was cancelled, so it can't be rescheduled.", 'already_cancelled');
  }

  const eventType = await loadEventTypeById(tenantId, booking.eventTypeId);
  if (!eventType || !eventType.active) throw notFound('Event type not found', 'no_event_type');

  const memberId = booking.memberId || (await ownerMemberId(tenantId));
  const member = await loadMember(tenantId, memberId);
  const inviteeTz = booking.invitee.timezone || 'utc';

  const { ms: newStartMs, iso: newStartIso } = canonicalIso(newStartUtc);
  if (newStartIso === booking.startUtc) return booking; // no-op
  const newEndMs = newStartMs + booking.durationMinutes * 60_000;
  const newEndIso = new Date(newEndMs).toISOString();

  // The new instant must be an offered slot for THIS member right now.
  const start = DateTime.fromMillis(newStartMs, { zone: 'utc' });
  const avail = await computeAvailability({
    tenantId,
    eventType,
    memberId,
    fromDate: start.minus({ days: 1 }).toFormat('yyyy-MM-dd'),
    toDate: start.plus({ days: 1 }).toFormat('yyyy-MM-dd'),
    inviteeTz,
    nowUtc: nowMs,
  });
  if (!new Set(avail.days.flatMap((d) => d.slots)).has(newStartIso)) {
    throw conflict('That time is no longer available.', 'slot_unavailable');
  }

  const t = tenantDb(tenantId);

  // Per-day cap counters, moved only if the booking crosses a day boundary
  // (keyed in the member's schedule timezone, same as createBooking).
  const dayCap = eventType.dailyBookingLimit;
  let oldDayCounterRef: DocumentReference | undefined;
  let newDayCounterRef: DocumentReference | undefined;
  let dayChanged = false;
  if (dayCap != null) {
    const scheduleId = member?.defaultScheduleId || eventType.availabilityScheduleId;
    const schedule = scheduleId ? await loadSchedule(tenantId, scheduleId) : null;
    const zone = schedule?.timezone ?? 'utc';
    const oldDayKey = DateTime.fromISO(booking.startUtc, { zone: 'utc' }).setZone(zone).toFormat('yyyy-MM-dd');
    const newDayKey = DateTime.fromMillis(newStartMs, { zone }).toFormat('yyyy-MM-dd');
    dayChanged = oldDayKey !== newDayKey;
    if (dayChanged) {
      oldDayCounterRef = t.dayCounters().doc(
        booking.dayCounterId || `${sanitizeForDocId(memberId)}_${oldDayKey}`,
      );
      newDayCounterRef = t.dayCounters().doc(`${sanitizeForDocId(memberId)}_${newDayKey}`);
    }
  }

  // Reminder schedule recomputed for the new time.
  const branding = await loadBranding(tenantId);
  const reminderMinutes =
    eventType.remindersMinutesBefore ??
    branding.defaultRemindersMinutesBefore ??
    DEFAULT_REMINDERS_MINUTES;
  const { remindersRemaining, reminderDueUtc } = buildReminderSchedule(newStartMs, reminderMinutes, nowMs);

  // Atomic slot move: acquire the new cells we don't already hold, release the
  // old cells we no longer need. Cells shared by old+new (overlapping move) stay.
  const nowIso = new Date(nowMs).toISOString();
  const newCells = coveredCells(newStartMs, newEndMs, BASE_GRID_MINUTES);
  const newLockIds = newCells.map((c) => lockId(memberId, c));
  const oldSet = new Set(booking.lockIds);
  const newSet = new Set(newLockIds);
  const toAcquire = newLockIds.filter((id) => !oldSet.has(id));
  const toRelease = booking.lockIds.filter((id) => !newSet.has(id));

  try {
    await db.runTransaction(async (tx) => {
      const acquireRefs = toAcquire.map((id) => t.slotLocks().doc(id));
      const [snaps, newCounterSnap] = await Promise.all([
        Promise.all(acquireRefs.map((r) => tx.get(r))),
        newDayCounterRef ? tx.get(newDayCounterRef) : Promise.resolve(null),
      ]);
      if (snaps.some((s) => s.exists)) {
        const e = new Error('SLOT_TAKEN');
        (e as Error & { code?: string }).code = 'SLOT_TAKEN';
        throw e;
      }
      if (dayCap != null && newDayCounterRef && ((newCounterSnap?.get('count') as number | undefined) ?? 0) >= dayCap) {
        const e = new Error('DAY_FULL');
        (e as Error & { code?: string }).code = 'DAY_FULL';
        throw e;
      }
      acquireRefs.forEach((ref) =>
        tx.create(ref, {
          bookingId,
          memberId,
          eventTypeId: eventType.id,
          startUtc: newStartIso,
          endUtc: newEndIso,
          createdAt: nowIso,
        }),
      );
      toRelease.forEach((id) => tx.delete(t.slotLocks().doc(id)));
      if (newDayCounterRef) tx.set(newDayCounterRef, { count: FieldValue.increment(1), updatedAt: nowIso }, { merge: true });
      if (oldDayCounterRef) tx.set(oldDayCounterRef, { count: FieldValue.increment(-1) }, { merge: true });
      tx.update(t.bookings().doc(bookingId), {
        startUtc: newStartIso,
        endUtc: newEndIso,
        lockIds: newLockIds,
        dayCounterId: dayChanged ? newDayCounterRef!.id : booking.dayCounterId ?? null,
        reminderDueUtc,
        remindersRemaining,
        rescheduledAt: nowIso,
      });
    });
  } catch (err) {
    const code = (err as Error & { code?: string | number }).code;
    if (code === 'SLOT_TAKEN' || code === 6 /* ALREADY_EXISTS */) {
      throw conflict('That time was just booked by someone else.', 'slot_taken');
    }
    if (code === 'DAY_FULL') throw conflict('That day is fully booked.', 'day_full');
    throw err;
  }

  // Reflect the move on the in-memory booking (email + calendar read from it).
  const oldGoogleEventId = booking.googleEventId;
  const oldCalendarRef = booking.calendarRef;
  booking.startUtc = newStartIso;
  booking.endUtc = newEndIso;
  booking.lockIds = newLockIds;
  if (dayChanged && newDayCounterRef) booking.dayCounterId = newDayCounterRef.id;
  booking.reminderDueUtc = reminderDueUtc;
  booking.remindersRemaining = remindersRemaining;
  booking.rescheduledAt = nowIso;

  // Move the calendar event: create the new one, then delete the old. (Provider
  // has no update op.) Best-effort; DB stays authoritative.
  const host = booking.memberName ?? branding.displayName;
  const withMeet = booking.location.type === 'google_meet';
  const rc = await getMemberCalendar(tenantId, memberId);
  const writeProvider: CalendarProvider = rc.write?.provider ?? new MockCalendarProvider();
  const writeCalendarId = rc.write?.calendarId ?? 'primary';
  let newEventId: string | undefined;
  let meetUrl: string | undefined;
  try {
    const created = await writeProvider.createEvent(writeCalendarId, {
      summary: `${booking.eventTypeName} — ${booking.invitee.name}`,
      description: buildEventDescription(booking, host),
      startUtcIso: newStartIso,
      endUtcIso: newEndIso,
      attendeeEmail: booking.invitee.email,
      attendeeName: booking.invitee.name,
      withMeet,
    });
    newEventId = created.eventId;
    meetUrl = created.meetUrl;
  } catch (err) {
    logger.error('Reschedule: creating the new calendar event failed', { bookingId });
  }

  // Delete the OLD event on the calendar it was written to.
  if (oldGoogleEventId && !oldGoogleEventId.startsWith('mock_')) {
    try {
      let delProvider: CalendarProvider;
      let delCalendarId: string;
      if (oldCalendarRef?.connectionId) {
        const conn = await getConnectionProvider(tenantId, memberId, oldCalendarRef.connectionId);
        delProvider = conn.provider;
        delCalendarId = oldCalendarRef.calendarId;
      } else {
        delProvider = writeProvider;
        delCalendarId = writeCalendarId;
      }
      await delProvider.deleteEvent(delCalendarId, oldGoogleEventId);
    } catch (err) {
      logger.error('Reschedule: deleting the old calendar event failed', { bookingId });
    }
  }

  const location = { ...booking.location, meetUrl };
  const newCalendarRef = rc.write?.connectionId
    ? { connectionId: rc.write.connectionId, calendarId: writeCalendarId }
    : undefined;
  const googleSyncError = !rc.write && !isEmulator()
    ? 'no_write_calendar'
    : !newEventId && !isEmulator()
      ? 'reschedule_event_failed'
      : undefined;
  await t.bookings().doc(bookingId).update({
    googleEventId: newEventId ?? null,
    calendarRef: newCalendarRef ?? null,
    location,
    googleSyncError: googleSyncError ?? null,
  });
  booking.googleEventId = newEventId;
  booking.calendarRef = newCalendarRef;
  booking.location = location;
  booking.googleSyncError = googleSyncError;

  await sendBookingReschedule(tenantId, booking, branding).catch(() =>
    logger.error('Reschedule email failed', { bookingId }),
  );

  return booking;
}

/** Google Calendar event description: host line, custom intake answers, then the
 * legacy notes/phone lines. Answer labels are snapshotted on the booking, so a
 * later question edit/delete never loses a historical answer. */
function buildEventDescription(booking: Booking, host: string): string {
  const lines = [
    `Booked with ${host}.`,
    '',
    `Name: ${booking.invitee.name}`,
    `Email: ${booking.invitee.email}`,
  ];
  if (booking.invitee.phone) lines.push(`Phone: ${booking.invitee.phone}`);
  if (booking.answers && booking.answers.length > 0) {
    const block = formatAnswersText(booking.answers);
    if (block) lines.push('', block);
  }
  if (booking.invitee.notes) lines.push('', `Notes: ${booking.invitee.notes}`);
  return lines.join('\n');
}
