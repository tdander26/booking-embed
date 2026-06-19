import { useEffect } from 'react';
import { Check, Video, CalendarPlus, Download } from 'lucide-react';
import type { BookingConfirmation, LocationType } from '../api/types';
import { fmtFull } from '../lib/time';
import { postScheduled } from '../lib/embed';
import { googleCalUrl, icsDataUrl } from '../lib/calendarLinks';
import { Button } from '../components/ui';

function locationText(loc: BookingConfirmation['location']): string {
  switch (loc.type as LocationType) {
    case 'google_meet':
      return loc.meetUrl ? 'Google Meet' : 'Google Meet (link in your email)';
    case 'phone':
      return loc.details ? `Phone: ${loc.details}` : 'Phone call';
    case 'in_person':
      return loc.details ? loc.details : 'In person';
    default:
      return loc.details ?? '';
  }
}

export function Confirmed({ confirmation }: { confirmation: BookingConfirmation }) {
  useEffect(() => {
    postScheduled(confirmation.bookingId, confirmation.startUtc);
  }, [confirmation.bookingId, confirmation.startUtc]);

  const calEvent = {
    title: `${confirmation.eventTypeName} with ${confirmation.displayName}`,
    startUtc: confirmation.startUtc,
    endUtc: confirmation.endUtc,
    location: confirmation.location.meetUrl ?? confirmation.location.details,
    details: confirmation.location.meetUrl
      ? `Join: ${confirmation.location.meetUrl}`
      : undefined,
    uid: confirmation.bookingId,
  };

  return (
    <div className="text-center">
      <div className="animate-pop mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full text-brand-fg shadow-gold-glow [background:linear-gradient(135deg,var(--brand-light),var(--brand-dark))]">
        <Check size={30} strokeWidth={3} />
      </div>
      <h2 className="font-display text-2xl font-semibold text-ink">You're booked</h2>
      <p className="mt-1.5 text-sm text-muted">A confirmation is on its way to your inbox.</p>

      <div className="mx-auto mt-6 max-w-sm rounded-xl border border-hair-soft bg-surface-2 p-4 text-left text-sm">
        <div className="font-display text-base font-semibold text-ink">
          {confirmation.eventTypeName}
        </div>
        <div className="mt-1 text-muted">{fmtFull(confirmation.startUtc, confirmation.timezone)}</div>
        <div className="mt-1 text-faint">{locationText(confirmation.location)}</div>
      </div>

      {confirmation.location.type === 'google_meet' && confirmation.location.meetUrl && (
        <a
          href={confirmation.location.meetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex min-h-[46px] items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold text-brand-fg shadow-gold-glow transition hover:-translate-y-0.5 [background:linear-gradient(100deg,var(--brand-light),var(--brand)_55%,var(--brand-dark))]"
        >
          <Video size={16} /> Join Google Meet
        </a>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <a href={googleCalUrl(calEvent)} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" type="button">
            <CalendarPlus size={16} /> Google Calendar
          </Button>
        </a>
        <a href={icsDataUrl(calEvent)} download="appointment.ics">
          <Button variant="outline" type="button">
            <Download size={16} /> Apple / Outlook
          </Button>
        </a>
      </div>
    </div>
  );
}
