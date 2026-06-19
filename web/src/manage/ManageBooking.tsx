import { useEffect, useState } from 'react';
import { Check, X, Calendar } from 'lucide-react';
import * as api from '../api/client';
import type { ManageView } from '../api/types';
import { fmtFull } from '../lib/time';
import { applyBrand, applyTheme } from '../lib/brand';
import { Spinner, Banner, Button, Card } from '../components/ui';

export function ManageBooking() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('b') ?? '';
  const token = params.get('t') ?? '';

  const [view, setView] = useState<ManageView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

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

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <Card className="p-7">
        <h1 className="mb-5 font-display text-xl font-semibold text-ink">Your appointment</h1>
        {err && <Banner kind="error">{err}</Banner>}
        {!view && !err && <Spinner />}
        {view && (
          <>
            <div className="flex items-start gap-3 rounded-xl border border-hair-soft bg-surface-2 p-4 text-sm">
              <Calendar size={18} className="mt-0.5 text-brand" />
              <div>
                <div className="font-display text-base font-semibold text-ink">{view.eventTypeName}</div>
                <div className="text-muted">{fmtFull(view.startUtc, view.timezone)}</div>
                <div className="text-xs text-faint">{view.durationMinutes} minutes</div>
              </div>
            </div>

            {view.status === 'cancelled' ? (
              <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-overlay px-3 py-2 text-sm text-muted">
                <X size={16} /> This appointment was cancelled.
              </div>
            ) : confirmCancel ? (
              <div className="mt-5 space-y-3">
                <p className="text-sm text-muted">
                  Are you sure you want to cancel this appointment?
                </p>
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
