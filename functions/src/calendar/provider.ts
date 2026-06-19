/**
 * Calendar abstraction. The Google implementation talks to the owner's real
 * calendar; the mock implementation lets the entire booking flow run locally in
 * the emulator (and before OAuth is connected) with no external calls.
 */
import type { Interval } from '../scheduling/slots';
import { isEmulator, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '../config';
import { loadGoogleTokens } from '../google/oauth';
import { GoogleCalendarProvider } from './google';
import { MockCalendarProvider } from './mock';

export interface CreateEventInput {
  summary: string;
  description?: string;
  startUtcIso: string; // ISO-8601 UTC (with Z)
  endUtcIso: string;
  attendeeEmail: string;
  attendeeName?: string;
  withMeet: boolean;
}

export interface CreatedEvent {
  eventId: string;
  meetUrl?: string;
}

export interface CalendarProvider {
  /** Busy intervals on [fromIso, toIso) as epoch-millis intervals. */
  getBusy(calendarId: string, fromIso: string, toIso: string): Promise<Interval[]>;
  createEvent(calendarId: string, input: CreateEventInput): Promise<CreatedEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export interface ResolvedProvider {
  provider: CalendarProvider;
  calendarId: string;
  connected: boolean; // is a real Google calendar connected?
  mock: boolean; // is the mock provider in use?
}

/**
 * Pick the provider: mock inside the emulator or when no calendar is connected,
 * otherwise the real Google provider built from the stored refresh token.
 */
export async function getCalendarProvider(): Promise<ResolvedProvider> {
  const tokens = await loadGoogleTokens();
  const connected = !!tokens?.refreshToken;
  const calendarId = tokens?.calendarId || 'primary';

  if (isEmulator() || !connected) {
    return { provider: new MockCalendarProvider(), calendarId, connected, mock: true };
  }

  const provider = new GoogleCalendarProvider({
    clientId: GOOGLE_CLIENT_ID.value(),
    clientSecret: GOOGLE_CLIENT_SECRET.value(),
    redirectUri: GOOGLE_REDIRECT_URI.value() || '',
    refreshToken: tokens!.refreshToken,
  });
  return { provider, calendarId, connected: true, mock: false };
}
