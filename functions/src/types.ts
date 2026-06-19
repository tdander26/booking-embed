/**
 * Canonical Firestore data model for booking-embed.
 *
 * Time convention: every stored instant is an ISO-8601 string in UTC with a
 * trailing `Z` and millisecond precision (e.g. "2026-06-20T15:00:00.000Z").
 * Fixed-format UTC ISO strings sort lexicographically === chronologically, so
 * Firestore range queries on `startUtc` / `reminderDueUtc` work directly.
 *
 * "Wall-clock" config (availability windows, override dates) is stored in the
 * schedule's own IANA timezone as "HH:mm" / "YYYY-MM-DD" and only converted to
 * UTC at availability-computation time.
 *
 * v2 (multi-provider): a `members` collection holds providers (Dr. Anderson,
 * Dr. Payne …). Event types are offered by one or more members; each member has
 * their own availability schedule and their own Google calendar connections.
 */

export type LocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';
export type BookingStatus = 'confirmed' | 'cancelled';
/** Booking-page color theme. 'auto' follows the visitor's device preference. */
export type ThemeMode = 'dark' | 'light' | 'auto';

// ---------- Tenants (practices) ----------

export type TenantStatus = 'active' | 'suspended';

/**
 * A practice. The doc id IS the URL slug (lowercased, validated, unique,
 * immutable in v1). Branding fields live directly on this doc (the tenant doc is
 * exactly the public-readable surface). `tenants/{slug}`.
 */
export interface Tenant {
  slug: string; // == doc id
  practiceName: string;
  status: TenantStatus;
  ownerMemberId: string; // the founding member (role:'owner')
  ownerEmail: string; // lowercased; the Google account that created the practice
  signupCodeUsed?: string; // label/hash hint of the access code consumed (audit)
  createdByIp?: string; // audit for takedown
  // --- Branding (public-readable) ---
  displayName: string; // shown on the booking page (defaults to practiceName)
  tagline?: string;
  avatarUrl?: string;
  brandColor: string; // hex, e.g. "#C9A84C"
  welcomeText?: string;
  timezone: string; // clinic default IANA tz
  emailFrom?: string; // optional per-tenant email sender; falls back to EMAIL_FROM
  // --- Google Ads conversion tracking (public; fired client-side) ---
  adsConversionId?: string; // e.g. "AW-123456789"
  adsConversionLabel?: string; // e.g. "abCdEf…" (the conversion action label)
  theme?: ThemeMode; // booking-page color theme (default 'dark')
  createdAt: string;
  updatedAt: string;
}

/** Public, non-sensitive branding shown on the booking page (per-tenant). */
export interface Branding {
  displayName: string; // e.g. "Dr. Todd Anderson" (clinic-level)
  tagline?: string;
  avatarUrl?: string;
  brandColor: string; // hex, e.g. "#C9A84C"
  welcomeText?: string;
  timezone: string; // clinic default IANA tz
  emailFrom?: string; // optional per-tenant email sender
  adsConversionId?: string; // Google Ads conversion ID (AW-…), fired client-side
  adsConversionLabel?: string; // Google Ads conversion action label
  theme?: ThemeMode; // booking-page color theme (default 'dark')
  updatedAt: string;
}

/** Platform-level access code (hashed). Root collection `signupCodes/{sha256}`. */
export interface SignupCode {
  label: string;
  maxUses: number;
  uses: number;
  active: boolean;
  expiresAt?: string | null;
  createdAt: string;
  createdBy?: string;
}

// ---------- Members (providers) ----------

/** A bookable provider. id is immutable (e.g. "mbr_todd", "mbr_anna"). */
export interface Member {
  id: string;
  name: string; // "Dr. Anna Payne"
  title?: string; // "Functional Medicine"
  email: string; // lowercased; matched against the Firebase Auth admin email
  avatarUrl?: string;
  bio?: string;
  active: boolean; // hidden from the booking flow when false
  featured: boolean; // emphasized + shown first (Dr. Payne)
  sortOrder: number;
  isAdmin: boolean; // may sign in to /admin
  /** Per-tenant authority. Exactly one 'owner' per tenant (can't be deleted/
   * demoted). Absent on legacy docs => treated as 'admin'. */
  role?: 'owner' | 'admin';
  timezone?: string; // optional display tz (falls back to schedule tz / branding)
  brandColor?: string; // optional per-provider accent
  defaultScheduleId: string | null; // availabilitySchedules/{id} this member owns
  // Where confirmed events are written: a connection + a calendar within it.
  writeConnectionId?: string;
  writeCalendarId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A calendar within a connected Google account. */
export interface MemberCalendarRef {
  calendarId: string; // Google calendarList entry id (often an email)
  summary: string; // display label, snapshot at connect time
  primary?: boolean;
  accessRole?: string; // owner | writer | reader | freeBusyReader
  selected: boolean; // include this calendar's busy times in availability
  writable: boolean; // accessRole in {owner,writer} — eligible as write target
}

/** members/{memberId}/connections/{connId} — SERVER-ONLY (holds refresh token).
 * connId = sanitizeForDocId(accountEmail) so re-connecting an account upserts. */
export interface MemberConnection {
  id: string;
  accountEmail: string; // lowercased Google account that consented
  refreshToken: string; // SECRET — never sent to the client
  scope?: string;
  status: 'active' | 'revoked';
  calendars: MemberCalendarRef[];
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- Custom intake questions ----------

export type QuestionType =
  | 'text'
  | 'textarea'
  | 'phone'
  | 'dropdown'
  | 'checkboxes'
  | 'checkbox';

/** A custom intake question defined on an event type. id is stable + immutable. */
export interface IntakeQuestion {
  id: string; // e.g. "q_a1b2c3"; never reused/renamed
  type: QuestionType;
  label: string;
  required: boolean;
  options?: string[]; // dropdown | checkboxes only
  placeholder?: string; // text | textarea
  helpText?: string;
  sortOrder: number;
}

/** A stored answer — label/type snapshotted so historical bookings survive
 * question edits/deletes (stable-id rule). */
export interface BookingAnswer {
  questionId: string;
  label: string;
  type: QuestionType;
  value: string | string[] | boolean; // text/textarea/dropdown=string; checkboxes=string[]; checkbox=boolean
}

// ---------- Event types / schedules ----------

export interface EventType {
  id: string;
  slug: string; // URL-friendly, unique
  name: string;
  description?: string;
  durationMinutes: number;
  active: boolean;
  color: string; // hex
  location: { type: LocationType; details?: string };

  /** Providers offering this type, in display priority order. Empty/absent =>
   * legacy single-provider (treat as the owner member). */
  memberIds: string[];
  /** Custom intake questions (absent/[] => name + email + phone + notes only). */
  questions: IntakeQuestion[];

  /** @deprecated legacy single-schedule pointer; per-member scheduling resolves
   * the schedule from member.defaultScheduleId. Kept for back-compat. */
  availabilityScheduleId?: string;

  // Scheduling rules
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysInFuture: number;
  slotIntervalMinutes: number;
  dailyBookingLimit: number | null;
  collectPhone: boolean;
  remindersMinutesBefore: number[];

  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DayWindow {
  start: string; // "09:00"
  end: string; // "17:00" (or "24:00")
}

/** weekday 0=Sunday … 6=Saturday → list of windows */
export type WeeklyRules = Record<number, DayWindow[]>;

export interface DateOverride {
  date: string; // "YYYY-MM-DD" in the schedule timezone
  windows: DayWindow[]; // empty array => fully unavailable that day
}

export interface AvailabilitySchedule {
  id: string;
  name: string;
  timezone: string;
  weekly: WeeklyRules;
  overrides: DateOverride[];
  memberId?: string | null; // owning member (null/absent = legacy/global)
  createdAt: string;
  updatedAt: string;
}

export interface Booking {
  id: string;
  tenantId: string; // owning practice (also the parent doc id); stamped on every booking
  eventTypeId: string;
  eventTypeName: string; // denormalized snapshot
  memberId: string; // provider (legacy bookings backfilled to owner)
  memberName?: string; // denormalized snapshot
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  invitee: {
    name: string; // composed "First Last" (kept for display + back-compat)
    firstName?: string;
    lastName?: string;
    email: string;
    phone?: string;
    notes?: string;
    timezone: string;
  };
  answers?: BookingAnswer[]; // custom intake answers (snapshotted)
  location: { type: LocationType; details?: string; meetUrl?: string };
  status: BookingStatus;
  googleEventId?: string;
  googleSyncError?: string;
  calendarRef?: { connectionId: string; calendarId: string }; // where the event was written
  lockIds: string[];
  dayCounterId?: string;
  cancelToken: string;
  reminderDueUtc: string | null;
  remindersRemaining: number[];
  confirmationSent: boolean;
  createdAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  source?: 'web' | 'embed';
}

/** Existence reserves a slot. Doc id = sanitize(memberId)_cell (per-member). */
export interface SlotLock {
  bookingId: string;
  memberId: string;
  eventTypeId: string;
  startUtc: string;
  endUtc: string;
  createdAt: string;
}

/** @deprecated private/google — legacy single-tenant token, kept for migration. */
export interface GoogleTokens {
  refreshToken: string;
  calendarId: string;
  connectedEmail?: string;
  scope?: string;
  updatedAt: string;
}

// ---------- API DTOs ----------

export interface AvailabilityDay {
  date: string; // "YYYY-MM-DD" in the requested (invitee) timezone
  slots: string[]; // ISO UTC start instants offered that day
}

export interface AvailabilityResponse {
  eventTypeId: string;
  memberId?: string;
  timezone: string;
  durationMinutes: number;
  days: AvailabilityDay[];
}

/** Public-safe provider projection for the picker (no email/admin fields). */
export interface PublicProvider {
  id: string;
  name: string;
  title?: string;
  avatarUrl?: string;
  bio?: string;
  featured: boolean;
  sortOrder: number;
}

export interface PublicEventType {
  id: string;
  slug: string;
  name: string;
  description?: string;
  durationMinutes: number;
  color: string;
  location: { type: LocationType; details?: string };
  collectPhone: boolean;
  collectNotes: boolean; // true when there are no custom questions (keep legacy notes box)
  minNoticeMinutes: number;
  maxDaysInFuture: number;
  providers: PublicProvider[]; // [] => legacy single-provider type
  questions: IntakeQuestion[];
}

export interface CreateBookingRequest {
  eventTypeId: string;
  memberId?: string; // required iff the type has providers
  startUtc: string;
  timezone: string;
  name?: string; // legacy combined; server composes from first/last when absent
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  notes?: string;
  answers?: Record<string, string | string[] | boolean>; // raw; validated server-side
  source?: 'web' | 'embed';
}

export interface BookingConfirmation {
  bookingId: string;
  cancelToken: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  eventTypeName: string;
  location: { type: LocationType; details?: string; meetUrl?: string };
  displayName: string; // clinic/host
  providerName?: string; // chosen provider (falls back to displayName)
}

export interface NextAvailableProvider {
  memberId: string;
  nextDate: string | null; // "YYYY-MM-DD" in requested tz
  nextSlotIso: string | null;
  slotCountThatDay: number;
  hasAvailability: boolean;
}

export interface NextAvailableResponse {
  eventTypeId: string;
  timezone: string;
  providers: NextAvailableProvider[];
}
