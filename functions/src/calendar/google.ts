import { google, type calendar_v3 } from 'googleapis';
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

  async getBusy(
    calendarId: string,
    fromIso: string,
    toIso: string,
  ): Promise<Interval[]> {
    const res = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: fromIso,
        timeMax: toIso,
        items: [{ id: calendarId }],
      },
    });
    const cal = res.data.calendars?.[calendarId];
    if (cal?.errors?.length) {
      throw new Error(`freebusy error: ${cal.errors.map((e) => e.reason).join(',')}`);
    }
    const busy = cal?.busy ?? [];
    return busy
      .filter((b) => b.start && b.end)
      .map((b) => ({
        start: DateTime.fromISO(b.start!).toMillis(),
        end: DateTime.fromISO(b.end!).toMillis(),
      }));
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
