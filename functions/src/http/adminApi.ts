import { Router, type Request, type Response, type NextFunction } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { auth, db, ROOT, tenantDb } from '../firebase';
import {
  isEmulator,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OWNER_EMAIL,
  PLATFORM_OWNER_EMAIL,
} from '../config';
import { loadBranding, saveBranding } from '../branding';
import { tenantActive } from '../tenants';
import { makeOAuthClient, buildConsentUrl, listCalendars } from '../google/oauth';
import {
  loadMember,
  listMembers,
  loadMemberByEmail,
  createMember,
  updateMember,
  deleteMember,
  loadConnections,
  loadConnection,
  upsertConnection,
  setConnectionCalendars,
  setConnectionStatus,
  deleteConnection,
  publicConnection,
} from '../members';
import { resolveRedirectUri, safeValue } from './oauthRoutes';
import { slugify, randomToken, sanitizeForDocId } from '../util/ids';
import {
  ApiError,
  wrap,
  badRequest,
  notFound,
  conflict,
  unauthorized,
  forbidden,
} from '../util/http';
import type {
  EventType,
  AvailabilitySchedule,
  Booking,
  Member,
  MemberCalendarRef,
} from '../types';

export const adminRouter = Router();

type AdminRole = 'platform' | 'owner' | 'admin';

interface AdminRequest extends Request {
  uid?: string;
  adminEmail?: string;
  tenantId?: string;
  role?: AdminRole;
  memberId?: string | null;
}

/** Platform super-admin email: PLATFORM_OWNER_EMAIL, falling back to the legacy
 * OWNER_EMAIL so existing deployments keep cross-tenant access without a new env. */
function safePlatformOwnerEmail(): string {
  for (const p of [PLATFORM_OWNER_EMAIL, OWNER_EMAIL]) {
    try {
      const v = p.value().trim().toLowerCase();
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  return '';
}

/**
 * Tenant-scoped admin gate. Mounted at /api/admin/t/:tenantId, so the tenant is
 * the mount param and every handler derives its tenantDb from req.tenantId
 * (never a body/query field). Role: 'platform' (super-admin, any tenant),
 * 'owner' / 'admin' (a member of THIS tenant with isAdmin).
 */
async function requireAdmin(
  req: AdminRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenantId = req.params.tenantId;
    if (!tenantId) throw notFound('Unknown practice', 'no_tenant');

    const header = req.headers.authorization ?? '';
    const m = header.match(/^Bearer (.+)$/);
    if (!m) throw unauthorized();
    const decoded = await auth.verifyIdToken(m[1]);
    const email = decoded.email?.toLowerCase() ?? '';
    const verified = decoded.email_verified === true;

    // The tenant must exist and be active before we authenticate against it.
    const tenant = await tenantActive(tenantId);
    if (!tenant) throw notFound('Unknown practice', 'no_tenant');

    req.uid = decoded.uid;
    req.adminEmail = email;
    req.tenantId = tenantId;

    // Platform super-admin (global `admin` claim or the configured email) can
    // administer ANY tenant.
    const platformEmail = safePlatformOwnerEmail();
    const isPlatform =
      decoded.admin === true || (verified && !!platformEmail && email === platformEmail);
    if (isPlatform) {
      req.role = 'platform';
      req.memberId = null;
      next();
      return;
    }

    // Per-tenant member lookup (live, not claim-based) so a newly-added admin
    // gets in on first sign-in.
    let role: AdminRole | undefined;
    let memberId: string | null = null;
    if (verified && email) {
      const mem = await loadMemberByEmail(tenantId, email);
      if (mem && mem.active === true && mem.isAdmin === true) {
        memberId = mem.id;
        role = mem.role === 'owner' ? 'owner' : 'admin';
      }
    }

    // Emulator convenience: any signed-in user administers the tenant they hit.
    if (!role && isEmulator()) role = 'owner';

    if (!role) throw forbidden('Admin access required.', 'not_admin');

    req.role = role;
    req.memberId = memberId;
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : unauthorized());
  }
}

adminRouter.use('/api/admin/t/:tenantId', requireAdmin);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTz(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

/** Owner-or-platform gate for tenant-wide admin actions. */
function assertOwner(req: AdminRequest): void {
  if (req.role === 'platform' || req.role === 'owner') return;
  throw forbidden('Only the practice owner can do that.', 'owner_only');
}

/** Throws unless the caller may manage this member (platform/owner/self). */
function assertCanManageMember(req: AdminRequest, memberId: string): void {
  if (req.role === 'platform' || req.role === 'owner') return;
  if (req.memberId === memberId) return;
  throw forbidden('You can only manage your own provider profile.', 'forbidden');
}

const windowSchema = z.object({
  start: z.string().regex(HM_RE),
  end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
});

const locationSchema = z.object({
  type: z.enum(['google_meet', 'phone', 'in_person', 'custom']),
  details: z.string().max(500).optional(),
});

const questionSchema = z.object({
  id: z.string().min(1).max(60),
  type: z.enum(['text', 'textarea', 'phone', 'dropdown', 'checkboxes', 'checkbox']),
  label: z.string().trim().min(1).max(300),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  placeholder: z.string().max(200).optional(),
  helpText: z.string().max(500).optional(),
  sortOrder: z.number().int().default(0),
});

const eventTypeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  durationMinutes: z.number().int().min(5).max(1440),
  active: z.boolean().default(true),
  color: z.string().max(20).default('#0f766e'),
  location: locationSchema,
  memberIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  questions: z.array(questionSchema).max(50).default([]),
  availabilityScheduleId: z.string().min(1).optional(),
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
  memberId: z.string().min(1).max(200).nullable().optional(),
});

const brandingSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  tagline: z.string().max(200).optional(),
  avatarUrl: z.string().max(1_400_000).optional(), // allows an uploaded data: URL
  brandColor: z.string().max(20).optional(),
  welcomeText: z.string().max(1000).optional(),
  timezone: z.string().max(64).optional(),
  emailFrom: z.string().max(200).optional(),
  adsConversionId: z.string().max(40).optional(),
  adsConversionLabel: z.string().max(120).optional(),
  theme: z.enum(['dark', 'light', 'auto']).optional(),
});

const memberSchema = z.object({
  name: z.string().trim().min(1).max(120),
  title: z.string().max(120).optional(),
  email: z.string().trim().email().max(200),
  avatarUrl: z.string().max(1_400_000).optional(), // allows an uploaded data: URL
  bio: z.string().max(2000).optional(),
  active: z.boolean().default(true),
  featured: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  isAdmin: z.boolean().default(true),
  timezone: z.string().max(64).optional(),
  brandColor: z.string().max(20).optional(),
  defaultScheduleId: z.string().min(1).max(200).nullable().default(null),
});

async function ensureUniqueSlug(
  tenantId: string,
  desired: string,
  exceptId?: string,
): Promise<string> {
  const base = slugify(desired) || 'event';
  let candidate = base;
  let n = 1;
  for (;;) {
    const q = await tenantDb(tenantId).eventTypes().where('slug', '==', candidate).get();
    const clash = q.docs.some((d) => d.id !== exceptId);
    if (!clash) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

// ---- Identity ----
adminRouter.get(
  '/api/admin/t/:tenantId/me',
  wrap(async (req: AdminRequest, res) => {
    res.json({
      email: req.adminEmail ?? '',
      tenantId: req.tenantId ?? '',
      role: req.role ?? 'admin',
      memberId: req.memberId ?? null,
    });
  }),
);

// ---- Members (providers) ----
adminRouter.get(
  '/api/admin/t/:tenantId/members',
  wrap(async (req: AdminRequest, res) => {
    const members = await listMembers(req.tenantId!);
    res.json({ members });
  }),
);

/** Reject a create/update whose email already belongs to another member. */
async function assertEmailFree(
  tenantId: string,
  email: string,
  exceptId?: string,
): Promise<void> {
  const existing = await loadMemberByEmail(tenantId, email);
  if (existing && existing.id !== exceptId) {
    throw conflict('That email already belongs to another provider.', 'email_taken');
  }
}

/** Generate a collision-free member id like `mbr_anna_payne`, scoped to tenant. */
async function uniqueMemberId(tenantId: string, name: string): Promise<string> {
  const base = `mbr_${sanitizeForDocId(name.toLowerCase()).replace(/-+/g, '_')}`.slice(0, 100) || 'mbr_x';
  let candidate = base;
  let n = 1;
  for (;;) {
    const snap = await tenantDb(tenantId).members().doc(candidate).get();
    if (!snap.exists) return candidate;
    n += 1;
    candidate = `${base}_${n}`;
  }
}

adminRouter.post(
  '/api/admin/t/:tenantId/members',
  wrap(async (req: AdminRequest, res) => {
    assertOwner(req);
    const tenantId = req.tenantId!;
    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid provider.', 'invalid_body');
    if (parsed.data.timezone && !validTz(parsed.data.timezone)) {
      throw badRequest('Invalid timezone.', 'bad_timezone');
    }
    const email = parsed.data.email.trim().toLowerCase();
    await assertEmailFree(tenantId, email);
    const id = await uniqueMemberId(tenantId, parsed.data.name);
    // New providers are admins by default but never 'owner' (single owner/tenant).
    const member = await createMember(tenantId, id, { ...parsed.data, email, role: 'admin' });
    res.status(201).json(member);
  }),
);

adminRouter.put(
  '/api/admin/t/:tenantId/members/:id',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const id = req.params.id;
    const existing = await loadMember(tenantId, id);
    if (!existing) throw notFound('Provider not found', 'no_member');

    const isOwner = req.role === 'platform' || req.role === 'owner';
    const isSelf = req.memberId === id;
    if (!isOwner && !isSelf) {
      throw forbidden('You can only edit your own provider profile.', 'forbidden');
    }

    const parsed = memberSchema.partial().safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid provider.', 'invalid_body');
    const patch: Partial<Member> = { ...parsed.data };

    if (patch.timezone && !validTz(patch.timezone)) {
      throw badRequest('Invalid timezone.', 'bad_timezone');
    }
    if (typeof patch.email === 'string') {
      const email = patch.email.trim().toLowerCase();
      await assertEmailFree(tenantId, email, id);
      patch.email = email;
    }

    // Non-owners cannot change admin/email or another member's gatekeeping fields.
    if (!isOwner) {
      delete patch.isAdmin;
      delete patch.email;
      delete patch.active;
      delete patch.featured;
    }
    // The owner member must always stay an active admin (cannot lock the tenant out).
    if (existing.role === 'owner') {
      patch.isAdmin = true;
      patch.active = true;
    }

    const member = await updateMember(tenantId, id, patch);
    res.json(member);
  }),
);

adminRouter.delete(
  '/api/admin/t/:tenantId/members/:id',
  wrap(async (req: AdminRequest, res) => {
    assertOwner(req);
    const tenantId = req.tenantId!;
    const id = req.params.id;
    const existing = await loadMember(tenantId, id);
    if (!existing) throw notFound('Provider not found', 'no_member');
    if (existing.role === 'owner') {
      throw conflict('The practice owner cannot be removed.', 'cannot_delete_owner');
    }
    if (req.adminEmail && existing.email === req.adminEmail) {
      throw conflict('You cannot remove yourself.', 'cannot_delete_self');
    }
    // Refuse to orphan event types — never silently drop clinical config.
    const refs = await tenantDb(tenantId)
      .eventTypes()
      .where('memberIds', 'array-contains', id)
      .limit(1)
      .get();
    if (!refs.empty) {
      throw conflict(
        'This provider is still offered on one or more meeting types. Remove them there first, or deactivate the provider instead.',
        'member_in_use',
      );
    }
    await deleteMember(tenantId, id);
    res.json({ ok: true });
  }),
);

// ---- Per-member Google connections ----

adminRouter.get(
  '/api/admin/t/:tenantId/members/:id/google/auth-url',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const memberId = req.params.id;
    const member = await loadMember(tenantId, memberId);
    if (!member) throw notFound('Provider not found', 'no_member');
    assertCanManageMember(req, memberId);

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
      .collection(ROOT.oauthStates)
      .doc(state)
      .set({ adminUid: req.uid ?? null, tenantId, memberId, createdAt: new Date().toISOString() });
    const client = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
    res.json({ url: buildConsentUrl(client, state) });
  }),
);

adminRouter.get(
  '/api/admin/t/:tenantId/members/:id/connections',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const memberId = req.params.id;
    const member = await loadMember(tenantId, memberId);
    if (!member) throw notFound('Provider not found', 'no_member');
    assertCanManageMember(req, memberId);
    const conns = await loadConnections(tenantId, memberId);
    res.json({
      connections: conns.map((c) => publicConnection(c, member)), // refreshToken STRIPPED
      writeConnectionId: member.writeConnectionId ?? null,
      writeCalendarId: member.writeCalendarId ?? null,
    });
  }),
);

adminRouter.post(
  '/api/admin/t/:tenantId/members/:id/connections/:connId/refresh',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const memberId = req.params.id;
    const connIdParam = req.params.connId;
    const member = await loadMember(tenantId, memberId);
    if (!member) throw notFound('Provider not found', 'no_member');
    assertCanManageMember(req, memberId);
    const conn = await loadConnection(tenantId, memberId, connIdParam);
    if (!conn) throw notFound('Connection not found', 'no_connection');

    const clientId = safeValue(GOOGLE_CLIENT_ID);
    const clientSecret = safeValue(GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw badRequest('Google OAuth is not configured.', 'google_unconfigured');
    }
    const oauth = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
    oauth.setCredentials({ refresh_token: conn.refreshToken });
    let calendars: MemberCalendarRef[];
    try {
      calendars = await listCalendars(oauth);
    } catch (err) {
      if (isInvalidGrant(err)) {
        await setConnectionStatus(tenantId, memberId, connIdParam, 'revoked');
        throw conflict('This Google account needs to be reconnected.', 'connection_revoked');
      }
      throw err;
    }
    const updated = await upsertConnection(tenantId, memberId, {
      accountEmail: conn.accountEmail,
      refreshToken: conn.refreshToken,
      scope: conn.scope,
      calendars,
    });
    res.json({ calendars: updated.calendars });
  }),
);

const selectionsSchema = z.object({
  selections: z
    .array(z.object({ calendarId: z.string().min(1).max(300), selected: z.boolean() }))
    .max(250),
});

adminRouter.patch(
  '/api/admin/t/:tenantId/members/:id/connections/:connId/calendars',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const memberId = req.params.id;
    const connIdParam = req.params.connId;
    const member = await loadMember(tenantId, memberId);
    if (!member) throw notFound('Provider not found', 'no_member');
    assertCanManageMember(req, memberId);
    const conn = await loadConnection(tenantId, memberId, connIdParam);
    if (!conn) throw notFound('Connection not found', 'no_connection');

    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid selections.', 'invalid_body');

    const byId = new Map(conn.calendars.map((c) => [c.calendarId, c]));
    for (const sel of parsed.data.selections) {
      if (!byId.has(sel.calendarId)) {
        throw badRequest('Unknown calendar.', 'unknown_calendar');
      }
    }
    const wanted = new Map(parsed.data.selections.map((s) => [s.calendarId, s.selected]));
    const calendars = conn.calendars.map((c) =>
      wanted.has(c.calendarId) ? { ...c, selected: !!wanted.get(c.calendarId) } : c,
    );
    await setConnectionCalendars(tenantId, memberId, connIdParam, calendars);
    res.json({ calendars });
  }),
);

const writeTargetSchema = z.object({
  connectionId: z.string().min(1).max(200),
  calendarId: z.string().min(1).max(300),
});

adminRouter.put(
  '/api/admin/t/:tenantId/members/:id/write-target',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const memberId = req.params.id;
    const member = await loadMember(tenantId, memberId);
    if (!member) throw notFound('Provider not found', 'no_member');
    assertCanManageMember(req, memberId);

    const parsed = writeTargetSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid write target.', 'invalid_body');
    const { connectionId, calendarId } = parsed.data;

    const conn = await loadConnection(tenantId, memberId, connectionId);
    if (!conn || conn.status !== 'active') {
      throw badRequest('That connection is not active.', 'no_connection');
    }
    const cal = conn.calendars.find((c) => c.calendarId === calendarId);
    if (!cal) throw badRequest('Unknown calendar.', 'unknown_calendar');
    if (!cal.writable) {
      throw badRequest('That calendar is read-only and cannot host events.', 'calendar_not_writable');
    }
    await updateMember(tenantId, memberId, {
      writeConnectionId: connectionId,
      writeCalendarId: calendarId,
    });
    res.json({ writeConnectionId: connectionId, writeCalendarId: calendarId });
  }),
);

adminRouter.delete(
  '/api/admin/t/:tenantId/members/:id/connections/:connId',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const memberId = req.params.id;
    const connIdParam = req.params.connId;
    const member = await loadMember(tenantId, memberId);
    if (!member) throw notFound('Provider not found', 'no_member');
    assertCanManageMember(req, memberId);
    const conn = await loadConnection(tenantId, memberId, connIdParam);
    if (!conn) throw notFound('Connection not found', 'no_connection');

    // Best-effort token revoke (ignore failures), then drop the connection doc.
    const clientId = safeValue(GOOGLE_CLIENT_ID);
    const clientSecret = safeValue(GOOGLE_CLIENT_SECRET);
    if (clientId && clientSecret && conn.refreshToken) {
      try {
        const oauth = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
        await oauth.revokeToken(conn.refreshToken);
      } catch {
        /* ignore — local delete is the source of truth */
      }
    }
    await deleteConnection(tenantId, memberId, connIdParam);
    res.json({ ok: true });
  }),
);

function isInvalidGrant(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } } | undefined;
  return (
    e?.response?.data?.error === 'invalid_grant' ||
    (typeof e?.message === 'string' && e.message.includes('invalid_grant'))
  );
}

// ---- Event types ----
adminRouter.get(
  '/api/admin/t/:tenantId/event-types',
  wrap(async (req: AdminRequest, res) => {
    const q = await tenantDb(req.tenantId!).eventTypes().get();
    const types = q.docs
      .map((d) => ({ id: d.id, ...d.data() }) as EventType)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    res.json({ eventTypes: types });
  }),
);

adminRouter.post(
  '/api/admin/t/:tenantId/event-types',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const parsed = eventTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid event type.', 'invalid_body');
    const data = parsed.data;
    const slug = await ensureUniqueSlug(tenantId, data.slug || data.name);
    const now = new Date().toISOString();
    const ref = tenantDb(tenantId).eventTypes().doc();
    const doc: EventType = { ...data, id: ref.id, slug, createdAt: now, updatedAt: now };
    await ref.set(doc);
    res.status(201).json(doc);
  }),
);

adminRouter.put(
  '/api/admin/t/:tenantId/event-types/:id',
  wrap(async (req: AdminRequest, res) => {
    const tenantId = req.tenantId!;
    const ref = tenantDb(tenantId).eventTypes().doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('Event type not found', 'no_event_type');
    const parsed = eventTypeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid event type.', 'invalid_body');
    const slug = await ensureUniqueSlug(tenantId, parsed.data.slug || parsed.data.name, req.params.id);
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
  '/api/admin/t/:tenantId/event-types/:id',
  wrap(async (req: AdminRequest, res) => {
    await tenantDb(req.tenantId!).eventTypes().doc(req.params.id).delete();
    res.json({ ok: true });
  }),
);

// ---- Availability schedules ----
adminRouter.get(
  '/api/admin/t/:tenantId/schedules',
  wrap(async (req: AdminRequest, res) => {
    const q = await tenantDb(req.tenantId!).schedules().get();
    const schedules = q.docs.map((d) => ({ id: d.id, ...d.data() }) as AvailabilitySchedule);
    res.json({ schedules });
  }),
);

adminRouter.post(
  '/api/admin/t/:tenantId/schedules',
  wrap(async (req: AdminRequest, res) => {
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success || !validTz(parsed.data.timezone)) {
      throw badRequest('Invalid schedule.', 'invalid_body');
    }
    const now = new Date().toISOString();
    const ref = tenantDb(req.tenantId!).schedules().doc();
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
  '/api/admin/t/:tenantId/schedules/:id',
  wrap(async (req: AdminRequest, res) => {
    const ref = tenantDb(req.tenantId!).schedules().doc(req.params.id);
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
  '/api/admin/t/:tenantId/schedules/:id',
  wrap(async (req: AdminRequest, res) => {
    await tenantDb(req.tenantId!).schedules().doc(req.params.id).delete();
    res.json({ ok: true });
  }),
);

// ---- Bookings (admin view) ----
adminRouter.get(
  '/api/admin/t/:tenantId/bookings',
  wrap(async (req: AdminRequest, res) => {
    // Bounds MUST be canonical UTC "…Z" strings to match stored startUtc.
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
    const q = await tenantDb(req.tenantId!)
      .bookings()
      .where('startUtc', '>=', from)
      .where('startUtc', '<', to)
      .orderBy('startUtc', 'asc')
      .get();
    const bookings = q.docs.map((d) => ({ id: d.id, ...d.data() }) as Booking);
    res.json({ bookings });
  }),
);

// ---- Branding (folded into the tenant doc) ----
adminRouter.get(
  '/api/admin/t/:tenantId/branding',
  wrap(async (req: AdminRequest, res) => {
    res.json(await loadBranding(req.tenantId!));
  }),
);

adminRouter.put(
  '/api/admin/t/:tenantId/branding',
  wrap(async (req: AdminRequest, res) => {
    const parsed = brandingSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid branding.', 'invalid_body');
    if (parsed.data.timezone && !validTz(parsed.data.timezone)) {
      throw badRequest('Invalid timezone.', 'bad_timezone');
    }
    res.json(await saveBranding(req.tenantId!, parsed.data));
  }),
);
