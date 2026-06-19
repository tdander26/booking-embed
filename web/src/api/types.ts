// DTOs exchanged with the /api backend. Kept intentionally small and aligned
// with functions/src/types.ts (the server is the source of truth).

export type LocationType = 'google_meet' | 'phone' | 'in_person' | 'custom';
export type BookingStatus = 'confirmed' | 'cancelled';

export interface PublicBranding {
  displayName: string;
  tagline: string;
  avatarUrl: string;
  brandColor: string;
  welcomeText: string;
  timezone: string;
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
  minNoticeMinutes: number;
  maxDaysInFuture: number;
}

export interface AvailabilityDay {
  date: string; // "yyyy-MM-dd" in requested tz
  slots: string[]; // ISO UTC starts
}

export interface AvailabilityResponse {
  eventTypeId: string;
  timezone: string;
  durationMinutes: number;
  days: AvailabilityDay[];
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
  availabilityScheduleId: string;
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

export interface AdminBooking {
  id: string;
  eventTypeName: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  status: BookingStatus;
  invitee: { name: string; email: string; phone?: string; notes?: string; timezone: string };
  location: { type: LocationType; details?: string; meetUrl?: string };
  cancelToken: string;
}

export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  calendarId: string;
}
