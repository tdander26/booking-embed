import { useEffect, useState } from 'react';
import {
  Plus,
  Trash2,
  X,
  Link2,
  Unlink,
  RefreshCw,
  Check,
  ShieldCheck,
  Star,
} from 'lucide-react';
import * as api from '../api/client';
import type {
  Member,
  AvailabilitySchedule,
  ConnectionView,
  MemberCalendarRef,
  AdminMe,
} from '../api/types';
import { guessTimezone, timezoneOptions } from '../lib/time';
import { Spinner, Banner, Button, Card, Field, inputClass } from '../components/ui';

function emptyMember(count: number, tz: string): Member {
  return {
    id: '',
    name: '',
    title: '',
    email: '',
    avatarUrl: '',
    bio: '',
    active: true,
    featured: false,
    sortOrder: count,
    isAdmin: true,
    timezone: tz,
    defaultScheduleId: null,
  };
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function byOrder(a: Member, b: Member): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

export function ProvidersTab({ me }: { me: AdminMe | null }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [schedules, setSchedules] = useState<AvailabilitySchedule[]>([]);
  const [editing, setEditing] = useState<Member | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = me?.isOwner ?? false;

  const load = () =>
    Promise.all([api.adminGetMembers(), api.adminGetSchedules()])
      .then(([m, s]) => {
        const list = [...m.members].sort(byOrder);
        setMembers(isOwner ? list : list.filter((x) => x.id === me?.memberId));
        setSchedules(s.schedules);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.memberId, isOwner]);

  // Surface the ?google=…&member=… flash from the OAuth round-trip by auto-opening
  // that member's editor so the connections panel reloads with the result.
  useEffect(() => {
    if (!members || editing) return;
    const flashMember = new URLSearchParams(window.location.search).get('member');
    if (!flashMember) return;
    const target = members.find((m) => m.id === flashMember);
    if (target) setEditing(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setErr(null);
    try {
      const saved = editing.id
        ? await api.adminUpdateMember(editing.id, editing)
        : await api.adminCreateMember(editing);
      // Keep the editor open on the saved record so the Google panel becomes
      // available immediately after the first save of a new provider.
      setEditing(saved);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: Member) => {
    if (
      !confirm(
        'Remove this provider? Their event-type assignments and schedules must be reassigned.',
      )
    )
      return;
    try {
      await api.adminDeleteMember(m.id);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (err && !members) return <Banner kind="error">{err}</Banner>;
  if (!members) return <Spinner />;

  if (editing) {
    return (
      <MemberEditor
        value={editing}
        schedules={schedules}
        me={me}
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
      {isOwner && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing(emptyMember(members.length, guessTimezone()))}>
            <Plus size={16} /> New provider
          </Button>
        </div>
      )}
      {members.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">
          {isOwner ? 'No providers yet.' : 'No provider profile is linked to your account yet.'}
        </Card>
      ) : (
        members.map((m) => {
          const sched = schedules.find((s) => s.id === m.defaultScheduleId);
          return (
            <Card key={m.id} className="flex items-center gap-3 p-4">
              {m.avatarUrl ? (
                <img
                  src={m.avatarUrl}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-full object-cover ring-1 ring-hair-soft"
                />
              ) : (
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold text-muted ring-1 ring-hair-soft">
                  {initials(m.name)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">{m.name || 'Untitled provider'}</span>
                  {m.featured && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand-light">
                      <Star size={11} /> Featured
                    </span>
                  )}
                  {m.isAdmin && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-hair px-2 py-0.5 text-xs text-muted">
                      <ShieldCheck size={11} /> Admin
                    </span>
                  )}
                  {!m.active && (
                    <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-muted">
                      inactive
                    </span>
                  )}
                </div>
                <div className="truncate text-sm text-muted">
                  {[m.title, m.email].filter(Boolean).join(' · ')}
                </div>
                {sched && (
                  <div className="text-xs text-faint">Default schedule: {sched.name}</div>
                )}
              </div>
              <Button variant="outline" onClick={() => setEditing(m)}>
                Edit
              </Button>
              {isOwner && m.id !== me?.memberId && (
                <button
                  onClick={() => remove(m)}
                  className="rounded-lg p-2 text-faint hover:bg-red-500/10 hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 size={18} />
                </button>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

function MemberEditor({
  value,
  schedules,
  me,
  onChange,
  onSave,
  onCancel,
  busy,
  err,
}: {
  value: Member;
  schedules: AvailabilitySchedule[];
  me: AdminMe | null;
  onChange: (m: Member) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  err: string | null;
}) {
  const set = (patch: Partial<Member>) => onChange({ ...value, ...patch });
  const isOwner = me?.isOwner ?? false;
  const isSelf = !!value.id && value.id === me?.memberId;
  // The owner's own record always stays an admin and can't lock itself out.
  const lockAdmin = !isOwner || (isSelf && isOwner);
  // Non-owners can edit their own profile but never their email.
  const lockEmail = !isOwner && !!value.id;
  const memberSchedules = schedules.filter(
    (s) => !s.memberId || s.memberId === value.id,
  );

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">
          {value.id ? 'Edit provider' : 'New provider'}
        </h2>
        <button onClick={onCancel} className="text-faint hover:text-muted" aria-label="Close">
          <X size={20} />
        </button>
      </div>
      {err && (
        <div className="mb-4">
          <Banner kind="error">{err}</Banner>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={value.name}
            placeholder="Dr. Anna Payne"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Title" hint="Shown under the name on the booking page.">
          <input
            className={inputClass}
            value={value.title ?? ''}
            placeholder="Functional Medicine"
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <Field
          label="Email"
          hint={lockEmail ? 'Only the owner can change a provider email.' : 'Must match their Google sign-in.'}
        >
          <input
            className={inputClass}
            value={value.email}
            disabled={lockEmail}
            onChange={(e) => set({ email: e.target.value.trim().toLowerCase() })}
          />
        </Field>
        <Field label="Timezone">
          <select
            className={inputClass}
            value={value.timezone ?? guessTimezone()}
            onChange={(e) => set({ timezone: e.target.value })}
          >
            {timezoneOptions().map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default schedule">
          <select
            className={inputClass}
            value={value.defaultScheduleId ?? ''}
            onChange={(e) => set({ defaultScheduleId: e.target.value || null })}
          >
            <option value="">— None —</option>
            {memberSchedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sort order" hint="Lower numbers appear first.">
          <input
            type="number"
            className={inputClass}
            value={value.sortOrder}
            onChange={(e) => set({ sortOrder: parseInt(e.target.value, 10) || 0 })}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Avatar URL" hint="Optional headshot shown in the provider picker.">
            <input
              className={inputClass}
              value={value.avatarUrl ?? ''}
              onChange={(e) => set({ avatarUrl: e.target.value })}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Bio">
            <textarea
              className={`${inputClass} min-h-[70px]`}
              value={value.bio ?? ''}
              onChange={(e) => set({ bio: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={value.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          Active (bookable + visible)
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={value.featured}
            onChange={(e) => set({ featured: e.target.checked })}
          />
          Featured (shown first)
        </label>
        <label
          className={`flex items-center gap-2 text-sm ${lockAdmin ? 'text-faint' : 'text-muted'}`}
        >
          <input
            type="checkbox"
            checked={value.isAdmin}
            disabled={lockAdmin}
            onChange={(e) => set({ isAdmin: e.target.checked })}
          />
          Admin access
        </label>
      </div>

      <div className="mt-5 flex gap-2">
        <Button onClick={onSave} disabled={busy || !value.name.trim() || !value.email.trim()}>
          {busy ? 'Saving…' : 'Save provider'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {value.id && (
        <div className="mt-6 border-t border-hair-soft pt-5">
          <MemberGooglePanel
            memberId={value.id}
            memberName={value.name || 'this provider'}
            canManage={isOwner || me?.memberId === value.id}
          />
        </div>
      )}
    </Card>
  );
}

function MemberGooglePanel({
  memberId,
  memberName,
  canManage,
}: {
  memberId: string;
  memberName: string;
  canManage: boolean;
}) {
  const [conns, setConns] = useState<ConnectionView[] | null>(null);
  const [writeConnId, setWriteConnId] = useState<string | null>(null);
  const [writeCalId, setWriteCalId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .adminListConnections(memberId)
      .then((r) => {
        setConns(r.connections);
        setWriteConnId(r.writeConnectionId);
        setWriteCalId(r.writeCalendarId);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  const flash = new URLSearchParams(window.location.search).get('google');
  const flashMember = new URLSearchParams(window.location.search).get('member');
  const showFlash = flash && flashMember === memberId;

  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await api.adminMemberGoogleAuthUrl(memberId);
      window.location.href = url;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const disconnect = async (connId: string) => {
    if (!confirm('Disconnect this Google account? Its calendars stop blocking availability.'))
      return;
    try {
      await api.adminDeleteConnection(memberId, connId);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const refresh = async (connId: string) => {
    try {
      await api.adminRefreshConnection(memberId, connId);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const toggleCalendar = async (conn: ConnectionView, cal: MemberCalendarRef) => {
    const selections = conn.calendars.map((c) => ({
      calendarId: c.calendarId,
      selected: c.calendarId === cal.calendarId ? !cal.selected : c.selected,
    }));
    // Optimistic update.
    setConns((prev) =>
      prev?.map((c) =>
        c.id === conn.id
          ? {
              ...c,
              calendars: c.calendars.map((x) =>
                x.calendarId === cal.calendarId ? { ...x, selected: !cal.selected } : x,
              ),
            }
          : c,
      ) ?? prev,
    );
    try {
      await api.adminSetConnectionCalendars(memberId, conn.id, selections);
    } catch (e) {
      setErr((e as Error).message);
      load();
    }
  };

  const setWriteTarget = async (connId: string, calendarId: string) => {
    setWriteConnId(connId);
    setWriteCalId(calendarId);
    try {
      await api.adminSetWriteTarget(memberId, { connectionId: connId, calendarId });
      load();
    } catch (e) {
      setErr((e as Error).message);
      load();
    }
  };

  const hasWriteTarget = !!writeConnId && !!writeCalId;

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-ink">Calendar connections</h3>
      <p className="mb-3 text-sm text-muted">
        Connect Google accounts so bookings check real availability and write confirmed events
        with a Meet link.
      </p>

      {showFlash && flash === 'connected' && (
        <div className="mb-3">
          <Banner kind="success">Google account connected.</Banner>
        </div>
      )}
      {showFlash && flash === 'norefresh' && (
        <div className="mb-3">
          <Banner kind="error">
            Google didn't return a refresh token. Remove this app from the account's third-party
            access, then reconnect.
          </Banner>
        </div>
      )}
      {showFlash &&
        (flash === 'error' || flash === 'expired' || flash === 'unconfigured') && (
          <div className="mb-3">
            <Banner kind="error">Connection failed ({flash}). Please try again.</Banner>
          </div>
        )}
      {err && (
        <div className="mb-3">
          <Banner kind="error">{err}</Banner>
        </div>
      )}

      {!canManage && (
        <div className="mb-3">
          <Banner kind="info">
            Only {memberName} can connect their own Google account, signed in as themselves.
          </Banner>
        </div>
      )}

      {!conns ? (
        <Spinner />
      ) : conns.length === 0 ? (
        <Card className="p-4 text-sm text-faint">
          No Google account connected. Availability uses a mock calendar until one is added.
        </Card>
      ) : (
        <div className="space-y-3">
          {!hasWriteTarget && (
            <Banner kind="error">
              Pick where confirmed events are written, or bookings won't appear on a calendar.
            </Banner>
          )}
          {conns.map((conn) => {
            const anySelected = conn.calendars.some((c) => c.selected);
            return (
              <Card key={conn.id} className="p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 text-sm font-medium text-ink">
                    <Check size={15} className="text-brand" />
                    {conn.accountEmail}
                    {conn.status === 'revoked' && (
                      <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-300">
                        revoked
                      </span>
                    )}
                  </span>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => refresh(conn.id)}
                        className="rounded-lg p-2 text-faint hover:bg-white/5 hover:text-muted"
                        aria-label="Refresh calendars"
                        title="Refresh calendar list"
                      >
                        <RefreshCw size={15} />
                      </button>
                      <button
                        onClick={() => disconnect(conn.id)}
                        className="rounded-lg p-2 text-faint hover:bg-red-500/10 hover:text-red-400"
                        aria-label="Disconnect"
                        title="Disconnect account"
                      >
                        <Unlink size={15} />
                      </button>
                    </div>
                  )}
                </div>

                {conn.calendars.length === 0 ? (
                  <p className="text-xs text-faint">
                    No calendars found. Try refreshing the account.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {conn.calendars.map((cal) => {
                      const isWrite =
                        writeConnId === conn.id && writeCalId === cal.calendarId;
                      return (
                        <li
                          key={cal.calendarId}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1 py-1"
                        >
                          <label className="flex min-h-[28px] flex-1 items-center gap-2 text-sm text-muted">
                            <input
                              type="checkbox"
                              checked={cal.selected}
                              disabled={!canManage}
                              onChange={() => toggleCalendar(conn, cal)}
                            />
                            <span className="truncate text-ink">{cal.summary}</span>
                            {cal.primary && (
                              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-faint">
                                primary
                              </span>
                            )}
                          </label>
                          <label
                            className={`flex items-center gap-1.5 text-xs ${
                              cal.writable ? 'text-muted' : 'text-faint'
                            }`}
                            title={
                              cal.writable
                                ? 'Write confirmed events here'
                                : 'No write access to this calendar'
                            }
                          >
                            <input
                              type="radio"
                              name={`write-${memberId}`}
                              checked={isWrite}
                              disabled={!canManage || !cal.writable}
                              onChange={() => setWriteTarget(conn.id, cal.calendarId)}
                            />
                            Write here
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {!anySelected && conn.calendars.length > 0 && (
                  <p className="mt-2 text-xs text-amber-300/80">
                    No calendars checked — this account won't block any busy times.
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {canManage && (
        <div className="mt-3">
          <Button variant="outline" onClick={connect} disabled={busy}>
            <Link2 size={16} /> {busy ? 'Redirecting…' : 'Connect a Google account'}
          </Button>
          <p className="mt-2 text-xs text-faint">
            You'll be sent to Google. Sign in as the account whose calendars you want checked —
            consent happens as whoever is logged into Google.
          </p>
        </div>
      )}
    </div>
  );
}
