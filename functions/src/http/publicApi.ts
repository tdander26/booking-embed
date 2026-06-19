import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { loadBranding } from '../branding';
import {
  loadEventTypeById,
  loadEventTypeBySlug,
  computeAvailability,
  nextAvailableForMember,
} from '../scheduling/availability';
import {
  createBooking,
  cancelBooking,
  loadBookingForManage,
} from '../scheduling/booking';
import { listActiveMembers, publicProvider, byDisplayOrder } from '../members';
import { wrap, badRequest, notFound, forbidden } from '../util/http';
import { rateLimit } from '../util/ratelimit';
import type {
  Branding,
  EventType,
  PublicEventType,
  PublicProvider,
  Member,
  Booking,
  NextAvailableProvider,
  NextAvailableResponse,
} from '../types';

export const publicRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validTz(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz) return null;
  return DateTime.now().setZone(tz).isValid ? tz : null;
}

function clientIp(req: Request): string {
  // Rely on Express's proxy-aware req.ip (see `trust proxy` in app.ts). Do NOT
  // read the raw X-Forwarded-For leftmost value — it is client-spoofable and
  // would let an attacker mint unlimited distinct rate-limit buckets.
  return req.ip || 'unknown';
}

/**
 * Project an event type to its public DTO, hydrating its providers from the
 * supplied member map (active members only, in display order). `providers` is
 * `[]` for legacy single-provider types (no `memberIds`); `collectNotes` keeps
 * the legacy free-text notes box only when there are no custom questions.
 */
function toPublic(e: EventType, memberMap: Map<string, Member>): PublicEventType {
  const questions = [...(e.questions ?? [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  const providers: PublicProvider[] = (e.memberIds ?? [])
    .map((id) => memberMap.get(id))
    .filter((m): m is Member => !!m)
    .sort(byDisplayOrder)
    .map(publicProvider);
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    durationMinutes: e.durationMinutes,
    color: e.color,
    location: { type: e.location.type, details: e.location.details },
    collectPhone: e.collectPhone,
    collectNotes: questions.length === 0,
    minNoticeMinutes: e.minNoticeMinutes,
    maxDaysInFuture: e.maxDaysInFuture,
    providers,
    questions,
  };
}

/** Load active members keyed by id, for provider hydration. */
async function activeMemberMap(): Promise<Map<string, Member>> {
  const members = await listActiveMembers();
  return new Map(members.map((m) => [m.id, m]));
}

function publicBranding(b: Branding) {
  return {
    displayName: b.displayName,
    tagline: b.tagline ?? '',
    avatarUrl: b.avatarUrl ?? '',
    brandColor: b.brandColor,
    welcomeText: b.welcomeText ?? '',
    timezone: b.timezone,
  };
}

publicRouter.get(
  '/api/branding',
  wrap(async (_req, res) => {
    res.json(publicBranding(await loadBranding()));
  }),
);

publicRouter.get(
  '/api/event-types',
  wrap(async (_req, res) => {
    const { db, COL } = await import('../firebase');
    const [q, memberMap] = await Promise.all([
      db.collection(COL.eventTypes).where('active', '==', true).get(),
      activeMemberMap(),
    ]);
    const types = q.docs
      .map((d) => ({ id: d.id, ...d.data() }) as EventType)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((e) => toPublic(e, memberMap));
    res.json({ eventTypes: types });
  }),
);

publicRouter.get(
  '/api/event-types/:slug',
  wrap(async (req, res) => {
    const [e, memberMap] = await Promise.all([
      loadEventTypeBySlug(req.params.slug),
      activeMemberMap(),
    ]);
    if (!e || !e.active) throw notFound('Event type not found', 'no_event_type');
    res.json(toPublic(e, memberMap));
  }),
);

/** Validate an optional memberId against an event type's provider list.
 * Returns the resolved memberId (or undefined for the legacy single-provider
 * path). Throws when a multi-provider type is queried without a valid member. */
function resolveMemberId(e: EventType, raw: unknown): string | undefined {
  const memberIds = e.memberIds ?? [];
  const memberId = typeof raw === 'string' && raw ? raw : undefined;
  if (memberId) {
    if (!memberIds.includes(memberId)) {
      throw badRequest('That provider does not offer this meeting type.', 'invalid_member');
    }
    return memberId;
  }
  if (memberIds.length) {
    throw badRequest('Please choose a provider.', 'member_required');
  }
  return undefined; // legacy single-provider type
}

publicRouter.get(
  '/api/availability',
  wrap(async (req, res) => {
    const id = typeof req.query.eventTypeId === 'string' ? req.query.eventTypeId : undefined;
    const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
    const e = id
      ? await loadEventTypeById(id)
      : slug
        ? await loadEventTypeBySlug(slug)
        : null;
    if (!e || !e.active) throw notFound('Event type not found', 'no_event_type');

    const memberId = resolveMemberId(e, req.query.memberId);

    const branding = await loadBranding();
    const tz = validTz(req.query.tz) ?? branding.timezone ?? 'UTC';
    const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
    const from =
      typeof req.query.from === 'string' && DATE_RE.test(req.query.from)
        ? req.query.from
        : today;
    const to =
      typeof req.query.to === 'string' && DATE_RE.test(req.query.to)
        ? req.query.to
        : DateTime.fromISO(from).plus({ days: 42 }).toFormat('yyyy-MM-dd');

    const result = await computeAvailability({
      eventType: e,
      memberId,
      fromDate: from,
      toDate: to,
      inviteeTz: tz,
    });
    res.json(result);
  }),
);

// ---- Next-available probe (cheap per-provider scan for the provider step) ----

const NEXT_AVAIL_TTL_MS = 60_000;
const NEXT_AVAIL_MAX_MEMBERS = 8;
const nextAvailCache = new Map<string, { at: number; value: NextAvailableResponse }>();

publicRouter.get(
  '/api/next-available',
  wrap(async (req, res) => {
    if (!rateLimit(`nextavail:${clientIp(req)}`, 30, 60_000)) {
      throw forbidden('Too many requests. Please wait a moment.', 'rate_limited');
    }
    const eventTypeId = typeof req.query.eventTypeId === 'string' ? req.query.eventTypeId : '';
    if (!eventTypeId) throw badRequest('Missing event type.', 'invalid_body');
    const e = await loadEventTypeById(eventTypeId);
    if (!e || !e.active) throw notFound('Event type not found', 'no_event_type');

    const branding = await loadBranding();
    const tz = validTz(req.query.tz) ?? branding.timezone ?? 'UTC';

    // Requested members default to the type's full provider list; validate each
    // is actually offered and cap the fan-out.
    const requested =
      typeof req.query.memberIds === 'string' && req.query.memberIds
        ? req.query.memberIds.split(',').map((s) => s.trim()).filter(Boolean)
        : (e.memberIds ?? []);
    const offered = new Set(e.memberIds ?? []);
    const memberIds = requested
      .filter((m) => offered.has(m))
      .slice(0, NEXT_AVAIL_MAX_MEMBERS);

    if (memberIds.length === 0) {
      res.json({ eventTypeId: e.id, timezone: tz, providers: [] } satisfies NextAvailableResponse);
      return;
    }

    // 60s in-memory cache keyed on type, sorted members, tz, and the local day
    // (so it rolls over at midnight in the invitee's zone).
    const todayInTz = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
    const cacheKey = `${e.id}|${[...memberIds].sort().join(',')}|${tz}|${todayInTz}`;
    const cached = nextAvailCache.get(cacheKey);
    if (cached && Date.now() - cached.at < NEXT_AVAIL_TTL_MS) {
      res.json(cached.value);
      return;
    }

    // Per-member scan with per-member error isolation: one provider's calendar
    // error never dead-ends the whole response.
    const providers: NextAvailableProvider[] = await Promise.all(
      memberIds.map((memberId) =>
        nextAvailableForMember(e, memberId, tz).catch(
          () =>
            ({
              memberId,
              nextDate: null,
              nextSlotIso: null,
              slotCountThatDay: 0,
              hasAvailability: false,
            }) satisfies NextAvailableProvider,
        ),
      ),
    );

    const value: NextAvailableResponse = { eventTypeId: e.id, timezone: tz, providers };
    nextAvailCache.set(cacheKey, { at: Date.now(), value });
    // Keep the cache bounded.
    if (nextAvailCache.size > 500) {
      const oldest = [...nextAvailCache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < oldest.length && nextAvailCache.size > 500; i++) {
        nextAvailCache.delete(oldest[i][0]);
      }
    }
    res.json(value);
  }),
);

const answerValueSchema = z.union([
  z.string().max(5000),
  z.array(z.string().max(500)).max(50),
  z.boolean(),
]);

const bookingSchema = z
  .object({
    eventTypeId: z.string().min(1).max(200),
    memberId: z.string().min(1).max(200).optional(),
    startUtc: z.string().min(10).max(40),
    timezone: z.string().min(1).max(64),
    name: z.string().trim().max(120).optional(), // legacy combined
    firstName: z.string().trim().max(60).optional(),
    lastName: z.string().trim().max(60).optional(),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
    answers: z.record(z.string(), answerValueSchema).optional(),
    source: z.enum(['web', 'embed']).optional(),
  })
  // Require either both first+last (new flow) or a combined name (legacy).
  .refine(
    (d) => (!!d.firstName && !!d.lastName) || (!!d.name && d.name.length > 0),
    { message: 'name_required' },
  );

publicRouter.post(
  '/api/bookings',
  wrap(async (req, res) => {
    if (!rateLimit(`book:${clientIp(req)}`, 10, 60_000)) {
      throw forbidden('Too many requests. Please wait a moment.', 'rate_limited');
    }
    const parsed = bookingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Please check the booking details and try again.', 'invalid_body');
    }
    const tz = validTz(parsed.data.timezone);
    if (!tz) throw badRequest('Invalid timezone.', 'bad_timezone');
    // Deep answer validation against the event type's questions happens inside
    // createBooking (server is authoritative); the zod above is a coarse guard.
    const { confirmation } = await createBooking({ ...parsed.data, timezone: tz });
    res.status(201).json(confirmation);
  }),
);

function manageView(b: Booking) {
  return {
    bookingId: b.id,
    status: b.status,
    eventTypeName: b.eventTypeName,
    startUtc: b.startUtc,
    endUtc: b.endUtc,
    durationMinutes: b.durationMinutes,
    timezone: b.invitee.timezone,
    inviteeName: b.invitee.name,
    location: b.location,
  };
}

publicRouter.get(
  '/api/bookings/:id',
  wrap(async (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const booking = await loadBookingForManage(req.params.id, token);
    res.json(manageView(booking));
  }),
);

const cancelSchema = z.object({
  token: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
});

publicRouter.post(
  '/api/bookings/:id/cancel',
  wrap(async (req, res) => {
    if (!rateLimit(`cancel:${clientIp(req)}`, 20, 60_000)) {
      throw forbidden('Too many requests.', 'rate_limited');
    }
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid request.', 'invalid_body');
    const booking = await cancelBooking(req.params.id, parsed.data.token, parsed.data.reason);
    res.json(manageView(booking));
  }),
);
