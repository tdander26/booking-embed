import { Router, type Request, type Response, type NextFunction } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { auth, db, COL } from '../firebase';
import { isEmulator, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../config';
import { loadBranding, saveBranding } from '../branding';
import { loadGoogleTokens, makeOAuthClient, buildConsentUrl } from '../google/oauth';
import { resolveRedirectUri, safeValue } from './oauthRoutes';
import { slugify, randomToken } from '../util/ids';
import {
  ApiError,
  wrap,
  badRequest,
  notFound,
  unauthorized,
  forbidden,
} from '../util/http';
import type { EventType, AvailabilitySchedule, Booking } from '../types';

export const adminRouter = Router();

interface AdminRequest extends Request {
  uid?: string;
}

async function requireAdmin(
  req: AdminRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? '';
    const m = header.match(/^Bearer (.+)$/);
    if (!m) throw unauthorized();
    const decoded = await auth.verifyIdToken(m[1]);
    // Production requires the `admin` custom claim. In the emulator any signed-in
    // user is treated as admin so local development needs no claim wiring.
    if (!isEmulator() && decoded.admin !== true) {
      throw forbidden('Admin access required.', 'not_admin');
    }
    req.uid = decoded.uid;
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : unauthorized());
  }
}

adminRouter.use('/api/admin', requireAdmin);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTz(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

const windowSchema = z.object({
  start: z.string().regex(HM_RE),
  end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
});

const locationSchema = z.object({
  type: z.enum(['google_meet', 'phone', 'in_person', 'custom']),
  details: z.string().max(500).optional(),
});

const eventTypeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  durationMinutes: z.number().int().min(5).max(1440),
  active: z.boolean().default(true),
  color: z.string().max(20).default('#0f766e'),
  location: locationSchema,
  availabilityScheduleId: z.string().min(1),
  bufferBeforeMinutes: z.number().int().min(0).max(480).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(480).default(0),
  minNoticeMinutes: z.number().int().min(0).max(100_000).default(120),
  maxDaysInFuture: z.number().int().min(1).max(365).default(60),
  slotIntervalMinutes: z.number().int().min(5).max(240).default(30),
  dailyBookingLimit: z.number().int().min(1).max(100).nullable().default(null),
  collectPhone: z.boolean().default(false),
  remindersMinutesBefore: z.array(z.number().int().min(0).max(20_160)).max(5).default([1440, 60]),
  sortOrder: z.number().int().default(0),
});

const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().min(1).max(64),
  weekly: z.record(z.string(), z.array(windowSchema)).default({}),
  overrides: z
    .array(z.object({ date: z.string().regex(DATE_RE), windows: z.array(windowSchema) }))
    .default([]),
});

const brandingSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  tagline: z.string().max(200).optional(),
  avatarUrl: z.string().max(500).optional(),
  brandColor: z.string().max(20).optional(),
  welcomeText: z.string().max(1000).optional(),
  timezone: z.string().max(64).optional(),
});

async function ensureUniqueSlug(desired: string, exceptId?: string): Promise<string> {
  let base = slugify(desired) || 'event';
  let candidate = base;
  let n = 1;
  // Small loop; event types are few.
  for (;;) {
    const q = await db.collection(COL.eventTypes).where('slug', '==', candidate).get();
    const clash = q.docs.some((d) => d.id !== exceptId);
    if (!clash) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

// ---- Event types ----
adminRouter.get(
  '/api/admin/event-types',
  wrap(async (_req, res) => {
    const q = await db.collection(COL.eventTypes).get();
    const types = q.docs
      .map((d) => ({ id: d.id, ...d.data() }) as EventType)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    res.json({ eventTypes: types });
  }),
);

adminRouter.post(
  '/api/admin/event-types',
  wrap(async (req, res) => {
    const parsed = eventTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid event type.', 'invalid_body');
    const data = parsed.data;
    const slug = await ensureUniqueSlug(data.slug || data.name);
    const now = new Date().toISOString();
    const ref = db.collection(COL.eventTypes).doc();
    const doc: EventType = { ...data, id: ref.id, slug, createdAt: now, updatedAt: now };
    await ref.set(doc);
    res.status(201).json(doc);
  }),
);

adminRouter.put(
  '/api/admin/event-types/:id',
  wrap(async (req, res) => {
    const ref = db.collection(COL.eventTypes).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('Event type not found', 'no_event_type');
    const parsed = eventTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid event type.', 'invalid_body');
    const slug = await ensureUniqueSlug(parsed.data.slug || parsed.data.name, req.params.id);
    const updated: EventType = {
      ...parsed.data,
      id: req.params.id,
      slug,
      createdAt: (snap.data() as EventType).createdAt,
      updatedAt: new Date().toISOString(),
    };
    await ref.set(updated);
    res.json(updated);
  }),
);

adminRouter.delete(
  '/api/admin/event-types/:id',
  wrap(async (req, res) => {
    await db.collection(COL.eventTypes).doc(req.params.id).delete();
    res.json({ ok: true });
  }),
);

// ---- Availability schedules ----
adminRouter.get(
  '/api/admin/schedules',
  wrap(async (_req, res) => {
    const q = await db.collection(COL.schedules).get();
    const schedules = q.docs.map((d) => ({ id: d.id, ...d.data() }) as AvailabilitySchedule);
    res.json({ schedules });
  }),
);

adminRouter.post(
  '/api/admin/schedules',
  wrap(async (req, res) => {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success || !validTz(parsed.data.timezone)) {
      throw badRequest('Invalid schedule.', 'invalid_body');
    }
    const now = new Date().toISOString();
    const ref = db.collection(COL.schedules).doc();
    const doc: AvailabilitySchedule = {
      ...parsed.data,
      id: ref.id,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(doc);
    res.status(201).json(doc);
  }),
);

adminRouter.put(
  '/api/admin/schedules/:id',
  wrap(async (req, res) => {
    const ref = db.collection(COL.schedules).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('Schedule not found', 'no_schedule');
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success || !validTz(parsed.data.timezone)) {
      throw badRequest('Invalid schedule.', 'invalid_body');
    }
    const doc: AvailabilitySchedule = {
      ...parsed.data,
      id: req.params.id,
      createdAt: (snap.data() as AvailabilitySchedule).createdAt,
      updatedAt: new Date().toISOString(),
    };
    await ref.set(doc);
    res.json(doc);
  }),
);

adminRouter.delete(
  '/api/admin/schedules/:id',
  wrap(async (req, res) => {
    await db.collection(COL.schedules).doc(req.params.id).delete();
    res.json({ ok: true });
  }),
);

// ---- Bookings (admin view) ----
adminRouter.get(
  '/api/admin/bookings',
  wrap(async (req, res) => {
    // Bounds MUST be canonical UTC "…Z" strings to match stored startUtc
    // (which is always new Date(ms).toISOString()); Luxon's toISO() emits a
    // "+00:00" suffix that breaks the lexical === chronological invariant the
    // Firestore range query relies on.
    const from =
      typeof req.query.from === 'string' && DATE_RE.test(req.query.from)
        ? new Date(DateTime.fromISO(req.query.from, { zone: 'utc' }).toMillis()).toISOString()
        : new Date(Date.now() - 86_400_000).toISOString();
    const to =
      typeof req.query.to === 'string' && DATE_RE.test(req.query.to)
        ? new Date(
            DateTime.fromISO(req.query.to, { zone: 'utc' }).plus({ days: 1 }).toMillis(),
          ).toISOString()
        : new Date(Date.now() + 60 * 86_400_000).toISOString();
    const q = await db
      .collection(COL.bookings)
      .where('startUtc', '>=', from)
      .where('startUtc', '<', to)
      .orderBy('startUtc', 'asc')
      .get();
    const bookings = q.docs.map((d) => ({ id: d.id, ...d.data() }) as Booking);
    res.json({ bookings });
  }),
);

// ---- Branding ----
adminRouter.get(
  '/api/admin/branding',
  wrap(async (_req, res) => {
    res.json(await loadBranding());
  }),
);

adminRouter.put(
  '/api/admin/branding',
  wrap(async (req, res) => {
    const parsed = brandingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid branding.', 'invalid_body');
    if (parsed.data.timezone && !validTz(parsed.data.timezone)) {
      throw badRequest('Invalid timezone.', 'bad_timezone');
    }
    res.json(await saveBranding(parsed.data));
  }),
);

// ---- Google connection status / disconnect (connect flow lives in oauthRoutes) ----
adminRouter.get(
  '/api/admin/google/status',
  wrap(async (_req, res) => {
    const tokens = await loadGoogleTokens();
    res.json({
      connected: !!tokens?.refreshToken,
      email: tokens?.connectedEmail ?? null,
      calendarId: tokens?.calendarId ?? 'primary',
    });
  }),
);

adminRouter.get(
  '/api/admin/google/auth-url',
  wrap(async (req: AdminRequest, res) => {
    const clientId = safeValue(GOOGLE_CLIENT_ID);
    const clientSecret = safeValue(GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw badRequest(
        'Google OAuth is not configured. Set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.',
        'google_unconfigured',
      );
    }
    const state = randomToken(18);
    await db
      .collection(COL.oauthStates)
      .doc(state)
      .set({ adminUid: req.uid ?? null, createdAt: new Date().toISOString() });
    const client = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
    res.json({ url: buildConsentUrl(client, state) });
  }),
);

adminRouter.post(
  '/api/admin/google/disconnect',
  wrap(async (_req, res) => {
    const { clearGoogleTokens } = await import('../google/oauth');
    await clearGoogleTokens();
    res.json({ ok: true });
  }),
);
