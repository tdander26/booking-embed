/**
 * Pure-logic tests for the scheduling core (no emulator / Java needed).
 * Run after building: `npm --prefix functions run build && node functions/scripts/test-slots.mjs`
 */
import { DateTime } from 'luxon';
import { slotsForDay, filterSlots, coveredCells, overlaps } from '../lib/scheduling/slots.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
function wallHour(ms, zone) {
  return DateTime.fromMillis(ms, { zone }).hour;
}

console.log('slotsForDay — normal day (UTC)');
{
  const slots = slotsForDay({
    dayISO: '2026-06-22',
    scheduleZone: 'UTC',
    windows: [{ start: '09:00', end: '17:00' }],
    stepMin: 30,
    durationMin: 30,
  });
  check('16 slots for 9–17 @30min', slots.length === 16, `got ${slots.length}`);
  check('first slot is 09:00Z', new Date(slots[0].startUtc).toISOString() === '2026-06-22T09:00:00.000Z');
  check('last slot ends by 17:00Z', new Date(slots[slots.length - 1].endUtc).toISOString() === '2026-06-22T17:00:00.000Z');
  check('strictly increasing', slots.every((s, i) => i === 0 || s.startUtc > slots[i - 1].startUtc));
}

console.log('slotsForDay — spring-forward (America/New_York 2026-03-08, 2am→3am)');
{
  const zone = 'America/New_York';
  const slots = slotsForDay({
    dayISO: '2026-03-08',
    scheduleZone: zone,
    windows: [{ start: '00:00', end: '06:00' }],
    stepMin: 60,
    durationMin: 60,
  });
  const hours = slots.map((s) => wallHour(s.startUtc, zone));
  check('no slot at the nonexistent 02:00 wall hour', !hours.includes(2), `hours=${hours}`);
  check('wall hours skip 2 → [0,1,3,4,5]', JSON.stringify(hours) === JSON.stringify([0, 1, 3, 4, 5]), `hours=${hours}`);
  check('instants evenly spaced 60min real', slots.every((s, i) => i === 0 || s.startUtc - slots[i - 1].startUtc === 3600000));
}

console.log('slotsForDay — fall-back (America/New_York 2026-11-01, 2am→1am, 1am twice)');
{
  const zone = 'America/New_York';
  const slots = slotsForDay({
    dayISO: '2026-11-01',
    scheduleZone: zone,
    windows: [{ start: '00:00', end: '03:00' }],
    stepMin: 60,
    durationMin: 60,
  });
  check('4 slots across the duplicated hour', slots.length === 4, `got ${slots.length}`);
  check('all instants distinct & increasing', slots.every((s, i) => i === 0 || s.startUtc > slots[i - 1].startUtc));
  const ones = slots.filter((s) => wallHour(s.startUtc, zone) === 1);
  check('two distinct slots both at wall 01:00', ones.length === 2 && ones[0].startUtc !== ones[1].startUtc);
}

console.log('coveredCells — overlap detection');
{
  const grid = 5;
  const ms = (iso) => new Date(iso).getTime();
  const A = { s: ms('2026-06-22T10:00:00Z'), e: ms('2026-06-22T10:30:00Z') };
  const B = { s: ms('2026-06-22T10:15:00Z'), e: ms('2026-06-22T10:45:00Z') }; // overlaps A
  const C = { s: ms('2026-06-22T10:30:00Z'), e: ms('2026-06-22T11:00:00Z') }; // back-to-back with A
  const cellsA = new Set(coveredCells(A.s, A.e, grid));
  const cellsB = coveredCells(B.s, B.e, grid);
  const cellsC = coveredCells(C.s, C.e, grid);
  check('overlapping intervals share ≥1 cell', cellsB.some((c) => cellsA.has(c)));
  check('back-to-back intervals share NO cell', !cellsC.some((c) => cellsA.has(c)));
  check('overlaps() agrees: A∩B', overlaps(A.s, A.e, B.s, B.e) === true);
  check('overlaps() agrees: A∩C false (half-open)', overlaps(A.s, A.e, C.s, C.e) === false);
}

console.log('coveredCells — 30-min meetings on a 15-min grid (overlapping starts)');
{
  const grid = 15;
  const ms = (iso) => new Date(iso).getTime();
  const A = { s: ms('2026-06-22T10:00:00Z'), e: ms('2026-06-22T10:30:00Z') };
  const B = { s: ms('2026-06-22T10:15:00Z'), e: ms('2026-06-22T10:45:00Z') }; // different start, overlaps
  const cellsA = new Set(coveredCells(A.s, A.e, grid));
  check('different-start overlap still collides on a cell', coveredCells(B.s, B.e, grid).some((c) => cellsA.has(c)));
}

console.log('filterSlots — notice / horizon / busy+buffer');
{
  const now = new Date('2026-06-22T08:00:00Z').getTime();
  const slots = slotsForDay({
    dayISO: '2026-06-22',
    scheduleZone: 'UTC',
    windows: [{ start: '08:00', end: '12:00' }],
    stepMin: 30,
    durationMin: 30,
  });
  // minNotice 120min => earliest bookable 10:00
  const noticed = filterSlots(slots, [], { bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 120, maxDaysOut: 60, nowUtc: now });
  check('minNotice drops slots before now+120m', noticed.every((s) => s.startUtc >= now + 120 * 60000));
  check('first remaining is 10:00Z', new Date(noticed[0].startUtc).toISOString() === '2026-06-22T10:00:00.000Z');

  // busy 10:00-10:30 with 15min after-buffer should also knock out the 10:30 slot
  const busy = [{ start: new Date('2026-06-22T10:00:00Z').getTime(), end: new Date('2026-06-22T10:30:00Z').getTime() }];
  const withBusy = filterSlots(slots, busy, { bufferBeforeMin: 0, bufferAfterMin: 15, minNoticeMin: 0, maxDaysOut: 60, nowUtc: now });
  const isoset = new Set(withBusy.map((s) => new Date(s.startUtc).toISOString()));
  check('busy 10:00 slot removed', !isoset.has('2026-06-22T10:00:00.000Z'));
  check('10:30 removed by 15m after-buffer overlap', !isoset.has('2026-06-22T10:30:00.000Z'));
  check('11:00 slot survives', isoset.has('2026-06-22T11:00:00.000Z'));
}

console.log('');
if (failures > 0) {
  console.log(`FAILED: ${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
