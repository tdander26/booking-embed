import { DateTime } from 'luxon';
import { tenantDb } from '../firebase';
import {
  slotsForDay,
  filterSlots,
  type Slot,
  type Interval,
  type Window,
} from './slots';
import { getMemberCalendar, memberBusyForMember } from '../calendar/provider';
import { loadMember } from '../members';
import { ownerMemberId } from '../tenants';
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

export async function loadEventTypeById(
  tenantId: string,
  id: string,
): Promise<EventType | null> {
  const snap = await tenantDb(tenantId).eventTypes().doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as EventType) : null;
}

export async function loadEventTypeBySlug(
  tenantId: string,
  slug: string,
): Promise<EventType | null> {
  const q = await tenantDb(tenantId).eventTypes().where('slug', '==', slug).limit(1).get();
  if (q.empty) return null;
  const d = q.docs[0];
  return { id: d.id, ...d.data() } as EventType;
}

export async function loadSchedule(
  tenantId: string,
  id: string,
): Promise<AvailabilitySchedule> {
  const snap = await tenantDb(tenantId).schedules().doc(id).get();
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
 *  - the member's `defaultScheduleId`,
 *  - legacy fallback: `eventType.availabilityScheduleId` (single-provider docs).
 */
async function resolveSchedule(
  tenantId: string,
  eventType: EventType,
  member: Member | null,
): Promise<AvailabilitySchedule> {
  const scheduleId = member?.defaultScheduleId || eventType.availabilityScheduleId;
  if (!scheduleId) throw notFound('Availability schedule not found', 'no_schedule');
  return loadSchedule(tenantId, scheduleId);
}

/**
 * Tenant- and member-aware availability. We always resolve an effective member
 * (the requested `memberId`, or the tenant's owner for provider-less legacy
 * types), use that member's default schedule + their connected (selected)
 * calendars' busy times, and count only THAT member's own bookings as busy.
 */
export async function computeAvailability(params: {
  tenantId: string;
  eventType: EventType;
  memberId?: string;
  fromDate: string; // "yyyy-MM-dd" (invitee-facing range start)
  toDate: string; // "yyyy-MM-dd"
  inviteeTz: string;
  nowUtc?: number;
}): Promise<AvailabilityResponse> {
  const { tenantId, eventType, inviteeTz } = params;
  const now = params.nowUtc ?? Date.now();

  // Always resolve a concrete provider: explicit member, else the tenant owner.
  const effectiveMemberId = params.memberId ?? (await ownerMemberId(tenantId));
  const member = await loadMember(tenantId, effectiveMemberId);

  const schedule = await resolveSchedule(tenantId, eventType, member);
  const scheduleZone = schedule.timezone;

  const emptyResponse = (): AvailabilityResponse => ({
    eventTypeId: eventType.id,
    memberId: params.memberId,
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

  // Busy = calendar free/busy (union of the member's selected calendars across
  // their active connections) + this member's own confirmed bookings.
  const rc = await getMemberCalendar(tenantId, effectiveMemberId);
  const calendarBusy = await memberBusyForMember(
    tenantId,
    effectiveMemberId,
    rc,
    fromIso,
    toIso,
  ).catch(() => [] as Interval[]);

  const [ownBusy, dayCounts] = await Promise.all([
    loadOwnBusy(tenantId, fromIso, toIso, effectiveMemberId),
    eventType.dailyBookingLimit
      ? loadDayCounts(tenantId, fromIso, toIso, scheduleZone, effectiveMemberId)
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
    memberId: params.memberId,
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
  tenantId: string,
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
        tenantId,
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
 * Confirmed bookings for `memberId` overlapping [fromIso, toIso) as busy
 * intervals. The query stays `(status, startUtc)` and we filter member in
 * memory — avoids requiring a new composite index.
 */
async function loadOwnBusy(
  tenantId: string,
  fromIso: string,
  toIso: string,
  memberId: string,
): Promise<Interval[]> {
  const q = await tenantDb(tenantId)
    .bookings()
    .where('status', '==', 'confirmed')
    .where('startUtc', '>=', fromIso)
    .where('startUtc', '<', toIso)
    .get();
  const out: Interval[] = [];
  for (const d of q.docs) {
    const b = d.data() as Booking;
    if (b.memberId !== memberId) continue;
    out.push({
      start: DateTime.fromISO(b.startUtc).toMillis(),
      end: DateTime.fromISO(b.endUtc).toMillis(),
    });
  }
  return out;
}

/** Count confirmed bookings per schedule-tz day for `memberId`, for the daily cap. */
async function loadDayCounts(
  tenantId: string,
  fromIso: string,
  toIso: string,
  zone: string,
  memberId: string,
): Promise<Map<string, number>> {
  const q = await tenantDb(tenantId)
    .bookings()
    .where('status', '==', 'confirmed')
    .where('startUtc', '>=', fromIso)
    .where('startUtc', '<', toIso)
    .get();
  const counts = new Map<string, number>();
  for (const d of q.docs) {
    const b = d.data() as Booking;
    if (b.memberId !== memberId) continue;
    const key = DateTime.fromISO(b.startUtc).setZone(zone).toFormat('yyyy-MM-dd');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
