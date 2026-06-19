import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight, Clock, Globe } from 'lucide-react';
import * as api from '../api/client';
import type { PublicEventType, AvailabilityResponse } from '../api/types';
import { guessTimezone, timezoneOptions, fmtTime, zoneAbbrev } from '../lib/time';
import { Spinner, Banner } from '../components/ui';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Scheduler({
  eventType,
  defaultTz,
  onPick,
}: {
  eventType: PublicEventType;
  defaultTz?: string;
  onPick: (iso: string, tz: string) => void;
}) {
  const [tz, setTz] = useState<string>(guessTimezone() || defaultTz || 'UTC');
  const [monthAnchor, setMonthAnchor] = useState<DateTime>(
    DateTime.now().setZone(tz).startOf('month'),
  );
  const [avail, setAvail] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    const from = monthAnchor.startOf('month').toFormat('yyyy-MM-dd');
    const to = monthAnchor.endOf('month').toFormat('yyyy-MM-dd');
    api
      .getAvailability({ eventTypeId: eventType.id, from, to, tz })
      .then((res) => {
        if (!alive) return;
        setAvail(res);
        setSelectedDay(res.days.find((d) => d.slots.length > 0)?.date ?? null);
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [eventType.id, tz, monthAnchor]);

  const byDate = useMemo(() => {
    const m = new Map<string, string[]>();
    avail?.days.forEach((d) => m.set(d.date, d.slots));
    return m;
  }, [avail]);

  const todayStr = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
  const horizonStr = DateTime.now()
    .setZone(tz)
    .plus({ days: eventType.maxDaysInFuture })
    .toFormat('yyyy-MM-dd');

  const monthStart = monthAnchor.startOf('month');
  const gridStart = monthStart.minus({ days: monthStart.weekday % 7 });
  const cells = Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }));

  const canPrev = monthStart > DateTime.now().setZone(tz).startOf('month');
  const canNext =
    monthStart.endOf('month') <
    DateTime.now().setZone(tz).plus({ days: eventType.maxDaysInFuture });

  const daySlots = selectedDay ? (byDate.get(selectedDay) ?? []) : [];

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Clock size={15} className="text-brand" />
        <h2 className="font-display text-xl font-semibold text-ink">{eventType.name}</h2>
        <span className="text-sm text-faint">· {eventType.durationMinutes} min</span>
      </div>
      {eventType.description && <p className="mb-5 text-sm text-muted">{eventType.description}</p>}

      {err && <Banner kind="error">{err}</Banner>}

      <div className="grid gap-7 sm:grid-cols-[1fr_minmax(160px,210px)]">
        {/* Calendar */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <button
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => setMonthAnchor((m) => m.minus({ months: 1 }))}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-white/5 hover:text-brand disabled:opacity-25 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="font-display text-base font-semibold text-ink">
              {monthStart.toFormat('MMMM yyyy')}
            </div>
            <button
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => setMonthAnchor((m) => m.plus({ months: 1 }))}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-white/5 hover:text-brand disabled:opacity-25 disabled:hover:bg-transparent"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="grid grid-cols-7 text-center text-[11px] font-medium uppercase tracking-wider text-faint">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>

          {loading ? (
            <Spinner />
          ) : (
            <div className="grid grid-cols-7 gap-1">
              {cells.map((c) => {
                const ds = c.toFormat('yyyy-MM-dd');
                const inMonth = c.month === monthStart.month;
                const hasSlots = (byDate.get(ds)?.length ?? 0) > 0;
                const isOutOfRange = ds < todayStr || ds > horizonStr;
                const isSelected = ds === selectedDay;
                const selectable = inMonth && hasSlots && !isOutOfRange;
                return (
                  <button
                    key={ds}
                    disabled={!selectable}
                    onClick={() => setSelectedDay(ds)}
                    className={[
                      'relative flex aspect-square items-center justify-center rounded-lg text-sm transition-all duration-150',
                      !inMonth ? 'text-faint/40' : '',
                      selectable
                        ? 'font-semibold text-ink hover:bg-white/[0.06] hover:ring-1 hover:ring-brand/40'
                        : 'text-faint/50',
                      isSelected
                        ? '!text-brand-fg shadow-gold-glow [background:linear-gradient(135deg,var(--brand-light),var(--brand-dark))]'
                        : '',
                    ].join(' ')}
                  >
                    {c.day}
                    {selectable && !isSelected && (
                      <span className="absolute bottom-1 h-1 w-1 rounded-full bg-brand" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <label className="mt-5 flex items-center gap-2 text-xs text-muted">
            <Globe size={14} className="text-brand" />
            <select
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              className="max-w-full rounded-lg border border-hair-soft bg-surface-2 px-2 py-1.5 text-xs text-ink focus:border-brand/60 focus:outline-none"
            >
              {timezoneOptions().map((z) => (
                <option key={z} value={z} className="bg-surface-2 text-ink">
                  {z.replace(/_/g, ' ')} ({zoneAbbrev(z)})
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Time slots */}
        <div className="min-w-0">
          <div className="mb-3 text-sm font-semibold text-ink">
            {selectedDay
              ? DateTime.fromISO(selectedDay).toFormat('cccc, LLL d')
              : 'Select a day'}
          </div>
          {loading ? null : selectedDay && daySlots.length === 0 ? (
            <p className="text-sm text-faint">No times available.</p>
          ) : !selectedDay ? (
            <p className="text-sm text-faint">Pick a highlighted day to see available times.</p>
          ) : (
            <div className="slot-scroll flex max-h-[340px] flex-col gap-2 overflow-y-auto pr-1">
              {daySlots.map((iso) => (
                <button
                  key={iso}
                  onClick={() => onPick(iso, tz)}
                  className="rounded-xl border border-hair-soft bg-surface-2 py-3 text-sm font-semibold tracking-wide text-ink transition-all duration-150 hover:-translate-y-0.5 hover:border-brand hover:text-brand hover:shadow-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {fmtTime(iso, tz)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
