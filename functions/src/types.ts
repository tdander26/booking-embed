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
 */

export type LocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';
export type BookingStatus = 'confirmed' | 'cancelled';

/** Public, non-sensitive branding shown on the booking page. */
export interface Branding {
  displayName: string; // e.g. "Dr. Todd Anderson"
  tagline?: string;
  avatarUrl?: string;
  brandColor: string; // hex, e.g. "#0f766e"
  welcomeText?: string;
  timezone: string; // owner's IANA tz, e.g. "America/Chicago"
  updatedAt: string;
}

export interface EventType {
  id: string;
  slug: string; // URL-friendly, unique
  name: string;
  description?: string;
  durationMinutes: number;
  active: boolean;
  color: string; // hex
  location: { type: LocationType; details?: string };
  availabilityScheduleId: string;

  // Scheduling rules
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number; // earliest bookable offset from "now"
  maxDaysInFuture: number; // furthest-out bookable day
  slotIntervalMinutes: number; // granularity of offered start times (e.g. 15/30)
  dailyBookingLimit: number | null; // cap bookings per day, null = unlimited
  collectPhone: boolean;
  remindersMinutesBefore: number[]; // e.g. [1440, 60] => 24h + 1h before

  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** A bookable window within a day, expressed in the schedule's timezone. */
export interface DayWindow {
  start: string; // "09:00"
  end: string; // "17:00"
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
  timezone: string; // IANA tz the windows are expressed in
  weekly: WeeklyRules;
  overrides: DateOverride[];
  createdAt: string;
  updatedAt: string;
}

export interface Booking {
  id: string;
  eventTypeId: string;
  eventTypeName: string; // denormalized snapshot at booking time
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  invitee: {
    name: string;
    email: string;
    phone?: string;
    notes?: string;
    timezone: string; // tz the invitee booked in (for their display)
  };
  location: { type: LocationType; details?: string; meetUrl?: string };
  status: BookingStatus;
  googleEventId?: string;
  googleSyncError?: string; // set if the calendar write failed (rare)
  lockIds: string[]; // slotLocks docs this booking holds; deleted on cancel
  dayCounterId?: string; // dayCounters doc to decrement on cancel (daily cap)
  cancelToken: string; // unguessable; gates the manage/cancel/reschedule links
  reminderDueUtc: string | null; // next reminder instant, null when none pending
  remindersRemaining: number[]; // minutes-before values still to send
  confirmationSent: boolean;
  createdAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  source?: 'web' | 'embed';
}

/** Existence of this doc reserves a slot. Doc id = hash(calendarKey|startUtc). */
export interface SlotLock {
  bookingId: string;
  eventTypeId: string;
  startUtc: string;
  endUtc: string;
  createdAt: string;
}

/** private/google — server-only secret. */
export interface GoogleTokens {
  refreshToken: string;
  calendarId: string; // calendar to read busy + write events, default "primary"
  connectedEmail?: string;
  scope?: string;
  updatedAt: string;
}

// ---------- API DTOs (function responses consumed by the web app) ----------

export interface AvailabilityDay {
  date: string; // "YYYY-MM-DD" in the requested (invitee) timezone
  slots: string[]; // ISO UTC start instants offered that day
}

export interface AvailabilityResponse {
  eventTypeId: string;
  timezone: string; // invitee tz used to group days
  durationMinutes: number;
  days: AvailabilityDay[];
}

/** Public-safe projection of an EventType (no internal-only fields stripped, but
 * grouped for the booking page). */
export interface PublicEventType {
  id: string;
  slug: string;
  name: string;
  description?: string;
  durationMinutes: number;
  color: string;
  location: { type: LocationType; details?: string };
  collectPhone: boolean;
  minNoticeMinutes: number;
  maxDaysInFuture: number;
}

export interface CreateBookingRequest {
  eventTypeId: string;
  startUtc: string; // must match an offered slot
  timezone: string; // invitee tz
  name: string;
  email: string;
  phone?: string;
  notes?: string;
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
  displayName: string; // host
}
