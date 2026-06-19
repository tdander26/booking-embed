import { useMemo, useState } from 'react';
import { Calendar } from 'lucide-react';
import * as api from '../api/client';
import { ApiError } from '../api/client';
import { fmtFull } from '../lib/time';
import { Button, Field, Banner, inputClass } from '../components/ui';
import type {
  PublicEventType,
  PublicProvider,
  BookingConfirmation,
  AnswerValue,
} from '../api/types';
import { QuestionField, emptyAnswer, validateAnswer, formatPhone } from './QuestionField';

export function DetailsForm({
  eventType,
  provider,
  slot,
  embedded,
  onDone,
}: {
  eventType: PublicEventType;
  provider: PublicProvider | null;
  slot: { iso: string; tz: string };
  embedded: boolean;
  onDone: (c: BookingConfirmation) => void;
}) {
  const questions = useMemo(
    () => [...eventType.questions].sort((a, b) => a.sortOrder - b.sortOrder),
    [eventType.questions],
  );
  const hasQuestions = questions.length > 0;
  // Legacy free-text notes box only when there are no custom questions.
  const showNotes = eventType.collectNotes && !hasQuestions;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(() => {
    const init: Record<string, AnswerValue> = {};
    questions.forEach((q) => {
      init[q.id] = emptyAnswer(q);
    });
    return init;
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setAnswer = (id: string, v: AnswerValue) => {
    setAnswers((a) => ({ ...a, [id]: v }));
    setFieldErrors((fe) => {
      if (!fe[id]) return fe;
      const { [id]: _drop, ...rest } = fe;
      return rest;
    });
  };

  const validate = (): boolean => {
    const fe: Record<string, string> = {};
    if (!firstName.trim()) fe.__first = 'Please enter your first name.';
    if (!lastName.trim()) fe.__last = 'Please enter your last name.';
    if (!email.trim()) fe.__email = 'Please enter your email.';
    for (const q of questions) {
      const msg = validateAnswer(q, answers[q.id] ?? emptyAnswer(q));
      if (msg) fe[q.id] = msg;
    }
    setFieldErrors(fe);
    return Object.keys(fe).length === 0;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const confirmation = await api.createBooking({
        eventTypeId: eventType.id,
        memberId: provider?.id,
        startUtc: slot.iso,
        timezone: slot.tz,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: eventType.collectPhone ? phone.trim() || undefined : undefined,
        notes: showNotes ? notes.trim() || undefined : undefined,
        answers: hasQuestions ? answers : undefined,
        source: embedded ? 'embed' : 'web',
      });
      onDone(confirmation);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === 'invalid_answers') {
        // Map server field errors back onto inline question errors.
        const details = (ae.details ?? {}) as Record<string, string>;
        const mapped: Record<string, string> = {};
        for (const [qid, reason] of Object.entries(details)) {
          mapped[qid] =
            reason === 'required'
              ? 'This field is required.'
              : reason === 'invalid_option'
                ? 'Please choose a valid option.'
                : reason === 'too_long'
                  ? 'This answer is too long.'
                  : 'Please check this field.';
        }
        setFieldErrors(mapped);
        setErr('Please fix the highlighted fields.');
      } else if (ae.code === 'slot_taken' || ae.code === 'slot_unavailable') {
        setErr('Sorry — that time was just taken. Please pick another.');
      } else {
        setErr(ae.message || 'Could not complete the booking.');
      }
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="flex items-start gap-3 rounded-xl border border-hair-soft bg-surface-2 p-4 text-sm">
        <Calendar size={18} className="mt-0.5 text-brand" />
        <div>
          <div className="font-display text-base font-semibold text-ink">{eventType.name}</div>
          {provider && <div className="text-sm text-muted">with {provider.name}</div>}
          <div className="text-muted">{fmtFull(slot.iso, slot.tz)}</div>
          <div className="text-xs text-faint">{eventType.durationMinutes} minutes</div>
        </div>
      </div>

      {err && <Banner kind="error">{err}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">
          <input
            className={inputClass}
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              setFieldErrors((fe) => ({ ...fe, __first: '' }));
            }}
            autoComplete="given-name"
          />
          {fieldErrors.__first && (
            <span className="mt-1 block text-xs text-red-300">{fieldErrors.__first}</span>
          )}
        </Field>
        <Field label="Last name">
          <input
            className={inputClass}
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              setFieldErrors((fe) => ({ ...fe, __last: '' }));
            }}
            autoComplete="family-name"
          />
          {fieldErrors.__last && (
            <span className="mt-1 block text-xs text-red-300">{fieldErrors.__last}</span>
          )}
        </Field>
      </div>
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setFieldErrors((fe) => ({ ...fe, __email: '' }));
          }}
          autoComplete="email"
        />
        {fieldErrors.__email && (
          <span className="mt-1 block text-xs text-red-300">{fieldErrors.__email}</span>
        )}
      </Field>
      {eventType.collectPhone && (
        <Field label="Phone" hint="For appointment reminders.">
          <input
            className={inputClass}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(555) 123-4567"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
          />
        </Field>
      )}

      {questions.map((q) => (
        <QuestionField
          key={q.id}
          question={q}
          value={answers[q.id] ?? emptyAnswer(q)}
          error={fieldErrors[q.id]}
          onChange={(v) => setAnswer(q.id, v)}
        />
      ))}

      {showNotes && (
        <Field label="Anything you'd like to share?" hint="Optional">
          <textarea
            className={`${inputClass} min-h-[84px] resize-y`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
          />
        </Field>
      )}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Booking…' : 'Confirm booking'}
      </Button>
    </form>
  );
}
