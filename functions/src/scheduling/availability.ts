import { DateTime } from 'luxon';
import { db, COL } from '../firebase';
import {
  slotsForDay,
  filterSlots,
  type Slot,
  type Interval,
  type Window,
} from './slots';
import { getCalendarProvider } from '../calendar/provider';
import { notFound } from '../util/http';
import type {
  EventType,
  AvailabilitySchedule,
  Booking,
  AvailabilityResponse,
  AvailabilityDay,
} from '../types';

const MAX_RANGE_DAYS = 62; // bound work per request (≈ two months)

export async function loadEventTypeById(id: string): Promise<EventType | null> {
  const snap = await db.collection(COL.eventTypes).doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as EventType) : null;
}

export async function loadEventTypeBySlug(slug: string): Promise<EventType | null> {
  const q = await db
    .collection(COL.eventTypes)
    .where('slug', '==', slug)
    .limit(1)
    .get();
  if (q.empty) return null;
  const d = q.docs[0];
  return { id: d.id, ...d.data() } as EventType;
}

export async function loadSchedule(id: string): Promise<AvailabilitySchedule> {
  const snap = await db.collection(COL.schedules).doc(id).get();
  if (!snap.exists) throw notFound('Availability schedule not found', 'no_schedule');
  return { id: snap.id, ...snap.data() } as AvailabilitySchedule;
}

/** "yyyy-MM-dd" strings for each day in [from, to] within `zone`. */
function enumerateDays(fromISO: string, toISO: string, zone: string): string[] {
  const days: string[] = [];
  let cur = DateTime.fromISO(fromISO, { zone }).startOf('day');
  const end = DateTime.fromISO(toISO, { zone }).startOf('day');
  if (!cur.isValid || !end.isValid) return days;
  let guard = 0;
  while (cur <= end && guard++ < 400) {
    days.push(cur.toFormat('yyyy-MM-dd'));
    cur = cur.plus({ days: 1 }); // variable-length: stays at local midnight
  }
  return days;
}

/** Windows for a given day: a date override (possibly empty) wins over weekly. */
function windowsForDay(
  schedule: AvailabilitySchedule,
  dayISO: string,
  zone: string,
): Window[] {
  const override = schedule.overrides?.find((o) => o.date === dayISO);
  if (override) return override.windows ?? [];
  const weekday = DateTime.fromISO(dayISO, { zone }).weekday % 7; // 0=Sun..6=Sat
  return schedule.weekly?.[weekday] ?? [];
}

export async function computeAvailability(params: {
  eventType: EventType;
  fromDate: string; // "yyyy-MM-dd" (invitee-facing range start)
  toDate: string; // "yyyy-MM-dd"
  inviteeTz: string;
  nowUtc?: number;
}): Promise<AvailabilityResponse> {
  const { eventType, inviteeTz } = params;
  const now = params.nowUtc ?? Date.now();
  const schedule = await loadSchedule(eventType.availabilityScheduleId);
  const scheduleZone = schedule.timezone;

  // Clamp the requested range to [today, today + maxDaysInFuture] and cap width.
  const todayInZone = DateTime.fromMillis(now, { zone: scheduleZone }).toFormat(
    'yyyy-MM-dd',
  );
  const horizon = DateTime.fromMillis(now, { zone: scheduleZone })
    .plus({ days: eventType.maxDaysInFuture })
    .toFormat('yyyy-MM-dd');
  let fromDate = params.fromDate < todayInZone ? todayInZone : params.fromDate;
  let toDate = params.toDate > horizon ? horizon : params.toDate;
  // Hard cap on width.
  const widthCapped = DateTime.fromISO(fromDate, { zone: scheduleZone })
    .plus({ days: MAX_RANGE_DAYS })
    .toFormat('yyyy-MM-dd');
  if (toDate > widthCapped) toDate = widthCapped;

  // Pad the schedule-zone enumeration one day each side. When the invitee's
  // timezone differs from the schedule's, a schedule-zone day that straddles
  // the invitee's first/last requested day must still be generated, or its
  // slots silently vanish at the range edges. filterSlots' absolute-time clamps
  // and the output trim below discard anything genuinely out of range.
  const padFrom = DateTime.fromISO(fromDate, { zone: scheduleZone })
    .minus({ days: 1 })
    .toFormat('yyyy-MM-dd');
  const padTo = DateTime.fromISO(toDate, { zone: scheduleZone })
    .plus({ days: 1 })
    .toFormat('yyyy-MM-dd');
  const days = enumerateDays(padFrom, padTo, scheduleZone);
  if (days.length === 0 || toDate < fromDate) {
    return {
      eventTypeId: eventType.id,
      timezone: inviteeTz,
      durationMinutes: eventType.durationMinutes,
      days: [],
    };
  }

  // Generate candidate slots (UTC instants) across the range.
  let candidates: Slot[] = [];
  for (const dayISO of days) {
    const windows = windowsForDay(schedule, dayISO, scheduleZone);
    if (windows.length === 0) continue;
    candidates = candidates.concat(
      slotsForDay({
        dayISO,
        scheduleZone,
        windows,
        stepMin: eventType.slotIntervalMinutes,
        durationMin: eventType.durationMinutes,
      }),
    );
  }
  if (candidates.length === 0) {
    return {
      eventTypeId: eventType.id,
      timezone: inviteeTz,
      durationMinutes: eventType.durationMinutes,
      days: [],
    };
  }

  // Range bounds (UTC ISO) for busy queries — pad start to catch bookings that
  // begin before the range but spill into it.
  const rangeStartMs = candidates[0].startUtc;
  const rangeEndMs = candidates[candidates.length - 1].endUtc;
  const lookbackMs = rangeStartMs - 24 * 3_600_000;
  const fromIso = new Date(lookbackMs).toISOString();
  const toIso = new Date(rangeEndMs).toISOString();

  // Busy = owner's calendar free/busy + our own confirmed bookings.
  const { provider, calendarId } = await getCalendarProvider();
  const [calendarBusy, ownBusy, dayCounts] = await Promise.all([
    provider.getBusy(calendarId, fromIso, toIso).catch(() => [] as Interval[]),
    loadOwnBusy(fromIso, toIso),
    eventType.dailyBookingLimit ? loadDayCounts(fromIso, toIso, scheduleZone) : Promise.resolve(new Map<string, number>()),
  ]);
  const busy = [...calendarBusy, ...ownBusy];

  let open = filterSlots(candidates, busy, {
    bufferBeforeMin: eventType.bufferBeforeMinutes,
    bufferAfterMin: eventType.bufferAfterMinutes,
    minNoticeMin: eventType.minNoticeMinutes,
    maxDaysOut: eventType.maxDaysInFuture,
    nowUtc: now,
  });

  // Apply per-day booking cap (counted in the schedule's timezone).
  if (eventType.dailyBookingLimit) {
    const limit = eventType.dailyBookingLimit;
    open = open.filter((s) => {
      const dayKey = DateTime.fromMillis(s.startUtc, { zone: scheduleZone }).toFormat(
        'yyyy-MM-dd',
      );
      return (dayCounts.get(dayKey) ?? 0) < limit;
    });
  }

  // Group by day in the INVITEE timezone.
  const byDay = new Map<string, string[]>();
  for (const s of open) {
    const dayKey = DateTime.fromMillis(s.startUtc, { zone: inviteeTz }).toFormat(
      'yyyy-MM-dd',
    );
    const iso = new Date(s.startUtc).toISOString();
    const arr = byDay.get(dayKey);
    if (arr) arr.push(iso);
    else byDay.set(dayKey, [iso]);
  }

  const outDays: AvailabilityDay[] = [...byDay.entries()]
    // Trim the padded edges back to the requested invitee-tz range.
    .filter(([date]) => date >= fromDate && date <= toDate)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, slots]) => ({ date, slots: slots.sort() }));

  return {
    eventTypeId: eventType.id,
    timezone: inviteeTz,
    durationMinutes: eventType.durationMinutes,
    days: outDays,
  };
}

/** Confirmed bookings overlapping [fromIso, toIso) as busy intervals. */
async function loadOwnBusy(fromIso: string, toIso: string): Promise<Interval[]> {
  const q = await db
    .collection(COL.bookings)
    .where('status', '==', 'confirmed')
    .where('startUtc', '>=', fromIso)
    .where('startUtc', '<', toIso)
    .get();
  return q.docs.map((d) => {
    const b = d.data() as Booking;
    return {
      start: DateTime.fromISO(b.startUtc).toMillis(),
      end: DateTime.fromISO(b.endUtc).toMillis(),
    };
  });
}

/** Count confirmed bookings per schedule-tz day, for the daily cap. */
async function loadDayCounts(
  fromIso: string,
  toIso: string,
  zone: string,
): Promise<Map<string, number>> {
  const q = await db
    .collection(COL.bookings)
    .where('status', '==', 'confirmed')
    .where('startUtc', '>=', fromIso)
    .where('startUtc', '<', toIso)
    .get();
  const counts = new Map<string, number>();
  for (const d of q.docs) {
    const b = d.data() as Booking;
    const key = DateTime.fromISO(b.startUtc).setZone(zone).toFormat('yyyy-MM-dd');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
