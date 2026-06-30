import { useEffect, useState } from 'react';
import { Plus, Trash2, X, ExternalLink } from 'lucide-react';
import * as api from '../api/client';
import type { EventType, AvailabilitySchedule, Member, LocationType } from '../api/types';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';
import { QuestionBuilder, validateQuestions } from './QuestionBuilder';

function emptyEventType(scheduleId: string): EventType {
  return {
    id: '',
    slug: '',
    name: 'New event type',
    description: '',
    durationMinutes: 30,
    active: true,
    color: '#0f766e',
    location: { type: 'google_meet' },
    memberIds: [],
    questions: [],
    availabilityScheduleId: scheduleId,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 120,
    maxDaysInFuture: 60,
    slotIntervalMinutes: 30,
    dailyBookingLimit: null,
    collectPhone: false,
    remindersMinutesBefore: null, // inherit the practice default
    sortOrder: 0,
  };
}

function memberOrder(a: Member, b: Member): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

export function EventTypesTab() {
  const [types, setTypes] = useState<EventType[] | null>(null);
  const [schedules, setSchedules] = useState<AvailabilitySchedule[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [editing, setEditing] = useState<EventType | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api.adminGetEventTypes(), api.adminGetSchedules(), api.adminGetMembers()])
      .then(([t, s, m]) => {
        setTypes(t.eventTypes);
        setSchedules(s.schedules);
        setMembers([...m.members].sort(memberOrder));
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  // `override` carries any last-second edits the editor committed synchronously
  // (e.g. a custom reminder CSV), so a Save click can't race an async setEditing.
  const save = async (override?: EventType) => {
    const e = override ?? editing;
    if (!e) return;
    if (e.memberIds.length === 0) {
      setErr('Assign at least one provider to this event type.');
      return;
    }
    const qErr = validateQuestions(e.questions);
    if (qErr) {
      setErr(qErr);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (e.id) await api.adminUpdateEventType(e.id, e);
      else await api.adminCreateEventType(e);
      setEditing(null);
      load();
    } catch (err) {
      setErr((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this event type?')) return;
    await api.adminDeleteEventType(id);
    load();
  };

  if (err && !types) return <Banner kind="error">{err}</Banner>;
  if (!types) return <Spinner />;

  if (editing) {
    return (
      <EventTypeEditor
        value={editing}
        schedules={schedules}
        members={members}
        onChange={setEditing}
        onSave={save}
        onCancel={() => setEditing(null)}
        busy={busy}
        err={err}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          disabled={members.length === 0}
          onClick={() => setEditing(emptyEventType(schedules[0]?.id ?? ''))}
        >
          <Plus size={16} /> New event type
        </Button>
      </div>
      {members.length === 0 && (
        <Banner kind="error">Add a provider first (Providers tab).</Banner>
      )}
      {types.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">No event types yet.</Card>
      ) : (
        types.map((t) => (
          <Card key={t.id} className="flex items-center gap-3 p-4">
            <span className="h-8 w-1.5 rounded-full" style={{ background: t.color }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink">{t.name}</span>
                {!t.active && (
                  <span className="rounded bg-overlay px-1.5 py-0.5 text-xs text-muted">
                    inactive
                  </span>
                )}
              </div>
              <div className="text-sm text-muted">
                {t.durationMinutes} min · /{t.slug}
              </div>
            </div>
            <a
              href={`/?type=${encodeURIComponent(t.slug)}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg p-2 text-faint hover:bg-overlay hover:text-muted"
              aria-label="Preview"
            >
              <ExternalLink size={16} />
            </a>
            <Button variant="outline" onClick={() => setEditing(t)}>
              Edit
            </Button>
            <button
              onClick={() => remove(t.id)}
              className="rounded-lg p-2 text-faint hover:bg-red-500/10 hover:text-red-400"
              aria-label="Delete"
            >
              <Trash2 size={18} />
            </button>
          </Card>
        ))
      )}
    </div>
  );
}

function num(v: string, fallback: number): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function EventTypeEditor({
  value,
  schedules,
  members,
  onChange,
  onSave,
  onCancel,
  busy,
  err,
}: {
  value: EventType;
  schedules: AvailabilitySchedule[];
  members: Member[];
  onChange: (e: EventType) => void;
  onSave: (override?: EventType) => void;
  onCancel: () => void;
  busy: boolean;
  err: string | null;
}) {
  const set = (patch: Partial<EventType>) => onChange({ ...value, ...patch });
  // null/absent remindersMinutesBefore => this type inherits the practice default.
  const [reminders, setReminders] = useState(
    (value.remindersMinutesBefore ?? [1440, 60]).join(', '),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toggleMember = (id: string) => {
    const has = value.memberIds.includes(id);
    set({
      memberIds: has ? value.memberIds.filter((x) => x !== id) : [...value.memberIds, id],
    });
  };

  const parseReminders = (s: string) =>
    s
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .slice(0, 5);

  // Returns the event type with reminders applied, so the Save handler can use
  // the fresh value directly instead of racing the async onChange/setEditing.
  const commitReminders = (): EventType => {
    // In "use practice default" mode the value is null — never clobber it.
    if (value.remindersMinutesBefore == null) return value;
    const next = { ...value, remindersMinutesBefore: parseReminders(reminders) };
    onChange(next);
    return next;
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">
          {value.id ? 'Edit event type' : 'New event type'}
        </h2>
        <button onClick={onCancel} className="text-faint hover:text-muted">
          <X size={20} />
        </button>
      </div>
      {err && <Banner kind="error">{err}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputClass} value={value.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="URL slug" hint="Leave blank to auto-generate from the name.">
          <input className={inputClass} value={value.slug} onChange={(e) => set({ slug: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <input
              className={inputClass}
              value={value.description ?? ''}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field
            label="Providers"
            hint="Who offers this meeting type. At least one is required."
          >
            {members.length === 0 ? (
              <Banner kind="error">Add a provider first (Providers tab).</Banner>
            ) : (
              <div className="flex flex-wrap gap-2">
                {members.map((m) => {
                  const on = value.memberIds.includes(m.id);
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => toggleMember(m.id)}
                      className={[
                        'inline-flex min-h-[40px] items-center gap-2 rounded-xl border px-3 text-sm transition',
                        on
                          ? 'border-brand/60 bg-brand/10 text-brand-light'
                          : 'border-hair-soft text-muted hover:border-brand/40 hover:text-ink',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'inline-flex h-4 w-4 items-center justify-center rounded border text-[10px]',
                          on ? 'border-brand bg-brand text-brand-fg' : 'border-hair',
                        ].join(' ')}
                      >
                        {on ? '✓' : ''}
                      </span>
                      {m.name || m.email}
                      {!m.active && <span className="text-xs text-faint">(inactive)</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
        </div>

        <Field label="Duration (minutes)">
          <input
            type="number"
            className={inputClass}
            value={value.durationMinutes}
            onChange={(e) => set({ durationMinutes: num(e.target.value, 30) })}
          />
        </Field>
        <Field label="Slot interval (minutes)" hint="Spacing between offered start times.">
          <input
            type="number"
            className={inputClass}
            value={value.slotIntervalMinutes}
            onChange={(e) => set({ slotIntervalMinutes: num(e.target.value, 30) })}
          />
        </Field>

        <Field label="Location">
          <select
            className={inputClass}
            value={value.location.type}
            onChange={(e) =>
              set({ location: { ...value.location, type: e.target.value as LocationType } })
            }
          >
            <option value="google_meet">Google Meet</option>
            <option value="phone">Phone</option>
            <option value="in_person">In person</option>
            <option value="custom">Custom</option>
          </select>
        </Field>
        <Field label="Location details" hint="Phone number, address, or instructions.">
          <input
            className={inputClass}
            value={value.location.details ?? ''}
            onChange={(e) => set({ location: { ...value.location, details: e.target.value } })}
          />
        </Field>

        <Field label="Color">
          <input
            type="color"
            className="h-11 w-full rounded-lg border border-hair-soft"
            value={value.color}
            onChange={(e) => set({ color: e.target.value })}
          />
        </Field>

        <Field label="Buffer before (min)">
          <input
            type="number"
            className={inputClass}
            value={value.bufferBeforeMinutes}
            onChange={(e) => set({ bufferBeforeMinutes: num(e.target.value, 0) })}
          />
        </Field>
        <Field label="Buffer after (min)">
          <input
            type="number"
            className={inputClass}
            value={value.bufferAfterMinutes}
            onChange={(e) => set({ bufferAfterMinutes: num(e.target.value, 0) })}
          />
        </Field>

        <Field label="Minimum notice (min)" hint="Earliest a booking can be made.">
          <input
            type="number"
            className={inputClass}
            value={value.minNoticeMinutes}
            onChange={(e) => set({ minNoticeMinutes: num(e.target.value, 0) })}
          />
        </Field>
        <Field label="Bookable window (days)">
          <input
            type="number"
            className={inputClass}
            value={value.maxDaysInFuture}
            onChange={(e) => set({ maxDaysInFuture: num(e.target.value, 60) })}
          />
        </Field>

        <Field label="Reminders" hint="Reminder emails sent before the appointment.">
          <select
            className={inputClass}
            value={value.remindersMinutesBefore == null ? 'default' : 'custom'}
            onChange={(e) => {
              if (e.target.value === 'default') {
                set({ remindersMinutesBefore: null });
              } else {
                const parsed = parseReminders(reminders);
                if (parsed.length === 0) setReminders('1440, 60');
                set({ remindersMinutesBefore: parsed.length ? parsed : [1440, 60] });
              }
            }}
          >
            <option value="default">Use practice default</option>
            <option value="custom">Custom…</option>
          </select>
        </Field>
        {value.remindersMinutesBefore != null && (
          <Field
            label="Custom reminders (minutes before)"
            hint="Comma-separated, e.g. 1440, 60. Leave blank for no reminders."
          >
            <input
              className={inputClass}
              value={reminders}
              onChange={(e) => setReminders(e.target.value)}
              onBlur={commitReminders}
            />
          </Field>
        )}
        <Field label="Daily booking limit" hint="Blank = unlimited.">
          <input
            type="number"
            className={inputClass}
            value={value.dailyBookingLimit ?? ''}
            onChange={(e) =>
              set({ dailyBookingLimit: e.target.value === '' ? null : num(e.target.value, 0) || null })
            }
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={value.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          Active (visible on booking page)
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={value.collectPhone}
            onChange={(e) => set({ collectPhone: e.target.checked })}
          />
          Collect phone number
        </label>
      </div>

      <div className="mt-6">
        <QuestionBuilder
          questions={value.questions}
          onChange={(questions) => set({ questions })}
        />
      </div>

      <div className="mt-5 rounded-xl border border-hair-soft bg-surface-2/40">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-muted hover:text-ink"
        >
          <span>Advanced · legacy availability schedule</span>
          <span className="text-faint">{showAdvanced ? '−' : '+'}</span>
        </button>
        {showAdvanced && (
          <div className="border-t border-hair-soft p-4">
            <p className="mb-3 text-xs text-faint">
              Kept for back-compat. Availability is driven by the assigned providers' schedules;
              this single schedule is used only by legacy single-provider logic until fully
              migrated.
            </p>
            <Field label="Availability schedule">
              <select
                className={inputClass}
                value={value.availabilityScheduleId ?? ''}
                onChange={(e) => set({ availabilityScheduleId: e.target.value || undefined })}
              >
                <option value="">— None —</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </div>

      <div className="mt-5 flex gap-2">
        <Button onClick={() => onSave(commitReminders())} disabled={busy}>
          {busy ? 'Saving…' : 'Save event type'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
