import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import * as api from '../api/client';
import type { ChatSessionView, ChatSessionStatus } from '../api/types';
import { fmtFull, guessTimezone } from '../lib/time';
import { Spinner, Banner, Card } from '../components/ui';

/** Website chat assistant transcripts — the old plugin's "Conversations" view.
 * Read-only list with status filters, expandable transcripts, and delete. */

const STATUS_META: Record<ChatSessionStatus, { label: string; cls: string }> = {
  open: { label: 'Chatted', cls: 'bg-overlay text-muted' },
  slots_shown: { label: 'Times shown', cls: 'bg-amber-500/15 text-amber-300' },
  booking_click: { label: 'Booking click', cls: 'bg-emerald-500/15 text-emerald-300' },
};

const FILTERS: { key: ChatSessionStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Chatted' },
  { key: 'slots_shown', label: 'Times shown' },
  { key: 'booking_click', label: 'Booking click' },
];

export function ConversationsTab() {
  const [sessions, setSessions] = useState<ChatSessionView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ChatSessionStatus | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const tz = guessTimezone();

  const load = () => {
    setSessions(null);
    api
      .adminGetChatSessions()
      .then((r) => setSessions(r.sessions))
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(load, []);

  const removeOne = async (id: string) => {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    try {
      await api.adminDeleteChatSession(id);
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? prev);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const removeAll = async () => {
    if (!confirm('Delete ALL conversations? This cannot be undone.')) return;
    try {
      await api.adminDeleteAllChatSessions();
      setSessions([]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (err) return <Banner kind="error">{err}</Banner>;
  if (!sessions) return <Spinner />;

  const visible = filter === 'all' ? sessions : sessions.filter((s) => s.status === filter);

  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">
        The website assistant doesn&apos;t ask for names or contact info, but visitors may
        volunteer health details — treat these transcripts like clinical notes and delete
        anything you&apos;re not comfortable storing.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              filter === f.key
                ? 'bg-brand/15 font-semibold text-brand'
                : 'text-muted hover:bg-overlay'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="flex-1" />
        {sessions.length > 0 && (
          <button
            onClick={removeAll}
            className="rounded-lg px-3 py-1.5 text-sm text-faint transition hover:bg-red-500/10 hover:text-red-400"
          >
            Delete all
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <Card className="p-6 text-center text-sm text-faint">
          No conversations{filter !== 'all' ? ' in this category' : ' yet'}.
        </Card>
      ) : (
        visible.map((s) => {
          const meta = STATUS_META[s.status] ?? STATUS_META.open;
          const firstUser = s.messages.find((m) => m.role === 'user')?.content ?? '';
          const expanded = openId === s.id;
          return (
            <Card key={s.id} className="p-0">
              <button
                onClick={() => setOpenId(expanded ? null : s.id)}
                className="flex w-full items-center gap-3 p-4 text-left"
              >
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${meta.cls}`}>
                  {meta.label}
                </span>
                <span className="shrink-0 text-sm text-muted">
                  {fmtFull(s.updatedAt, tz)} · {s.messageCount} message
                  {s.messageCount === 1 ? '' : 's'}
                </span>
                <span className="min-w-0 flex-1 truncate text-right text-sm italic text-faint">
                  {firstUser}
                </span>
                <span className="shrink-0 text-faint">
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
              </button>

              {expanded && (
                <div className="border-t border-hair-soft p-4">
                  <div className="space-y-2">
                    {s.messages.map((m, i) => (
                      <div
                        key={i}
                        className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
                          m.role === 'user'
                            ? 'ml-auto bg-brand/15 text-ink'
                            : 'mr-auto bg-overlay text-muted'
                        }`}
                      >
                        {m.content}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={() => removeOne(s.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-faint transition hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 size={14} /> Delete conversation
                    </button>
                  </div>
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
