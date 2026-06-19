import { google, type calendar_v3 } from 'googleapis';
import { logger } from 'firebase-functions';
import { DateTime } from 'luxon';
import { makeOAuthClient, saveGoogleTokens, loadGoogleTokens } from '../google/oauth';
import { randomUUID } from '../util/ids';
import type { Interval } from '../scheduling/slots';
import type {
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
} from './provider';

export class GoogleCalendarProvider implements CalendarProvider {
  private calendar: calendar_v3.Calendar;

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    refreshToken: string;
  }) {
    const oauth = makeOAuthClient(
      opts.clientId,
      opts.clientSecret,
      opts.redirectUri,
    );
    oauth.setCredentials({ refresh_token: opts.refreshToken });
    // Persist a rotated refresh token if Google ever issues one.
    oauth.on('tokens', (t) => {
      if (t.refresh_token) {
        void loadGoogleTokens().then((cur) => {
          if (cur) {
            void saveGoogleTokens({
              ...cur,
              refreshToken: t.refresh_token!,
              updatedAt: new Date().toISOString(),
            });
          }
        });
      }
    });
    this.calendar = google.calendar({ version: 'v3', auth: oauth });
  }

  /**
   * Busy intervals across MANY calendars in ONE freebusy.query round-trip.
   * Per-calendar errors (calendar removed / access lost) are logged and skipped
   * rather than failing the whole query, so one bad calendar never blanks out
   * an account's availability. Google caps freebusy.query at 50 items; the
   * selected-calendar counts here stay well under that, but we chunk defensively.
   */
  async getBusyMulti(
    calendarIds: string[],
    fromIso: string,
    toIso: string,
  ): Promise<Interval[]> {
    if (calendarIds.length === 0) return [];

    const CHUNK = 50;
    const out: Interval[] = [];
    for (let i = 0; i < calendarIds.length; i += CHUNK) {
      const ids = calendarIds.slice(i, i + CHUNK);
      const res = await this.calendar.freebusy.query({
        requestBody: {
          timeMin: fromIso,
          timeMax: toIso,
          items: ids.map((id) => ({ id })),
        },
      });
      for (const id of ids) {
        const cal = res.data.calendars?.[id];
        if (cal?.errors?.length) {
          // Calendar removed / no access: skip it, don't fail the whole query.
          // Log only the reason — never invitee data or tokens (HIPAA boundary).
          logger.warn('freebusy calendar error', {
            reason: cal.errors.map((e) => e.reason).join(','),
          });
          continue;
        }
        for (const b of cal?.busy ?? []) {
          if (b.start && b.end) {
            out.push({
              start: DateTime.fromISO(b.start).toMillis(),
              end: DateTime.fromISO(b.end).toMillis(),
            });
          }
        }
      }
    }
    return out;
  }

  /** Single-calendar busy — thin wrapper over getBusyMulti (back-compat). */
  async getBusy(
    calendarId: string,
    fromIso: string,
    toIso: string,
  ): Promise<Interval[]> {
    return this.getBusyMulti([calendarId], fromIso, toIso);
  }

  async createEvent(
    calendarId: string,
    input: CreateEventInput,
  ): Promise<CreatedEvent> {
    const requestBody: calendar_v3.Schema$Event = {
      summary: input.summary,
      description: input.description,
      // dateTime carries the UTC offset (Z); intentionally NO timeZone field so
      // the offset is authoritative (mixing the two is a documented footgun).
      start: { dateTime: input.startUtcIso },
      end: { dateTime: input.endUtcIso },
      attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName }],
    };
    if (input.withMeet) {
      requestBody.conferenceData = {
        createRequest: {
          requestId: randomUUID(), // unique per insert
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    const res = await this.calendar.events.insert({
      calendarId,
      conferenceDataVersion: input.withMeet ? 1 : 0, // REQUIRED for Meet creation
      sendUpdates: 'all',
      requestBody,
    });

    const eventId = res.data.id;
    if (!eventId) throw new Error('Calendar event insert returned no id');

    let meetUrl =
      res.data.hangoutLink ??
      res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
        ?.uri ??
      undefined;

    // Meet creation is async; if still pending, fetch once.
    if (input.withMeet && !meetUrl) {
      const fresh = await this.calendar.events.get({ calendarId, eventId });
      meetUrl =
        fresh.data.hangoutLink ??
        fresh.data.conferenceData?.entryPoints?.find(
          (e) => e.entryPointType === 'video',
        )?.uri ??
        undefined;
    }

    return { eventId, meetUrl };
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'all', // notify the invitee of the cancellation
    });
  }
}
