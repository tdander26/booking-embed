import { DateTime } from 'luxon';
import { db, COL } from '../firebase';
import {
  slotsForDay,
  filterSlots,
  type Slot,
  type Interval,
  type Window,
} from './slots';
import {
  getCalendarProvider,
  getMemberCalendar,
  memberBusyForMember,
} from '../calendar/provider';
import { loadMember } from '../members';
import { notFound } from '../util/http';
import type {
  EventType,
  AvailabilitySchedule,
  Booking,
  AvailabilityResponse,
  AvailabilityDay,
  Member,
  NextAvailableProvider,
} from '../types';

const MAX_RANGE_DAYS = 62; // bound work per request (≈ two months)
const DEFAULT_MEMBER_ID = 'mbr_todd'; // legacy single-provider fallback

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

/**
 * Resolve which availability schedule to use for a request:
 *  - member-aware: the member's `defaultScheduleId`,
 *  - legacy fallback: `eventType.availabilityScheduleId` (single-provider docs).
 */
async function resolveSchedule(
  eventType: EventType,
  member: Member | null,
): Promise<AvailabilitySchedule> {
  const scheduleId = member?.defaultScheduleId || eventType.availabilityScheduleId;
  if (!scheduleId) throw notFound('Availability schedule not found', 'no_schedule');
  return loadSchedule(scheduleId);
}

/**
 * Member-aware availability. When `memberId` is supplied we resolve that member,
 * use their default schedule + their connected (selected) calendars' busy times,
 * and count only THAT member's own bookings as busy. When `memberId` is absent
 * we keep the exact legacy single-provider behavior (global Google provider +
 * eventType.availabilityScheduleId + all confirmed bookings).
 */
export async function computeAvailability(params: {
  eventType: EventType;
  memberId?: string;
  fromDate: string; // "yyyy-MM-dd" (invitee-facing range start)
  toDate: string; // "yyyy-MM-dd"
  inviteeTz: string;
  nowUtc?: number;
}): Promise<AvailabilityResponse> {
  const { eventType, inviteeTz } = params;
  const now = params.nowUtc ?? Date.now();
  const memberAware = !!params.memberId;
  const member = memberAware ? await loadMember(params.memberId!) : null;

  const schedule = await resolveSchedule(eventType, member);
  const scheduleZone = schedule.timezone;

  // Own-busy is ALWAYS scoped to a member so the read path matches the write
  // path (createBooking re-checks as mbr_todd in legacy mode). Without this, a
  // provider-less (legacy) type would count every provider's bookings as busy
  // and over-block the owner's real openings.
  const ownBusyMemberId = memberAware ? (params.memberId ?? DEFAULT_MEMBER_ID) : DEFAULT_MEMBER_ID;

  const emptyResponse = (): AvailabilityResponse => ({
    eventTypeId: eventType.id,
    memberId: memberAware ? params.memberId : undefined,
    timezone: inviteeTz,
    durationMinutes: eventType.durationMinutes,
    days: [],
  });

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
  if (days.length === 0 || toDate < fromDate) return emptyResponse();

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
  if (candidates.length === 0) return emptyResponse();

  // Range bounds (UTC ISO) for busy queries — pad start to catch bookings that
  // begin before the range but spill into it.
  const rangeStartMs = candidates[0].startUtc;
  const rangeEndMs = candidates[candidates.length - 1].endUtc;
  const lookbackMs = rangeStartMs - 24 * 3_600_000;
  const fromIso = new Date(lookbackMs).toISOString();
  const toIso = new Date(rangeEndMs).toISOString();

  // Busy = calendar free/busy + this member's own confirmed bookings.
  // Member-aware: union every selected calendar across the member's connections
  // (memberBusy) and filter own bookings to the member. Legacy: global provider
  // free/busy + all confirmed bookings (unchanged behavior).
  let calendarBusy: Interval[];
  if (memberAware) {
    const rc = await getMemberCalendar(params.memberId!);
    calendarBusy = await memberBusyForMember(
      params.memberId!,
      rc,
      fromIso,
      toIso,
    ).catch(() => [] as Interval[]);
  } else {
    const { provider, calendarId } = await getCalendarProvider();
    calendarBusy = await provider
      .getBusy(calendarId, fromIso, toIso)
      .catch(() => [] as Interval[]);
  }

  const [ownBusy, dayCounts] = await Promise.all([
    loadOwnBusy(fromIso, toIso, ownBusyMemberId),
    eventType.dailyBookingLimit
      ? loadDayCounts(fromIso, toIso, scheduleZone, ownBusyMemberId)
      : Promise.resolve(new Map<string, number>()),
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
    memberId: memberAware ? params.memberId : undefined,
    timezone: inviteeTz,
    durationMinutes: eventType.durationMinutes,
    days: outDays,
  };
}

/**
 * Cheap per-provider probe for the provider-pick step: the first day with ≥1
 * open slot for `memberId`, plus that day's slot count. Scans in chunks and
 * early-exits on the first hit so a wide-open provider costs one freebusy call.
 * Errors are swallowed into `hasAvailability:false` so one bad calendar never
 * dead-ends the whole provider list.
 */
export async function nextAvailableForMember(
  eventType: EventType,
  memberId: string,
  tz: string,
  nowUtc?: number,
): Promise<NextAvailableProvider> {
  const now = nowUtc ?? Date.now();
  const none: NextAvailableProvider = {
    memberId,
    nextDate: null,
    nextSlotIso: null,
    slotCountThatDay: 0,
    hasAvailability: false,
  };

  try {
    const horizonDays = Math.min(eventType.maxDaysInFuture, 60);
    const start = DateTime.fromMillis(now, { zone: tz }).startOf('day');
    const CHUNK = 14;
    for (let offset = 0; offset <= horizonDays; offset += CHUNK) {
      const fromDt = start.plus({ days: offset });
      const toDt = start.plus({ days: Math.min(offset + CHUNK - 1, horizonDays) });
      const avail = await computeAvailability({
        eventType,
        memberId,
        fromDate: fromDt.toFormat('yyyy-MM-dd'),
        toDate: toDt.toFormat('yyyy-MM-dd'),
        inviteeTz: tz,
        nowUtc: now,
      });
      const firstDay = avail.days.find((d) => d.slots.length > 0);
      if (firstDay) {
        return {
          memberId,
          nextDate: firstDay.date,
          nextSlotIso: firstDay.slots[0],
          slotCountThatDay: firstDay.slots.length,
          hasAvailability: true,
        };
      }
    }
    return none;
  } catch {
    return none;
  }
}

/**
 * Confirmed bookings overlapping [fromIso, toIso) as busy intervals. When
 * `memberId` is non-null we keep ONLY that member's bookings (legacy docs with
 * no memberId resolve to the owner). The query stays `(status, startUtc)` and we
 * filter member in memory — this avoids requiring a new composite index and
 * tolerates not-yet-backfilled legacy docs during the rollout window.
 */
async function loadOwnBusy(
  fromIso: string,
  toIso: string,
  memberId: string | null,
): Promise<Interval[]> {
  const q = await db
    .collection(COL.bookings)
    .where('status', '==', 'confirmed')
    .where('startUtc', '>=', fromIso)
    .where('startUtc', '<', toIso)
    .get();
  const out: Interval[] = [];
  for (const d of q.docs) {
    const b = d.data() as Booking;
    if (memberId !== null && (b.memberId ?? DEFAULT_MEMBER_ID) !== memberId) continue;
    out.push({
      start: DateTime.fromISO(b.startUtc).toMillis(),
      end: DateTime.fromISO(b.endUtc).toMillis(),
    });
  }
  return out;
}

/** Count confirmed bookings per schedule-tz day, for the daily cap. Filtered to
 * `memberId` (in memory) when supplied so the cap is per-provider-per-day. */
async function loadDayCounts(
  fromIso: string,
  toIso: string,
  zone: string,
  memberId: string | null,
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
    if (memberId !== null && (b.memberId ?? DEFAULT_MEMBER_ID) !== memberId) continue;
    const key = DateTime.fromISO(b.startUtc).setZone(zone).toFormat('yyyy-MM-dd');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
