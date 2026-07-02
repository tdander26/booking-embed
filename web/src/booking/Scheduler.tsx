import { useEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight, Clock, Globe, CalendarX, ArrowRight } from 'lucide-react';
import * as api from '../api/client';
import type { PublicEventType, PublicProvider, AvailabilityResponse } from '../api/types';
import { timezoneOptions, fmtTime, zoneAbbrev } from '../lib/time';
import { Spinner, Banner, Button } from '../components/ui';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Scheduler({
  eventType,
  provider,
  tz,
  onTzChange,
  onPick,
  onSwitchProvider,
  onBackToTypes,
  exhausted,
  onExhausted,
}: {
  eventType: PublicEventType;
  provider: PublicProvider | null;
  /** Lifted to BookingApp so it persists across provider switches. */
  tz: string;
  onTzChange: (tz: string) => void;
  onPick: (iso: string, tz: string) => void;
  /** When this provider has no openings, jump to another provider. */
  onSwitchProvider?: (p: PublicProvider) => void;
  /** Fallback escape hatch when there's nowhere else to switch. */
  onBackToTypes?: () => void;
  /** Provider ids already found fully-booked (prevents A→B→A ping-pong). */
  exhausted?: Set<string>;
  onExhausted?: (memberId: string) => void;
}) {
  const [monthAnchor, setMonthAnchor] = useState<DateTime>(
    DateTime.now().setZone(tz).startOf('month'),
  );
  const [avail, setAvail] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Tracks whether we have *ever* seen a slot for this provider across month
  // navigation, so we only show the no-dead-end panel when truly empty.
  const everHadSlots = useRef(false);
  // While true, the calendar auto-walks forward to the first month that has any
  // openings, so the user lands on real availability instead of a blank month.
  // Cleared once a month with slots is found, the horizon is reached, or the user
  // navigates manually.
  const seeking = useRef(true);

  // On provider change: reset the seek state AND jump the calendar back to the
  // current month, so a switched-in provider is evaluated from their earliest
  // month instead of inheriting the previous provider's far-future page.
  useEffect(() => {
    everHadSlots.current = false;
    seeking.current = true;
    setSelectedDay(null);
    setMonthAnchor(DateTime.now().setZone(tz).startOf('month'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    const from = monthAnchor.startOf('month').toFormat('yyyy-MM-dd');
    const to = monthAnchor.endOf('month').toFormat('yyyy-MM-dd');
    api
      .getAvailability({ eventTypeId: eventType.id, memberId: provider?.id, from, to, tz })
      .then((res) => {
        if (!alive) return;
        setAvail(res);
        const firstWithSlots = res.days.find((d) => d.slots.length > 0)?.date ?? null;
        if (firstWithSlots) {
          everHadSlots.current = true;
          setSelectedDay(firstWithSlots);
          seeking.current = false; // landed on real availability
        } else {
          setSelectedDay(null);
          // Empty month: while still seeking, walk forward to the next month
          // (bounded by the bookable horizon) so we surface the first opening.
          const horizonMonth = DateTime.now()
            .setZone(tz)
            .plus({ days: eventType.maxDaysInFuture })
            .startOf('month');
          if (seeking.current && monthAnchor.startOf('month') < horizonMonth) {
            setMonthAnchor((m) => m.plus({ months: 1 }));
          } else {
            seeking.current = false;
          }
        }
      })
      .catch((e) => alive && setErr((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [eventType.id, provider?.id, tz, monthAnchor]);

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

  // No-dead-end: we've scanned to the end of the horizon, this month has no
  // slots, and we never saw any slots for this provider in the whole window.
  const monthHasSlots = (avail?.days ?? []).some((d) => d.slots.length > 0);
  const showNoAvail =
    !loading &&
    !err &&
    provider != null &&
    !monthHasSlots &&
    !everHadSlots.current &&
    !canNext; // reached the end of the bookable window

  // Only offer to switch to a provider we haven't ALREADY shown as full — else
  // two full providers would ping-pong A→B→A forever.
  const otherProviders = eventType.providers.filter((p) => p.id !== provider?.id);
  const switchTarget = otherProviders.find((p) => !(exhausted?.has(p.id) ?? false));

  // Remember this provider is full so the parent (and the switch logic) skip it.
  useEffect(() => {
    if (showNoAvail && provider) onExhausted?.(provider.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNoAvail, provider?.id]);

  if (showNoAvail) {
    return (
      <div>
        <SchedulerHeader eventType={eventType} provider={provider} />
        <div className="mt-4 flex flex-col items-center gap-4 rounded-xl border border-hair-soft bg-surface-2 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-overlay-soft text-faint">
            <CalendarX size={22} />
          </div>
          <div>
            <div className="font-display text-base font-semibold text-ink">
              {provider?.name} has no openings in this window.
            </div>
            <p className="mt-1 text-sm text-muted">
              {switchTarget
                ? `${switchTarget.name} may have earlier availability.`
                : 'Please check back soon for new times.'}
            </p>
          </div>
          {switchTarget && onSwitchProvider ? (
            <Button type="button" onClick={() => onSwitchProvider(switchTarget)}>
              See {switchTarget.name}'s availability <ArrowRight size={16} />
            </Button>
          ) : (
            onBackToTypes && (
              <Button variant="outline" type="button" onClick={onBackToTypes}>
                Back to meeting types
              </Button>
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <SchedulerHeader eventType={eventType} provider={provider} />

      {err && <Banner kind="error">{err}</Banner>}

      <div className="grid gap-7 sm:grid-cols-[1fr_minmax(160px,210px)]">
        {/* Calendar */}
        <div>
          <div className="mb-3 flex items-center justify-between">
            <button
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => {
                seeking.current = false;
                setMonthAnchor((m) => m.minus({ months: 1 }));
              }}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-overlay hover:text-brand disabled:opacity-25 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="font-display text-base font-semibold text-ink">
              {monthStart.toFormat('MMMM yyyy')}
            </div>
            <button
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => {
                seeking.current = false;
                setMonthAnchor((m) => m.plus({ months: 1 }));
              }}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-overlay hover:text-brand disabled:opacity-25 disabled:hover:bg-transparent"
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
                      selectable
                        ? 'font-semibold text-ink hover:bg-overlay hover:ring-1 hover:ring-brand/40'
                        : inMonth
                          ? 'text-faint opacity-40 cursor-not-allowed' // this month, no openings → grayed out
                          : 'text-faint opacity-20', // filler days from adjacent months
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
              onChange={(e) => onTzChange(e.target.value)}
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
            <div className="flex flex-col gap-2">
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

function SchedulerHeader({
  eventType,
  provider,
}: {
  eventType: PublicEventType;
  provider: PublicProvider | null;
}) {
  return (
    <>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Clock size={15} className="text-brand" />
        <h2 className="font-display text-xl font-semibold text-ink">{eventType.name}</h2>
        <span className="text-sm text-faint">· {eventType.durationMinutes} min</span>
        {provider && (
          <span className="text-sm text-muted">
            · with <span className="text-ink">{provider.name}</span>
          </span>
        )}
      </div>
      {eventType.description && <p className="mb-5 text-sm text-muted">{eventType.description}</p>}
    </>
  );
}
