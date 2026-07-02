/**
 * AI scheduling assistant endpoints for the Momentum website chat widget.
 *
 * Self-contained and ADDITIVE: this router is mounted alongside the other public
 * routers in app.ts and touches nothing else. It is a Firebase-native port of the
 * WordPress `momentum-chat` plugin, with one important upgrade — open times come
 * from THIS app's availability engine (`computeAvailability`) instead of TidyCal,
 * so the chat and the booking widget share one source of truth.
 *
 * Wire contract matches the ported chat.js widget:
 *   POST /api/bot/chat          {messages:[{role,content}], session_id}
 *                               -> {reply, tool} | {code, message}
 *   POST /api/bot/slots         {session_id, starts_after?}
 *                               -> {slots:[{starts_at, label}], has_more} | {code, message}
 *   POST /api/bot/booking-link  {starts_at, session_id, name?, email?}
 *                               -> {url}
 *   POST /api/bot/track         {event} -> {ok:true}   (fire-and-forget)
 */
import { Router, type Request, type Response } from 'express';
import { DateTime } from 'luxon';
import { computeAvailability, loadEventTypeBySlug } from '../scheduling/availability';
import { listActiveMembers } from '../members';
import { rateLimit } from '../util/ratelimit';
import { OPENROUTER_API_KEY } from '../config';
import { db, tenantDb } from '../firebase';
import type { ChatTranscriptMessage } from '../types';
import {
  CHAT_TENANT,
  CONSULT_EVENT_SLUG,
  PRACTICE_TIMEZONE,
  BOOKING_BASE_URL,
  OPENROUTER_MODEL,
  OPENROUTER_FALLBACK_MODELS,
  buildSystemPrompt,
} from '../chat/prompt';

export const chatRouter = Router();

const BASE = '/api/bot';

/** The ported chat.js treats any JSON with `code` + `message` as an error. */
function clientError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

function clientKey(req: Request): string {
  return (req.ip || 'unknown').toString();
}

// ---- Transcript persistence (feeds the admin "Conversations" view) -----------
const MAX_TRANSCRIPT_MESSAGES = 40;
const STATUS_RANK: Record<string, number> = { open: 0, slots_shown: 1, booking_click: 2 };

/** Validate the client session id before it becomes a Firestore doc id. */
function sessionDocId(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{6,120}$/.test(s) ? s : null;
}

/** Upsert a conversation transcript (best-effort; never fails the chat turn). */
async function saveTranscript(sessionRaw: unknown, messages: ChatTranscriptMessage[]): Promise<void> {
  const id = sessionDocId(sessionRaw);
  if (!id || messages.length === 0) return;
  const capped = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const now = new Date().toISOString();
  const ref = tenantDb(CHAT_TENANT).chatSessions().doc(id);
  try {
    const snap = await ref.get();
    const base: Record<string, unknown> = {
      id,
      tenantId: CHAT_TENANT,
      messages: capped,
      messageCount: capped.length,
      updatedAt: now,
    };
    if (!snap.exists) {
      base.createdAt = now;
      base.status = 'open';
    }
    await ref.set(base, { merge: true });
  } catch {
    /* transcript saving is best-effort */
  }
}

/** Advance an EXISTING conversation's status; never regresses. */
async function advanceStatus(sessionRaw: unknown, status: string): Promise<void> {
  const id = sessionDocId(sessionRaw);
  if (!id || !(status in STATUS_RANK)) return;
  const ref = tenantDb(CHAT_TENANT).chatSessions().doc(id);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return; // no transcript yet -> nothing to advance
      const cur = (snap.get('status') as string) || 'open';
      if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[cur] ?? 0)) return;
      tx.set(ref, { status, updatedAt: new Date().toISOString() }, { merge: true });
    });
  } catch {
    /* best-effort */
  }
}

/** "Dr. Anna Payne" -> "Dr. Payne" for compact slot labels; passthrough if it
 *  doesn't match the expected shape. */
function shortDoctor(name: string): string {
  const n = (name || '').trim();
  const m = n.match(/^(Dr\.?)\s+\S+\s+(\S+)$/i);
  return m ? `Dr. ${m[2]}` : n;
}

/** Firestore member id shape, e.g. "mbr_todd". Used to validate a provider id
 *  before it goes into a booking URL. */
const MEMBER_ID_RE = /^mbr_[a-z0-9_]+$/i;

/** Turn a free-text timeframe ("any friday", "next week", "mornings") into a
 *  slot predicate in the practice timezone. Empty/unrecognized => matches all
 *  (so we still show the soonest times). */
function timeframeFilter(timeframe: string, tz: string): (iso: string) => boolean {
  const t = (timeframe || '').toLowerCase();
  if (!t) return () => true;
  const preds: Array<(d: DateTime) => boolean> = [];

  const WEEKDAYS: Array<[string, number]> = [
    ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4],
    ['friday', 5], ['saturday', 6], ['sunday', 7],
  ];
  const wantedDays = new Set(WEEKDAYS.filter(([n]) => t.includes(n)).map(([, w]) => w));
  if (wantedDays.size) preds.push((d) => wantedDays.has(d.weekday));

  if (t.includes('morning')) preds.push((d) => d.hour < 12);
  else if (t.includes('afternoon')) preds.push((d) => d.hour >= 12);
  else if (t.includes('evening')) preds.push((d) => d.hour >= 17);

  const now = DateTime.now().setZone(tz);
  if (t.includes('next week')) {
    const s = now.startOf('week').plus({ weeks: 1 });
    const e = s.plus({ weeks: 1 });
    preds.push((d) => d >= s && d < e);
  } else if (t.includes('this week')) {
    const e = now.startOf('week').plus({ weeks: 1 });
    preds.push((d) => d < e);
  } else if (t.includes('next month')) {
    const s = now.startOf('month').plus({ months: 1 });
    const e = s.plus({ months: 1 });
    preds.push((d) => d >= s && d < e);
  }
  // "asap" / "soon" / "anytime" / "flexible" => no extra constraint.

  if (!preds.length) return () => true;
  return (iso) => {
    const d = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
    return preds.every((p) => p(d));
  };
}

/** Timing quick-replies re-offered when a timeframe returns nothing. Keep in
 *  sync with the [OPTIONS] example in prompt.ts. Mon–Thu practice: no Friday. */
const TIMING_OPTIONS = ['ASAP', 'Next week', 'Next month', 'Mornings'];

/** Friendly note when a timeframe yields no open times — closed-day aware, and
 *  always invites another time (never "something went wrong"). */
function emptyTimeframeNote(timeframe: string): string {
  const t = (timeframe || '').toLowerCase();
  const closed = ['friday', 'saturday', 'sunday'].filter((d) => t.includes(d));
  if (closed.length) {
    const label = closed.map((d) => d[0].toUpperCase() + d.slice(1)).join(' or ');
    return `We're only in Monday through Thursday, so we don't have any ${label} times. Would you like to pick another day or time?`;
  }
  return `I don't see any open times for that. We're open Monday through Thursday — want to try a different day or time?`;
}

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// ---- POST /api/bot/chat : conversation via OpenRouter ------------------------
chatRouter.post(`${BASE}/chat`, async (req: Request, res: Response) => {
  if (!rateLimit(`bot-chat:${clientKey(req)}`, 12, 60_000)) {
    clientError(res, 429, 'rate_limited', 'Too many messages. Please wait a moment.');
    return;
  }

  let key = '';
  try {
    key = OPENROUTER_API_KEY.value().trim();
  } catch {
    key = '';
  }
  if (!key) {
    clientError(res, 500, 'not_configured', "The assistant isn't set up yet. Please call the office.");
    return;
  }

  const incoming: unknown = req.body?.messages;
  const allMsgs: ChatMessage[] = (Array.isArray(incoming) ? incoming : [])
    .filter(
      (m): m is { role: string; content: string } =>
        !!m &&
        typeof (m as { role?: unknown }).role === 'string' &&
        typeof (m as { content?: unknown }).content === 'string',
    )
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 2000) }));
  // Only the recent tail is sent to the model; the full thread is saved.
  const convo = allMsgs.slice(-20);

  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...convo];

  // Two attempts against OpenRouter, plus provider-side fallback: the `models`
  // list lets OpenRouter route to the next model when the primary's providers
  // are down/rate-limited (the cause of intermittent 502s in the wild).
  let reply = '';
  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://momentumhealthwellnessmn.com',
          'X-Title': 'Momentum Health & Wellness',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          models: [OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS],
          messages,
          temperature: 0.4,
          max_tokens: 600,
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      reply = data?.choices?.[0]?.message?.content ?? '';
    } catch {
      /* timeout or network error — loop retries once */
    } finally {
      clearTimeout(timer);
    }
  }

  if (!reply) {
    clientError(res, 502, 'upstream', "I'm having trouble connecting right now. Please try again, or call the office.");
    return;
  }

  // Pull an optional [TOOL]{...}[/TOOL] directive and strip it from the text.
  let tool: unknown = null;
  const match = reply.match(/\[TOOL\](.*?)\[\/TOOL\]/s);
  if (match) {
    try {
      tool = JSON.parse(match[1].trim());
    } catch {
      tool = null;
    }
    reply = reply.replace(/\[TOOL\].*?\[\/TOOL\]/s, '').trim();
  }

  // Pull an optional [OPTIONS]a|b|c[/OPTIONS] directive (tappable quick replies)
  // and strip it from the text.
  let options: string[] = [];
  const optMatch = reply.match(/\[OPTIONS\](.*?)\[\/OPTIONS\]/s);
  if (optMatch) {
    options = optMatch[1]
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.slice(0, 40))
      .slice(0, 5);
    reply = reply.replace(/\[OPTIONS\].*?\[\/OPTIONS\]/s, '').trim();
  }

  // Persist the full conversation (best-effort) for the admin Conversations view.
  await saveTranscript(req.body?.session_id, [...allMsgs, { role: 'assistant', content: reply }]);

  res.json({ reply, tool, options });
});

// ---- POST /api/bot/slots : real open times from the availability engine ------
chatRouter.post(`${BASE}/slots`, async (req: Request, res: Response) => {
  if (!rateLimit(`bot-slots:${clientKey(req)}`, 20, 60_000)) {
    clientError(res, 429, 'rate_limited', 'Too many requests. Please wait a moment.');
    return;
  }
  try {
    const eventType = await loadEventTypeBySlug(CHAT_TENANT, CONSULT_EVENT_SLUG);
    if (!eventType || !eventType.active) {
      clientError(res, 404, 'no_event_type', 'Scheduling is temporarily unavailable. Please call the office.');
      return;
    }

    const tz = PRACTICE_TIMEZONE;
    const startsAfterRaw = typeof req.body?.starts_after === 'string' ? req.body.starts_after : '';
    const afterMs = startsAfterRaw ? Date.parse(startsAfterRaw) : NaN;
    const hasAfter = Number.isFinite(afterMs);
    const timeframe = typeof req.body?.timeframe === 'string' ? req.body.timeframe : '';
    const inTimeframe = timeframeFilter(timeframe, tz);

    const fromDate = (hasAfter ? DateTime.fromMillis(afterMs) : DateTime.now())
      .setZone(tz)
      .toFormat('yyyy-MM-dd');
    const toDate = DateTime.fromFormat(fromDate, 'yyyy-MM-dd', { zone: tz })
      .plus({ days: 60 })
      .toFormat('yyyy-MM-dd');

    // Providers offering this consult (both doctors). Tag every open time with
    // its doctor so the chat can render "… · Dr. Payne" and hand the exact
    // provider to the booking widget. Legacy fallback: no members => owner.
    const activeMembers = await listActiveMembers(CHAT_TENANT);
    const nameById = new Map(activeMembers.map((m) => [m.id, m.name]));
    const memberIds = (eventType.memberIds ?? []).filter((id) => nameById.has(id));

    type Tagged = { iso: string; providerId: string; providerName: string };
    let tagged: Tagged[];
    if (memberIds.length === 0) {
      const avail = await computeAvailability({ tenantId: CHAT_TENANT, eventType, fromDate, toDate, inviteeTz: tz });
      tagged = avail.days.flatMap((d) => d.slots).map((iso) => ({ iso, providerId: '', providerName: '' }));
    } else {
      const perProvider = await Promise.all(
        memberIds.map(async (memberId) => {
          const avail = await computeAvailability({ tenantId: CHAT_TENANT, eventType, memberId, fromDate, toDate, inviteeTz: tz });
          const providerName = nameById.get(memberId) ?? '';
          return avail.days.flatMap((d) => d.slots).map((iso) => ({ iso, providerId: memberId, providerName }));
        }),
      );
      tagged = perProvider.flat();
    }

    // Merge, filter past the "show more" cursor, and order by time (doctor name
    // breaks same-time ties so both doctors' slots list stably).
    const filtered = tagged
      .filter((t) => (!hasAfter || Date.parse(t.iso) > afterMs) && inTimeframe(t.iso))
      .sort((a, b) => a.iso.localeCompare(b.iso) || a.providerName.localeCompare(b.providerName));

    // No open times for this timeframe (e.g. a closed day like Friday): return a
    // friendly, closed-day-aware note + re-offer timing chips — not an error.
    if (filtered.length === 0 && !hasAfter) {
      res.json({ slots: [], has_more: false, message: emptyTimeframeNote(timeframe), options: TIMING_OPTIONS });
      return;
    }

    const hasMore = filtered.length > 10;
    const slots = filtered.slice(0, 10).map((t) => {
      const time = DateTime.fromISO(t.iso, { zone: 'utc' }).setZone(tz).toFormat("ccc, LLL d '@' h:mm a");
      const doc = shortDoctor(t.providerName);
      return {
        starts_at: t.iso,
        label: doc ? `${time} · ${doc}` : time,
        provider_id: t.providerId,
        provider_name: t.providerName,
      };
    });

    // Mark the conversation as having reached the times step (admin view badge).
    if (slots.length > 0) await advanceStatus(req.body?.session_id, 'slots_shown');

    res.json({ slots, has_more: hasMore });
  } catch {
    clientError(res, 500, 'server_error', "I can't pull up the calendar right now. Please call the office.");
  }
});

// ---- POST /api/bot/booking-link : deep-link into the booking widget ----------
// Carries the chosen doctor + exact time so the widget jumps straight to the
// pre-filled booking form (see BookingApp's `provider`/`start` params) instead
// of the beginning of the flow.
chatRouter.post(`${BASE}/booking-link`, async (req: Request, res: Response) => {
  const url = new URL(BOOKING_BASE_URL);
  url.searchParams.set('type', CONSULT_EVENT_SLUG);

  const providerId = typeof req.body?.provider_id === 'string' ? req.body.provider_id.trim() : '';
  if (MEMBER_ID_RE.test(providerId)) url.searchParams.set('provider', providerId);

  const startsAt = typeof req.body?.starts_at === 'string' ? req.body.starts_at : '';
  const startMs = startsAt ? Date.parse(startsAt) : NaN;
  if (Number.isFinite(startMs)) url.searchParams.set('start', new Date(startMs).toISOString());

  // The strongest signal a chat produced a booking attempt (admin view badge).
  await advanceStatus(req.body?.session_id, 'booking_click');

  res.json({ url: url.toString() });
});

// ---- POST /api/bot/track : advance a conversation's status ------------------
// Events (open -> slots_shown -> booking_click) mark how far the chat got, shown
// as a badge in the admin Conversations view.
chatRouter.post(`${BASE}/track`, async (req: Request, res: Response) => {
  const event = typeof req.body?.event === 'string' ? req.body.event : '';
  await advanceStatus(req.body?.session_id, event);
  res.json({ ok: true });
});

// ---- GET /api/bot/ping : readiness probe for the website loader --------------
// Cheap (no availability computation). Reports ONLY a boolean for whether the
// AI key is configured — never the key itself — so the site can keep the chat
// bubble hidden until the assistant can actually answer. Before this function
// is deployed the route 404s, which the loader also treats as "not ready".
chatRouter.get(`${BASE}/ping`, (_req: Request, res: Response) => {
  let ready = false;
  try {
    ready = OPENROUTER_API_KEY.value().trim().length > 0;
  } catch {
    ready = false;
  }
  res.json({ ok: true, ready });
});
