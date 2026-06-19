/**
 * Calendar abstraction.
 *
 * Multi-tenant, multi-provider, multi-account: each member (scoped to a tenant)
 * can connect N Google accounts, each account exposing several calendars.
 * Conflict-checking ("busy") unions every SELECTED calendar across every ACTIVE
 * connection; event creation targets a single WRITE calendar
 * (member.writeConnectionId / writeCalendarId).
 *
 * The mock implementation lets the entire booking flow run locally in the
 * emulator (and before any account is connected) with no external calls.
 */
import { logger } from 'firebase-functions';
import type { Interval } from '../scheduling/slots';
import { isEmulator, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '../config';
import { loadMember, loadActiveConnections, loadConnection, setConnectionStatus } from '../members';
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

// ---------- Member-aware multi-account resolution ----------

/** One Google account's provider + the selected calendars to read busy from. */
export interface BusySource {
  provider: GoogleCalendarProvider; // bound to ONE connection's refresh token
  calendarIds: string[]; // selected calendars on that connection
  connectionId: string; // for fail-open status flips on invalid_grant
}

export interface ResolvedMemberCalendar {
  busySources: BusySource[]; // every active connection × its selected calendars
  write: { provider: CalendarProvider; calendarId: string; connectionId: string } | null;
  connected: boolean; // ≥1 active connection
  mock: boolean; // no usable connection → mock for busy+write
}

function makeProvider(refreshToken: string): GoogleCalendarProvider {
  return new GoogleCalendarProvider({
    clientId: GOOGLE_CLIENT_ID.value(),
    clientSecret: GOOGLE_CLIENT_SECRET.value(),
    redirectUri: GOOGLE_REDIRECT_URI.value() || '',
    refreshToken,
  });
}

/**
 * Resolve a member's calendars for both conflict-checking and event creation.
 *
 * - Emulator or no active connections → all-mock (busy empty, write via mock) so
 *   any not-yet-connected member stays demoable and never dead-ends.
 * - Otherwise: one GoogleCalendarProvider per ACTIVE connection (tokens are NOT
 *   interchangeable across accounts), each carrying its SELECTED calendar ids.
 * - Write target: member.writeConnectionId / writeCalendarId. If unset but there
 *   is exactly one active connection, fall back to that connection's primary (or
 *   first writable) calendar. If still unresolvable → write:null (callers fall
 *   back to mock event creation + flag googleSyncError; booking still succeeds).
 */
export async function getMemberCalendar(
  tenantId: string,
  memberId: string,
): Promise<ResolvedMemberCalendar> {
  if (isEmulator()) {
    return { busySources: [], write: null, connected: false, mock: true };
  }

  const [member, connections] = await Promise.all([
    loadMember(tenantId, memberId),
    loadActiveConnections(tenantId, memberId),
  ]);

  if (connections.length === 0) {
    return { busySources: [], write: null, connected: false, mock: true };
  }

  // One provider per connection; reuse instances for the write lookup below.
  const providerByConn = new Map<string, GoogleCalendarProvider>();
  const busySources: BusySource[] = [];
  for (const c of connections) {
    const provider = makeProvider(c.refreshToken);
    providerByConn.set(c.id, provider);
    const calendarIds = (c.calendars ?? []).filter((cal) => cal.selected).map((cal) => cal.calendarId);
    // A connection with zero selected calendars contributes no busy source.
    if (calendarIds.length > 0) {
      busySources.push({ provider, calendarIds, connectionId: c.id });
    }
  }

  // Resolve the write target.
  let write: ResolvedMemberCalendar['write'] = null;
  const wantedConnId = member?.writeConnectionId;
  const wantedCalId = member?.writeCalendarId;
  if (wantedConnId && wantedCalId) {
    const conn = connections.find((c) => c.id === wantedConnId);
    // Re-validate the stored target: the calendar must still exist on the
    // connection AND still be writable (a Google access-role downgrade flips
    // `writable` on the next refresh). If stale, fall through to the fallback so
    // we never try to write to a now-read-only calendar.
    const cal = conn?.calendars?.find((c) => c.calendarId === wantedCalId);
    if (conn && cal?.writable) {
      write = {
        provider: providerByConn.get(conn.id)!,
        calendarId: wantedCalId,
        connectionId: conn.id,
      };
    }
  }
  if (!write && connections.length === 1) {
    // Single-connection fallback: primary writable calendar, else first writable.
    const conn = connections[0];
    const cals = conn.calendars ?? [];
    const target = cals.find((c) => c.primary && c.writable) ?? cals.find((c) => c.writable);
    if (target) {
      write = {
        provider: providerByConn.get(conn.id)!,
        calendarId: target.calendarId,
        connectionId: conn.id,
      };
    }
  }

  return { busySources, write, connected: true, mock: false };
}

/**
 * Provider bound to a SPECIFIC connection (account), used on cancel so the
 * event is deleted with the same account's token it was created with — even if
 * the member's write target was reassigned to another account in between.
 * Falls back to mock in the emulator or when the connection is gone/revoked.
 */
export async function getConnectionProvider(
  tenantId: string,
  memberId: string,
  connectionId: string,
): Promise<{ provider: CalendarProvider; mock: boolean }> {
  if (isEmulator()) return { provider: new MockCalendarProvider(), mock: true };
  const conn = await loadConnection(tenantId, memberId, connectionId);
  if (conn && conn.status === 'active' && conn.refreshToken) {
    return { provider: makeProvider(conn.refreshToken), mock: false };
  }
  return { provider: new MockCalendarProvider(), mock: true };
}

/** Heuristic: was this Google error an invalid/revoked refresh token? */
function isInvalidGrant(err: unknown): boolean {
  const anyErr = err as { message?: string; response?: { data?: { error?: string } } } | undefined;
  const code = anyErr?.response?.data?.error;
  if (code === 'invalid_grant') return true;
  return typeof anyErr?.message === 'string' && anyErr.message.includes('invalid_grant');
}

/**
 * Union of busy intervals across every selected calendar of every active
 * connection, scoped to one tenant+member. Fail-open per account: one account's
 * failure contributes no busy (the WRITE path is the safety net against
 * double-booking). On invalid_grant we flip that connection to `revoked` (on the
 * right tenant+member doc) so the admin UI can prompt a re-connect.
 *
 * Merge = concatenation: `filterSlots` rejects a candidate that overlaps ANY
 * busy interval, so concatenation IS the correct union — no coalescing needed.
 */
export async function memberBusyForMember(
  tenantId: string,
  memberId: string,
  rc: ResolvedMemberCalendar,
  fromIso: string,
  toIso: string,
): Promise<Interval[]> {
  const lists = await Promise.all(
    rc.busySources.map((s) =>
      s.provider.getBusyMulti(s.calendarIds, fromIso, toIso).catch(async (err) => {
        if (isInvalidGrant(err)) {
          try {
            await setConnectionStatus(tenantId, memberId, s.connectionId, 'revoked');
          } catch {
            /* ignore — flagging is best-effort */
          }
          logger.warn('member calendar token revoked', { connectionId: s.connectionId, reason: 'invalid_grant' });
        } else {
          logger.warn('member busy fetch failed', { connectionId: s.connectionId });
        }
        return [] as Interval[];
      }),
    ),
  );
  return lists.flat();
}

export { MockCalendarProvider };
