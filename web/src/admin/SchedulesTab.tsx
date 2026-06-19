import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import * as api from '../api/client';
import type { AvailabilitySchedule, DayWindow, WeeklyRules, Member } from '../api/types';
import { guessTimezone, timezoneOptions } from '../lib/time';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function emptySchedule(memberId: string | null): AvailabilitySchedule {
  const weekday: DayWindow[] = [{ start: '09:00', end: '17:00' }];
  return {
    id: '',
    name: 'New schedule',
    timezone: guessTimezone(),
    weekly: { '1': weekday, '2': weekday, '3': weekday, '4': weekday, '5': weekday },
    overrides: [],
    memberId,
  };
}

export function SchedulesTab() {
  const [schedules, setSchedules] = useState<AvailabilitySchedule[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [editing, setEditing] = useState<AvailabilitySchedule | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api.adminGetSchedules(), api.adminGetMembers()])
      .then(([r, m]) => {
        setSchedules(r.schedules);
        setMembers(m.members);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const memberName = (id: string | null | undefined) =>
    id ? members.find((m) => m.id === id)?.name ?? id : null;

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: editing.name,
        timezone: editing.timezone,
        weekly: editing.weekly,
        overrides: editing.overrides,
        memberId: editing.memberId ?? null,
      };
      if (editing.id) await api.adminUpdateSchedule(editing.id, body);
      else await api.adminCreateSchedule(body);
      setEditing(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this schedule? Event types using it will break.')) return;
    await api.adminDeleteSchedule(id);
    load();
  };

  if (err && !schedules) return <Banner kind="error">{err}</Banner>;
  if (!schedules) return <Spinner />;

  if (editing) {
    return (
      <ScheduleEditor
        schedule={editing}
        members={members}
        onChange={setEditing}
        onSave={save}
        onCancel={() => setEditing(null)}
        busy={busy}
        err={err}
      />
    );
  }

  const visible =
    filter === 'all'
      ? schedules
      : filter === 'unassigned'
        ? schedules.filter((s) => !s.memberId)
        : schedules.filter((s) => s.memberId === filter);
  const defaultMemberId =
    filter !== 'all' && filter !== 'unassigned' ? filter : members[0]?.id ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-64">
          <Field label="Provider">
            <select
              className={inputClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All providers</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.email}
                </option>
              ))}
              <option value="unassigned">Unassigned (legacy)</option>
            </select>
          </Field>
        </div>
        <Button onClick={() => setEditing(emptySchedule(defaultMemberId))}>
          <Plus size={16} /> New schedule
        </Button>
      </div>
      {visible.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">
          No schedules yet. Create one to define weekly hours.
        </Card>
      ) : (
        visible.map((s) => {
          const owner = memberName(s.memberId);
          return (
            <Card key={s.id} className="flex items-center justify-between p-4">
              <div>
                <div className="font-semibold text-ink">{s.name}</div>
                <div className="text-sm text-muted">
                  {s.timezone.replace(/_/g, ' ')}
                  {owner ? ` · ${owner}` : ' · Unassigned (legacy)'}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(s)}>
                  Edit
                </Button>
                <button
                  onClick={() => remove(s.id)}
                  className="rounded-lg p-2 text-faint hover:bg-red-500/10 hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}

function ScheduleEditor({
  schedule,
  members,
  onChange,
  onSave,
  onCancel,
  busy,
  err,
}: {
  schedule: AvailabilitySchedule;
  members: Member[];
  onChange: (s: AvailabilitySchedule) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  err: string | null;
}) {
  const weekly: WeeklyRules = schedule.weekly ?? {};

  const setDay = (dow: number, windows: DayWindow[]) => {
    const next = { ...weekly, [String(dow)]: windows };
    if (windows.length === 0) delete next[String(dow)];
    onChange({ ...schedule, weekly: next });
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">
          {schedule.id ? 'Edit schedule' : 'New schedule'}
        </h2>
        <button onClick={onCancel} className="text-faint hover:text-muted">
          <X size={20} />
        </button>
      </div>
      {err && <Banner kind="error">{err}</Banner>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={schedule.name}
            onChange={(e) => onChange({ ...schedule, name: e.target.value })}
          />
        </Field>
        <Field label="Provider" hint="Whose availability this schedule defines.">
          <select
            className={inputClass}
            value={schedule.memberId ?? ''}
            onChange={(e) => onChange({ ...schedule, memberId: e.target.value || null })}
          >
            <option value="">Unassigned (legacy)</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timezone">
          <select
            className={inputClass}
            value={schedule.timezone}
            onChange={(e) => onChange({ ...schedule, timezone: e.target.value })}
          >
            {timezoneOptions().map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-5 space-y-2">
        {DAY_NAMES.map((name, dow) => (
          <DayRow
            key={dow}
            name={name}
            windows={weekly[String(dow)] ?? []}
            onChange={(w) => setDay(dow, w)}
          />
        ))}
      </div>

      <div className="mt-5 flex gap-2">
        <Button onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : 'Save schedule'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function DayRow({
  name,
  windows,
  onChange,
}: {
  name: string;
  windows: DayWindow[];
  onChange: (w: DayWindow[]) => void;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-hair-soft py-2">
      <div className="w-24 shrink-0 pt-2 text-sm font-medium text-muted">{name}</div>
      <div className="flex-1 space-y-2">
        {windows.length === 0 && <div className="pt-2 text-sm text-faint">Unavailable</div>}
        {windows.map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="time"
              className="rounded-md border border-hair-soft bg-surface-2 px-2 py-1.5 text-sm text-ink [color-scheme:dark]"
              value={w.start}
              onChange={(e) =>
                onChange(windows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
              }
            />
            <span className="text-faint">–</span>
            <input
              type="time"
              className="rounded-md border border-hair-soft bg-surface-2 px-2 py-1.5 text-sm text-ink [color-scheme:dark]"
              value={w.end}
              onChange={(e) =>
                onChange(windows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
              }
            />
            <button
              onClick={() => onChange(windows.filter((_, j) => j !== i))}
              className="text-faint hover:text-red-400"
              aria-label="Remove window"
            >
              <X size={16} />
            </button>
          </div>
        ))}
        <button
          onClick={() => onChange([...windows, { start: '09:00', end: '17:00' }])}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          <Plus size={14} /> Add hours
        </button>
      </div>
    </div>
  );
}
