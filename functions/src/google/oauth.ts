import { google } from 'googleapis';
import type { MemberCalendarRef } from '../types';

// Scope set (v2 multi-account): create/delete events + read calendars & busy.
// `calendar.readonly` covers calendarList.list AND freebusy reads, so the older
// `calendar.freebusy` scope is no longer needed. The broad read/write `calendar`
// scope is intentionally avoided (harder OAuth verification).
//
// Back-compat: the legacy single-token grant retains calendar.events +
// calendar.freebusy and keeps working for freebusy + insert/delete. Only
// calendarList.list requires the new readonly scope, and only the new connect
// flow (which always re-consents) ever needs it.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events', // write events to the chosen calendar
  'https://www.googleapis.com/auth/calendar.readonly', // list calendars + read busy
];

export type OAuthClient = InstanceType<typeof google.auth.OAuth2>;

export function makeOAuthClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): OAuthClient {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** One-time consent URL. `state` is validated on the callback. */
export function buildConsentUrl(client: OAuthClient, state: string): string {
  return client.generateAuthUrl({
    access_type: 'offline', // returns a refresh_token
    prompt: 'consent', // force consent so a refresh_token is ALWAYS returned
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

// ---------- Multi-account: enumerate calendars + identify the account ----------

/**
 * List the calendars visible to a connected account (calendarList.list, fully
 * paginated). Maps each entry to a `MemberCalendarRef`:
 *  - `selected` defaults to the primary calendar only (callers merge prior
 *    admin choices by calendarId on upsert — see members.upsertConnection).
 *  - `writable` = accessRole in {owner, writer} → eligible as a write target.
 * `minAccessRole:'freeBusyReader'` keeps calendars the account can at least read
 * busy times for (the minimum useful for conflict checking).
 */
export async function listCalendars(oauth: OAuthClient): Promise<MemberCalendarRef[]> {
  const cal = google.calendar({ version: 'v3', auth: oauth });
  const out: MemberCalendarRef[] = [];
  let pageToken: string | undefined;
  do {
    const res = await cal.calendarList.list({
      pageToken,
      showHidden: false,
      maxResults: 250,
      minAccessRole: 'freeBusyReader',
    });
    for (const e of res.data.items ?? []) {
      if (!e.id) continue;
      const role = e.accessRole ?? undefined;
      out.push({
        calendarId: e.id,
        summary: e.summaryOverride || e.summary || e.id,
        primary: !!e.primary,
        accessRole: role,
        selected: !!e.primary, // default; merged with prior choices on upsert
        writable: role === 'owner' || role === 'writer',
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/**
 * Resolve the Google account email behind a connection. Prefers the OpenID
 * userinfo endpoint; if that scope wasn't granted (or the call fails), falls
 * back to the primary calendarList entry whose id IS the account email. No
 * extra scope is required for the calendarList fallback.
 */
export async function fetchAccountEmail(oauth: OAuthClient): Promise<string> {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
    const info = await oauth2.userinfo.get();
    const email = info.data.email?.trim().toLowerCase();
    if (email) return email;
  } catch {
    // userinfo scope not granted / transient — fall through to calendar primary.
  }
  try {
    const calendars = await listCalendars(oauth);
    const primary = calendars.find((c) => c.primary);
    const email = primary?.calendarId?.trim().toLowerCase();
    if (email) return email;
  } catch {
    // ignore; return sentinel below
  }
  return '(unknown)';
}
