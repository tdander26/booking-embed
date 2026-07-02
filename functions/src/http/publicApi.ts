import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { DEFAULT_TENANT, tenantDb } from '../firebase';
import { tenantActive } from '../tenants';
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
  rescheduleBooking,
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

/** Tenant for this request: the `:tenantId` path param, or the default tenant
 * for legacy slug-less routes (keeps live embeds working). */
function tid(req: Request): string {
  const p = req.params.tenantId;
  return typeof p === 'string' && p ? p : DEFAULT_TENANT;
}

/** Resolve + assert the tenant is active; throws notFound otherwise. */
async function requireTenant(req: Request): Promise<string> {
  const id = tid(req);
  const t = await tenantActive(id);
  if (!t) throw notFound('Practice not found', 'no_tenant');
  return id;
}

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

/** Register a handler on BOTH the legacy slug-less path and the tenant path. */
function dual(path: string): string[] {
  return [`/api/${path}`, `/api/t/:tenantId/${path}`];
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
async function activeMemberMap(tenantId: string): Promise<Map<string, Member>> {
  const members = await listActiveMembers(tenantId);
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
    theme: b.theme ?? 'dark',
    // Public Google Ads conversion config (fired client-side on confirmation).
    adsConversionId: (b as { adsConversionId?: string }).adsConversionId ?? '',
    adsConversionLabel: (b as { adsConversionLabel?: string }).adsConversionLabel ?? '',
  };
}

publicRouter.get(
  dual('branding'),
  wrap(async (req, res) => {
    res.json(publicBranding(await loadBranding(tid(req))));
  }),
);

publicRouter.get(
  dual('event-types'),
  wrap(async (req, res) => {
    const tenantId = await requireTenant(req);
    const [q, memberMap] = await Promise.all([
      tenantDb(tenantId).eventTypes().where('active', '==', true).get(),
      activeMemberMap(tenantId),
    ]);
    const types = q.docs
      .map((d) => ({ id: d.id, ...d.data() }) as EventType)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((e) => toPublic(e, memberMap));
    res.json({ eventTypes: types });
  }),
);

publicRouter.get(
  dual('event-types/:slug'),
  wrap(async (req, res) => {
    const tenantId = await requireTenant(req);
    const [e, memberMap] = await Promise.all([
      loadEventTypeBySlug(tenantId, req.params.slug),
      activeMemberMap(tenantId),
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
  dual('availability'),
  wrap(async (req, res) => {
    const tenantId = await requireTenant(req);
    const id = typeof req.query.eventTypeId === 'string' ? req.query.eventTypeId : undefined;
    const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
    const e = id
      ? await loadEventTypeById(tenantId, id)
      : slug
        ? await loadEventTypeBySlug(tenantId, slug)
        : null;
    if (!e || !e.active) throw notFound('Event type not found', 'no_event_type');

    const memberId = resolveMemberId(e, req.query.memberId);

    const branding = await loadBranding(tenantId);
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
      tenantId,
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
  dual('next-available'),
  wrap(async (req, res) => {
    if (!rateLimit(`nextavail:${clientIp(req)}`, 30, 60_000)) {
      throw forbidden('Too many requests. Please wait a moment.', 'rate_limited');
    }
    const tenantId = await requireTenant(req);
    const eventTypeId = typeof req.query.eventTypeId === 'string' ? req.query.eventTypeId : '';
    if (!eventTypeId) throw badRequest('Missing event type.', 'invalid_body');
    const e = await loadEventTypeById(tenantId, eventTypeId);
    if (!e || !e.active) throw notFound('Event type not found', 'no_event_type');

    const branding = await loadBranding(tenantId);
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

    // 60s in-memory cache keyed on tenant, type, sorted members, tz, and the
    // local day (so it rolls over at midnight in the invitee's zone).
    const todayInTz = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
    const cacheKey = `${tenantId}|${e.id}|${[...memberIds].sort().join(',')}|${tz}|${todayInTz}`;
    const cached = nextAvailCache.get(cacheKey);
    if (cached && Date.now() - cached.at < NEXT_AVAIL_TTL_MS) {
      res.json(cached.value);
      return;
    }

    // Per-member scan with per-member error isolation: one provider's calendar
    // error never dead-ends the whole response.
    const providers: NextAvailableProvider[] = await Promise.all(
      memberIds.map((memberId) =>
        nextAvailableForMember(tenantId, e, memberId, tz).catch(
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
  dual('bookings'),
  wrap(async (req, res) => {
    if (!rateLimit(`book:${clientIp(req)}`, 10, 60_000)) {
      throw forbidden('Too many requests. Please wait a moment.', 'rate_limited');
    }
    const tenantId = await requireTenant(req);
    const parsed = bookingSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('Please check the booking details and try again.', 'invalid_body');
    }
    const tz = validTz(parsed.data.timezone);
    if (!tz) throw badRequest('Invalid timezone.', 'bad_timezone');
    // Deep answer validation against the event type's questions happens inside
    // createBooking (server is authoritative); the zod above is a coarse guard.
    const { confirmation } = await createBooking(tenantId, { ...parsed.data, timezone: tz });
    res.status(201).json(confirmation);
  }),
);

function manageView(b: Booking) {
  return {
    bookingId: b.id,
    status: b.status,
    eventTypeId: b.eventTypeId,
    eventTypeName: b.eventTypeName,
    memberId: b.memberId,
    providerName: b.memberName,
    startUtc: b.startUtc,
    endUtc: b.endUtc,
    durationMinutes: b.durationMinutes,
    timezone: b.invitee.timezone,
    inviteeName: b.invitee.name,
    location: b.location,
  };
}

publicRouter.get(
  dual('bookings/:id'),
  wrap(async (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const booking = await loadBookingForManage(tid(req), req.params.id, token);
    res.json(manageView(booking));
  }),
);

const cancelSchema = z.object({
  token: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
});

publicRouter.post(
  dual('bookings/:id/cancel'),
  wrap(async (req, res) => {
    if (!rateLimit(`cancel:${clientIp(req)}`, 20, 60_000)) {
      throw forbidden('Too many requests.', 'rate_limited');
    }
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid request.', 'invalid_body');
    const booking = await cancelBooking(tid(req), req.params.id, parsed.data.token, parsed.data.reason);
    res.json(manageView(booking));
  }),
);

const rescheduleSchema = z.object({
  token: z.string().min(1).max(200),
  startUtc: z.string().min(1).max(40),
});

publicRouter.post(
  dual('bookings/:id/reschedule'),
  wrap(async (req, res) => {
    if (!rateLimit(`reschedule:${clientIp(req)}`, 20, 60_000)) {
      throw forbidden('Too many requests.', 'rate_limited');
    }
    const parsed = rescheduleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid request.', 'invalid_body');
    const booking = await rescheduleBooking(tid(req), req.params.id, parsed.data.token, parsed.data.startUtc);
    res.json(manageView(booking));
  }),
);
