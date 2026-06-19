import { useState } from 'react';
import { Calendar } from 'lucide-react';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { fmtFull } from '../lib/time';
import { Button, Field, Banner, inputClass } from '../components/ui';
import type { PublicEventType, BookingConfirmation } from '../api/types';

export function DetailsForm({
  eventType,
  slot,
  embedded,
  onDone,
}: {
  eventType: PublicEventType;
  slot: { iso: string; tz: string };
  embedded: boolean;
  onDone: (c: BookingConfirmation) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!name.trim() || !email.trim()) {
      setErr('Please enter your name and email.');
      return;
    }
    setSubmitting(true);
    try {
      const confirmation = await api.createBooking({
        eventTypeId: eventType.id,
        startUtc: slot.iso,
        timezone: slot.tz,
        name: name.trim(),
        email: email.trim(),
        phone: eventType.collectPhone ? phone.trim() : undefined,
        notes: notes.trim() || undefined,
        source: embedded ? 'embed' : 'web',
      });
      onDone(confirmation);
    } catch (e) {
      const ae = e as ApiError;
      setErr(
        ae.code === 'slot_taken' || ae.code === 'slot_unavailable'
          ? 'Sorry — that time was just taken. Please pick another.'
          : ae.message || 'Could not complete the booking.',
      );
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-hair-soft bg-surface-2 p-4 text-sm">
        <Calendar size={18} className="mt-0.5 text-brand" />
        <div>
          <div className="font-display text-base font-semibold text-ink">{eventType.name}</div>
          <div className="text-muted">{fmtFull(slot.iso, slot.tz)}</div>
          <div className="text-xs text-faint">{eventType.durationMinutes} minutes</div>
        </div>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      <Field label="Name">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
      </Field>
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </Field>
      {eventType.collectPhone && (
        <Field label="Phone" hint="For appointment reminders.">
          <input
            className={inputClass}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
        </Field>
      )}
      <Field label="Anything you'd like to share?" hint="Optional">
        <textarea
          className={`${inputClass} min-h-[84px] resize-y`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
        />
      </Field>

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Booking…' : 'Confirm booking'}
      </Button>
    </form>
  );
}
