// DTOs exchanged with the /api backend. Mirrors functions/src/types.ts (server
// is the source of truth). v2 adds providers ("members"), per-type custom
// questions, and multi-account Google calendar connections.

export type LocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';
export type BookingStatus = 'confirmed' | 'cancelled';
export type QuestionType = 'text' | 'textarea' | 'dropdown' | 'checkboxes' | 'checkbox';

export interface PublicBranding {
  displayName: string;
  tagline: string;
  avatarUrl: string;
  brandColor: string;
  welcomeText: string;
  timezone: string;
}

export interface IntakeQuestion {
  id: string;
  type: QuestionType;
  label: string;
  required: boolean;
  options?: string[];
  placeholder?: string;
  helpText?: string;
  sortOrder: number;
}

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
  collectNotes: boolean;
  minNoticeMinutes: number;
  maxDaysInFuture: number;
  providers: PublicProvider[];
  questions: IntakeQuestion[];
}

export interface AvailabilityDay {
  date: string;
  slots: string[];
}

export interface AvailabilityResponse {
  eventTypeId: string;
  memberId?: string;
  timezone: string;
  durationMinutes: number;
  days: AvailabilityDay[];
}

export interface NextAvailableProvider {
  memberId: string;
  nextDate: string | null;
  nextSlotIso: string | null;
  slotCountThatDay: number;
  hasAvailability: boolean;
}
export interface NextAvailableResponse {
  eventTypeId: string;
  timezone: string;
  providers: NextAvailableProvider[];
}

export interface BookingConfirmation {
  bookingId: string;
  cancelToken: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  eventTypeName: string;
  location: { type: LocationType; details?: string; meetUrl?: string };
  displayName: string;
  providerName?: string;
}

export interface ManageView {
  bookingId: string;
  status: BookingStatus;
  eventTypeName: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  timezone: string;
  inviteeName: string;
  location: { type: LocationType; details?: string; meetUrl?: string };
}

export type AnswerValue = string | string[] | boolean;
export interface BookingAnswer {
  questionId: string;
  label: string;
  type: QuestionType;
  value: AnswerValue;
}

// ---- Admin DTOs ----
export interface DayWindow {
  start: string;
  end: string;
}
export type WeeklyRules = Record<string, DayWindow[]>;
export interface DateOverride {
  date: string;
  windows: DayWindow[];
}
export interface AvailabilitySchedule {
  id: string;
  name: string;
  timezone: string;
  weekly: WeeklyRules;
  overrides: DateOverride[];
  memberId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EventType {
  id: string;
  slug: string;
  name: string;
  description?: string;
  durationMinutes: number;
  active: boolean;
  color: string;
  location: { type: LocationType; details?: string };
  memberIds: string[];
  questions: IntakeQuestion[];
  availabilityScheduleId?: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxDaysInFuture: number;
  slotIntervalMinutes: number;
  dailyBookingLimit: number | null;
  collectPhone: boolean;
  remindersMinutesBefore: number[];
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface Member {
  id: string;
  name: string;
  title?: string;
  email: string;
  avatarUrl?: string;
  bio?: string;
  active: boolean;
  featured: boolean;
  sortOrder: number;
  isAdmin: boolean;
  timezone?: string;
  brandColor?: string;
  defaultScheduleId: string | null;
  writeConnectionId?: string;
  writeCalendarId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemberCalendarRef {
  calendarId: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  selected: boolean;
  writable: boolean;
}

/** Client-safe view of a connection (NO refresh token). */
export interface ConnectionView {
  id: string;
  accountEmail: string;
  status: 'active' | 'revoked';
  lastSyncedAt: string;
  createdAt: string;
  calendars: MemberCalendarRef[];
  isWriteConnection: boolean;
}

export interface AdminBooking {
  id: string;
  eventTypeName: string;
  memberId?: string;
  memberName?: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  status: BookingStatus;
  invitee: { name: string; email: string; phone?: string; notes?: string; timezone: string };
  answers?: BookingAnswer[];
  location: { type: LocationType; details?: string; meetUrl?: string };
  googleSyncError?: string;
  cancelToken: string;
}

export interface AdminMe {
  email: string;
  isOwner: boolean;
  memberId: string | null;
}

export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  calendarId: string;
}
