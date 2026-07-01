import { useEffect, useState } from 'react';
import { Check, X, Calendar, ArrowLeft } from 'lucide-react';
import * as api from '../api/client';
import type { ManageView, AvailabilityResponse } from '../api/types';
import { fmtFull } from '../lib/time';
import { applyBrand, applyTheme } from '../lib/brand';
import { Spinner, Banner, Button, Card } from '../components/ui';

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const fmtTime = (iso: string, tz: string): string =>
  new Date(iso).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const fmtDay = (dateStr: string, tz: string): string =>
  new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

export function ManageBooking() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('b') ?? '';
  const token = params.get('t') ?? '';

  const [view, setView] = useState<ManageView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Reschedule picker.
  const [rescheduling, setRescheduling] = useState(false);
  const [avail, setAvail] = useState<AvailabilityResponse | null>(null);
  const [availErr, setAvailErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !token) {
      setErr('This link is missing information.');
      return;
    }
    api
      .getManage(id, token)
      .then(setView)
      .catch((e) => setErr((e as Error).message));
  }, [id, token]);

  // Match the clinic's theme + accent on this page too.
  useEffect(() => {
    api
      .getBranding()
      .then((b) => {
        applyTheme(b.theme);
        applyBrand(b.brandColor);
      })
      .catch(() => undefined);
  }, []);

  const doCancel = async () => {
    setWorking(true);
    setErr(null);
    try {
      const updated = await api.cancelBooking(id, token);
      setView(updated);
      setConfirmCancel(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const startReschedule = async () => {
    if (!view) return;
    setRescheduling(true);
    setPicked(null);
    setAvail(null);
    setAvailErr(null);
    setErr(null);
    setFlash(null);
    try {
      const a = await api.getAvailability({
        eventTypeId: view.eventTypeId,
        memberId: view.memberId,
        from: ymd(new Date()),
        to: ymd(new Date(Date.now() + 45 * 86_400_000)),
        tz: view.timezone,
      });
      setAvail(a);
    } catch (e) {
      setAvailErr((e as Error).message);
    }
  };

  const doReschedule = async () => {
    if (!picked) return;
    setWorking(true);
    setErr(null);
    try {
      const updated = await api.rescheduleBooking(id, token, picked);
      setView(updated);
      setRescheduling(false);
      setPicked(null);
      setAvail(null);
      setFlash('Your appointment was rescheduled — a confirmation email is on its way.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const daysWithSlots = (avail?.days ?? []).filter((d) => d.slots.length > 0);

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <Card className="p-7">
        <h1 className="mb-5 font-display text-xl font-semibold text-ink">Your appointment</h1>
        {err && <Banner kind="error">{err}</Banner>}
        {flash && <Banner kind="success">{flash}</Banner>}
        {!view && !err && <Spinner />}
        {view && (
          <>
            <div className="flex items-start gap-3 rounded-xl border border-hair-soft bg-surface-2 p-4 text-sm">
              <Calendar size={18} className="mt-0.5 text-brand" />
              <div>
                <div className="font-display text-base font-semibold text-ink">{view.eventTypeName}</div>
                {view.providerName && <div className="text-muted">with {view.providerName}</div>}
                <div className="text-muted">{fmtFull(view.startUtc, view.timezone)}</div>
                <div className="text-xs text-faint">{view.durationMinutes} minutes</div>
              </div>
            </div>

            {view.status === 'cancelled' ? (
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-overlay px-3 py-2 text-sm text-muted">
                <X size={16} /> This appointment was cancelled.
              </div>
            ) : rescheduling ? (
              picked ? (
                <div className="mt-5 space-y-3">
                  <p className="text-sm text-muted">Move your appointment to:</p>
                  <div className="rounded-lg border border-hair-soft bg-surface-2 p-3 text-sm font-medium text-ink">
                    {fmtFull(picked, view.timezone)}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={doReschedule} disabled={working}>
                      {working ? 'Rescheduling…' : 'Confirm new time'}
                    </Button>
                    <Button variant="ghost" onClick={() => setPicked(null)}>
                      Back
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setRescheduling(false)}
                      className="inline-flex items-center gap-1 text-sm text-muted transition hover:text-brand"
                    >
                      <ArrowLeft size={15} /> Back
                    </button>
                    <span className="text-sm font-medium text-ink">Pick a new time</span>
                  </div>
                  {availErr && <Banner kind="error">{availErr}</Banner>}
                  {!avail && !availErr && <Spinner />}
                  {avail && daysWithSlots.length === 0 && (
                    <p className="text-sm text-muted">No open times right now — please call the office.</p>
                  )}
                  <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
                    {daysWithSlots.map((d) => (
                      <div key={d.date}>
                        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">
                          {fmtDay(d.date, view.timezone)}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {d.slots.map((s) => (
                            <button
                              key={s}
                              onClick={() => setPicked(s)}
                              className="rounded-lg border border-hair-soft bg-surface-2 px-3 py-1.5 text-sm text-ink transition hover:border-brand hover:bg-brand hover:text-brand-fg"
                            >
                              {fmtTime(s, view.timezone)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            ) : confirmCancel ? (
              <div className="mt-5 space-y-3">
                <p className="text-sm text-muted">Are you sure you want to cancel this appointment?</p>
                <div className="flex gap-2">
                  <Button variant="danger" onClick={doCancel} disabled={working}>
                    {working ? 'Cancelling…' : 'Yes, cancel'}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-5 flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm text-brand">
                  <Check size={16} /> Confirmed
                </span>
                <span className="flex-1" />
                <Button variant="outline" onClick={startReschedule}>
                  Reschedule
                </Button>
                <Button variant="outline" onClick={() => setConfirmCancel(true)}>
                  Cancel
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
