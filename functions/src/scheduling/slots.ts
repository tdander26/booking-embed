/**
 * Pure slot math. No Firestore, no I/O — everything here is deterministic and
 * works entirely in epoch milliseconds (UTC instants) so DST never enters a
 * comparison. The ONLY place wall-clock is touched is generating candidate
 * starts, where each window endpoint is built as a zone-anchored DateTime (DST
 * correct) and slots are stepped by EXACT minutes from that anchor.
 *
 * See functions/src/scheduling/slots reasoning:
 *  - Build window endpoints with DateTime.fromISO(`${day}T${HH:mm}`, {zone}) so
 *    the same clock time maps to the right instant on DST-transition days. (Do
 *    NOT add exact minutes to midnight — that overshoots by the DST offset.)
 *  - Step slots within a window with .plus({minutes}) (exact) — this skips a
 *    spring-forward gap automatically and yields two distinct instants across a
 *    fall-back hour. De-dupe by instant, never by wall-clock.
 */
import { DateTime } from 'luxon';

export interface Slot {
  startUtc: number; // epoch millis, half-open [startUtc, endUtc)
  endUtc: number;
}

export interface Interval {
  start: number; // epoch millis, half-open
  end: number;
}

export interface Window {
  start: string; // "HH:mm" in the schedule's timezone
  end: string; // "HH:mm" (or "24:00" for next-day midnight)
}

/** Half-open interval intersection test. */
export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Resolve a window endpoint ("HH:mm" / "24:00") to a zone-anchored instant. */
function wallInstant(dayISO: string, hm: string, zone: string): DateTime | null {
  if (hm === '24:00') {
    // Variable-length day arithmetic keeps this at true next-day midnight.
    const dt = DateTime.fromISO(`${dayISO}T00:00`, { zone }).plus({ days: 1 });
    return dt.isValid ? dt : null;
  }
  const dt = DateTime.fromISO(`${dayISO}T${hm}`, { zone });
  return dt.isValid ? dt : null;
}

/**
 * Generate candidate slots for a single calendar day, given that day's windows
 * expressed in `scheduleZone`. Returns UTC instants. Does NOT apply busy times,
 * buffers, or notice limits — that's `filterSlots`.
 */
export function slotsForDay(params: {
  dayISO: string; // "yyyy-MM-dd" in scheduleZone
  scheduleZone: string;
  windows: Window[];
  stepMin: number;
  durationMin: number;
}): Slot[] {
  const { dayISO, scheduleZone, windows, stepMin, durationMin } = params;
  const out: Slot[] = [];
  const seen = new Set<number>();
  if (stepMin <= 0 || durationMin <= 0) return out;

  for (const w of windows) {
    const winStart = wallInstant(dayISO, w.start, scheduleZone);
    const winEnd = wallInstant(dayISO, w.end, scheduleZone);
    if (!winStart || !winEnd || winEnd <= winStart) continue;

    let cursor = winStart;
    let guard = 0;
    // The slot must fully fit inside the window: cursor + duration <= winEnd.
    while (cursor.plus({ minutes: durationMin }) <= winEnd && guard++ < 100_000) {
      if (cursor.isValid) {
        const startUtc = cursor.toMillis();
        if (!seen.has(startUtc)) {
          seen.add(startUtc);
          out.push({
            startUtc,
            endUtc: cursor.plus({ minutes: durationMin }).toMillis(),
          });
        }
      }
      cursor = cursor.plus({ minutes: stepMin });
    }
  }
  out.sort((a, b) => a.startUtc - b.startUtc);
  return out;
}

/**
 * Remove slots that are unavailable: too soon (minNotice), too far out
 * (maxDays), or overlapping a busy interval. Buffers are applied by expanding
 * each BUSY interval — start - bufferBefore, end + bufferAfter — so an existing
 * event's after-buffer blocks the slot right after it (and the before-buffer
 * protects the slot just before it) WITHOUT double-counting between adjacent
 * events. All math is in epoch millis.
 */
export function filterSlots(
  slots: Slot[],
  busy: Interval[],
  opts: {
    bufferBeforeMin: number;
    bufferAfterMin: number;
    minNoticeMin: number;
    maxDaysOut: number;
    nowUtc: number;
  },
): Slot[] {
  const earliest = opts.nowUtc + opts.minNoticeMin * 60_000;
  const latest = opts.nowUtc + opts.maxDaysOut * 86_400_000;
  const padBefore = opts.bufferBeforeMin * 60_000;
  const padAfter = opts.bufferAfterMin * 60_000;
  const blocked = busy.map((b) => ({
    start: b.start - padBefore,
    end: b.end + padAfter,
  }));

  return slots.filter((s) => {
    if (s.startUtc < earliest) return false;
    if (s.startUtc > latest) return false;
    return !blocked.some((b) => overlaps(s.startUtc, s.endUtc, b.start, b.end));
  });
}

/**
 * Indices of the fixed time-grid cells covered by [startUtc, endUtc).
 * Two intervals overlap IFF they share a covered cell, so creating a lock doc
 * per covered cell inside a transaction prevents ALL overlaps — including
 * overlapping, different-start slots (e.g. 30-min meetings on a 15-min grid).
 */
export function coveredCells(
  startUtc: number,
  endUtc: number,
  gridMin: number,
): number[] {
  const g = gridMin * 60_000;
  const first = Math.floor(startUtc / g);
  const last = Math.floor((endUtc - 1) / g);
  const cells: number[] = [];
  for (let i = first; i <= last; i++) cells.push(i);
  return cells;
}
