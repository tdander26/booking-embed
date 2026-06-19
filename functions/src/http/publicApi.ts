import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { loadBranding } from '../branding';
import {
  loadEventTypeById,
  loadEventTypeBySlug,
  computeAvailability,
} from '../scheduling/availability';
import {
  createBooking,
  cancelBooking,
  loadBookingForManage,
} from '../scheduling/booking';
import { wrap, badRequest, notFound, forbidden } from '../util/http';
import { rateLimit } from '../util/ratelimit';
import type { Branding, EventType, PublicEventType, Booking } from '../types';

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

function toPublic(e: EventType): PublicEventType {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    durationMinutes: e.durationMinutes,
    color: e.color,
    location: { type: e.location.type, details: e.location.details },
    collectPhone: e.collectPhone,
    minNoticeMinutes: e.minNoticeMinutes,
    maxDaysInFuture: e.maxDaysInFuture,
  };
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
    const q = await db.collection(COL.eventTypes).where('active', '==', true).get();
    const types = q.docs
      .map((d) => ({ id: d.id, ...d.data() }) as EventType)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(toPublic);
    res.json({ eventTypes: types });
  }),
);

publicRouter.get(
  '/api/event-types/:slug',
  wrap(async (req, res) => {
    const e = await loadEventTypeBySlug(req.params.slug);
    if (!e || !e.active) throw notFound('Event type not found', 'no_event_type');
    res.json(toPublic(e));
  }),
);

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
      fromDate: from,
      toDate: to,
      inviteeTz: tz,
    });
    res.json(result);
  }),
);

const bookingSchema = z.object({
  eventTypeId: z.string().min(1).max(200),
  startUtc: z.string().min(10).max(40),
  timezone: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
  source: z.enum(['web', 'embed']).optional(),
});

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
