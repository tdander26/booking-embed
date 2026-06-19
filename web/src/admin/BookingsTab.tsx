import { useEffect, useState } from 'react';
import { Video, Phone, MapPin, X } from 'lucide-react';
import * as api from '../api/client';
import type { AdminBooking } from '../api/types';
import { fmtFull } from '../lib/time';
import { Spinner, Banner, Card } from '../components/ui';

export function BookingsTab() {
  const [bookings, setBookings] = useState<AdminBooking[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const load = () => {
    setBookings(null);
    api
      .adminGetBookings()
      .then((r) => setBookings(r.bookings))
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const cancel = async (b: AdminBooking) => {
    if (!confirm(`Cancel ${b.invitee.name}'s booking?`)) return;
    try {
      await api.cancelBooking(b.id, b.cancelToken, 'Cancelled by host');
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (err) return <Banner kind="error">{err}</Banner>;
  if (!bookings) return <Spinner />;

  const visible = bookings.filter((b) => showCancelled || b.status === 'confirmed');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {visible.filter((b) => b.status === 'confirmed').length} upcoming
        </p>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          Show cancelled
        </label>
      </div>

      {visible.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">No bookings in range.</Card>
      ) : (
        visible.map((b) => (
          <Card key={b.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink">{b.invitee.name}</span>
                {b.status === 'cancelled' && (
                  <span className="rounded bg-overlay px-1.5 py-0.5 text-xs text-muted">
                    cancelled
                  </span>
                )}
                {b.status === 'confirmed' && b.googleSyncError && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">
                    ⚠ not on calendar
                  </span>
                )}
              </div>
              <div className="text-sm text-muted">{b.invitee.email}</div>
              <div className="mt-1 text-sm text-muted">
                {b.eventTypeName}
                {b.memberName ? ` · ${b.memberName}` : ''} · {fmtFull(b.startUtc, b.invitee.timezone)}
              </div>
              {b.invitee.notes && (
                <div className="mt-1 text-xs text-faint">“{b.invitee.notes}”</div>
              )}
            </div>
            <LocationBadge type={b.location.type} />
            {b.status === 'confirmed' && (
              <button
                onClick={() => cancel(b)}
                className="rounded-lg p-2 text-faint hover:bg-red-500/10 hover:text-red-400"
                aria-label="Cancel booking"
              >
                <X size={18} />
              </button>
            )}
          </Card>
        ))
      )}
    </div>
  );
}

function LocationBadge({ type }: { type: AdminBooking['location']['type'] }) {
  const icon =
    type === 'google_meet' ? <Video size={14} /> : type === 'phone' ? <Phone size={14} /> : <MapPin size={14} />;
  return <span className="shrink-0 text-faint">{icon}</span>;
}
