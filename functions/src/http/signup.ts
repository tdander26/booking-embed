/**
 * Self-serve onboarding (gated by an access code) + platform-owner code minting.
 *
 *   POST /api/signup                      public, needs a verified Google token
 *   POST /api/platform/signup-codes       platform owner only — mint a code
 *   GET  /api/platform/signup-codes       platform owner only — list (no raw codes)
 *
 * A new practice is created atomically: the tenant doc (branding folded in), an
 * owner member (role:'owner'), a default Mon–Fri schedule, and a starter event
 * type — so the practice is bookable immediately. Access codes are stored hashed
 * (sha256) at the platform root; a shared SIGNUP_ACCESS_CODE env value is also
 * accepted as a first-deploy fallback.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db, ROOT, tenantRef, tenantDb } from '../firebase';
import { PLATFORM_OWNER_EMAIL, OWNER_EMAIL, SIGNUP_ACCESS_CODE } from '../config';
import { slugify, randomToken } from '../util/ids';
import { wrap, badRequest, conflict, forbidden, unauthorized } from '../util/http';
import { rateLimit } from '../util/ratelimit';
import type { Tenant, Member, AvailabilitySchedule, EventType, SignupCode } from '../types';

export const signupRouter = Router();

/** Slugs that would shadow a route (kept in sync with the SPA's RESERVED set). */
const RESERVED_SLUGS = new Set([
  'api', 'admin', 'manage', 'signup', 'embed.js', 'assets', 'favicon.ico',
  'index.html', 'robots.txt', 'sitemap.xml', 'well-known', '.well-known',
  't', 'static', 'public', 'app', 'login', 'logout', 'auth',
]);

function isValidSlug(slug: string): boolean {
  if (slug.length < 3 || slug.length > 60) return false;
  if (!/^[a-z0-9-]+$/.test(slug)) return false;
  if (/^-|-$/.test(slug)) return false;
  if (/^\d+$/.test(slug)) return false; // all-numeric
  if (RESERVED_SLUGS.has(slug)) return false;
  return true;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

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

function safeCode(): string {
  try {
    return SIGNUP_ACCESS_CODE.value().trim();
  } catch {
    return '';
  }
}

function clientIp(req: Request): string {
  return req.ip || 'unknown';
}

/** Verify the Firebase ID token; return { uid, email, name }. */
async function verifyUser(
  req: Request,
): Promise<{ uid: string; email: string; name: string }> {
  const m = (req.headers.authorization ?? '').match(/^Bearer (.+)$/);
  if (!m) throw unauthorized();
  const decoded = await auth.verifyIdToken(m[1]);
  if (decoded.email_verified !== true || !decoded.email) {
    throw forbidden('A verified Google account is required.', 'email_unverified');
  }
  return {
    uid: decoded.uid,
    email: decoded.email.toLowerCase(),
    name: (decoded.name as string) || decoded.email.split('@')[0],
  };
}

async function requirePlatformOwner(req: Request): Promise<string> {
  const { email } = await verifyUser(req);
  const owner = safePlatformOwnerEmail();
  if (!owner || email !== owner) throw forbidden('Platform owner only.', 'platform_only');
  return email;
}

const signupSchema = z.object({
  practiceName: z.string().trim().min(1).max(120),
  desiredSlug: z.string().trim().min(1).max(60),
  accessCode: z.string().trim().min(1).max(200),
  timezone: z.string().max(64).optional(),
});

// ---- POST /api/signup ----
signupRouter.post(
  '/api/signup',
  wrap(async (req, res) => {
    if (!rateLimit(`signup:${clientIp(req)}`, 5, 60_000)) {
      throw forbidden('Too many sign-up attempts. Please wait a moment.', 'rate_limited');
    }
    const user = await verifyUser(req);
    if (!rateLimit(`signup-uid:${user.uid}`, 5, 60_000)) {
      throw forbidden('Too many sign-up attempts. Please wait a moment.', 'rate_limited');
    }

    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Please check the form and try again.', 'invalid_body');
    const { practiceName, accessCode } = parsed.data;
    const slug = slugify(parsed.data.desiredSlug || practiceName);
    if (!isValidSlug(slug)) {
      throw badRequest('That URL name is reserved or invalid. Try another.', 'invalid_slug');
    }
    const timezone = parsed.data.timezone || 'America/Chicago';

    // One tenant per Google account (best-effort; the tx re-checks the slug).
    const owned = await db
      .collection(ROOT.tenants)
      .where('ownerEmail', '==', user.email)
      .limit(1)
      .get();
    if (!owned.empty) {
      const existingSlug = owned.docs[0].id;
      throw conflict(
        `You already manage a practice ("${existingSlug}").`,
        'already_owner',
      );
    }

    const envCode = safeCode();
    const usingEnvCode = !!envCode && accessCode === envCode;
    const codeHash = sha256(accessCode);
    const codeRef = db.collection(ROOT.signupCodes).doc(codeHash);

    const now = new Date().toISOString();
    const ownerMemberId = 'mbr_owner';
    const scheduleId = 'sched_default';

    try {
      await db.runTransaction(async (tx) => {
        // --- reads first ---
        const tenantSnap = await tx.get(tenantRef(slug));
        if (tenantSnap.exists) {
          const e = new Error('slug_taken');
          (e as Error & { code?: string }).code = 'slug_taken';
          throw e;
        }
        let codeSnap = null;
        if (!usingEnvCode) {
          codeSnap = await tx.get(codeRef);
          const c = codeSnap.exists ? (codeSnap.data() as SignupCode) : null;
          const expired = c?.expiresAt ? Date.now() > new Date(c.expiresAt).getTime() : false;
          if (!c || !c.active || expired) {
            const e = new Error('bad_code');
            (e as Error & { code?: string }).code = 'bad_code';
            throw e;
          }
          if ((c.uses ?? 0) >= c.maxUses) {
            const e = new Error('code_exhausted');
            (e as Error & { code?: string }).code = 'code_exhausted';
            throw e;
          }
        }

        // --- writes ---
        const tenant: Tenant = {
          slug,
          practiceName,
          status: 'active',
          ownerMemberId,
          ownerEmail: user.email,
          signupCodeUsed: usingEnvCode ? 'env' : codeHash.slice(0, 12),
          createdByIp: clientIp(req),
          displayName: practiceName,
          brandColor: '#C9A84C',
          timezone,
          createdAt: now,
          updatedAt: now,
        };
        tx.set(tenantRef(slug), tenant);

        const t = tenantDb(slug);
        const owner: Member = {
          id: ownerMemberId,
          name: user.name,
          email: user.email,
          active: true,
          featured: true,
          sortOrder: 0,
          isAdmin: true,
          role: 'owner',
          defaultScheduleId: scheduleId,
          createdAt: now,
          updatedAt: now,
        };
        tx.set(t.members().doc(ownerMemberId), owner);

        const schedule: AvailabilitySchedule = {
          id: scheduleId,
          name: 'Working hours',
          timezone,
          weekly: {
            1: [{ start: '09:00', end: '17:00' }],
            2: [{ start: '09:00', end: '17:00' }],
            3: [{ start: '09:00', end: '17:00' }],
            4: [{ start: '09:00', end: '17:00' }],
            5: [{ start: '09:00', end: '17:00' }],
          },
          overrides: [],
          memberId: ownerMemberId,
          createdAt: now,
          updatedAt: now,
        };
        tx.set(t.schedules().doc(scheduleId), schedule);

        const etRef = t.eventTypes().doc();
        const eventType: EventType = {
          id: etRef.id,
          slug: 'consultation',
          name: 'Consultation',
          description: 'A 30-minute introductory call.',
          durationMinutes: 30,
          active: true,
          color: '#C9A84C',
          location: { type: 'google_meet' },
          memberIds: [ownerMemberId],
          questions: [],
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          minNoticeMinutes: 120,
          maxDaysInFuture: 60,
          slotIntervalMinutes: 30,
          dailyBookingLimit: null,
          collectPhone: true,
          remindersMinutesBefore: [1440, 60],
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        };
        tx.set(etRef, eventType);

        if (!usingEnvCode) {
          tx.set(codeRef, { uses: FieldValue.increment(1) }, { merge: true });
        }
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'slug_taken') throw conflict('That URL name is taken. Try another.', 'slug_taken');
      if (code === 'bad_code') throw forbidden('That access code is not valid.', 'bad_code');
      if (code === 'code_exhausted') throw conflict('That access code has been used up.', 'code_exhausted');
      throw err;
    }

    res.status(201).json({ tenantSlug: slug, adminUrl: `/${slug}/admin` });
  }),
);

// ---- Platform: mint + list access codes (platform owner only) ----
const mintSchema = z.object({
  label: z.string().trim().min(1).max(120),
  maxUses: z.number().int().min(1).max(100_000).default(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

signupRouter.post(
  '/api/platform/signup-codes',
  wrap(async (req, res) => {
    const owner = await requirePlatformOwner(req);
    const parsed = mintSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid code request.', 'invalid_body');
    // The raw code is shown ONCE; only its hash is stored.
    const rawCode = randomToken(12);
    const doc: SignupCode = {
      label: parsed.data.label,
      maxUses: parsed.data.maxUses,
      uses: 0,
      active: true,
      expiresAt: parsed.data.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      createdBy: owner,
    };
    await db.collection(ROOT.signupCodes).doc(sha256(rawCode)).set(doc);
    res.status(201).json({ code: rawCode, ...doc });
  }),
);

signupRouter.get(
  '/api/platform/signup-codes',
  wrap(async (req, res) => {
    await requirePlatformOwner(req);
    const q = await db.collection(ROOT.signupCodes).get();
    // Never return the raw code (we only store the hash); expose metadata only.
    const codes = q.docs.map((d) => {
      const c = d.data() as SignupCode;
      return {
        hashPrefix: d.id.slice(0, 12),
        label: c.label,
        maxUses: c.maxUses,
        uses: c.uses,
        active: c.active,
        expiresAt: c.expiresAt ?? null,
        createdAt: c.createdAt,
      };
    });
    res.json({ codes });
  }),
);
