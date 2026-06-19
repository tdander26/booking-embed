import { randomUUID } from '../util/ids';
import type { Interval } from '../scheduling/slots';
import type {
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
} from './provider';

/**
 * Used in the emulator and before a real Google calendar is connected. Reports
 * no external busy times (the calendar is wide open) and returns a `mock_` event
 * id with NO meetUrl — so we never email a dead "Join Google Meet" link. When a
 * real calendar is connected the live Meet link is created instead.
 */
export class MockCalendarProvider implements CalendarProvider {
  async getBusy(
    _calendarId: string,
    _fromIso: string,
    _toIso: string,
  ): Promise<Interval[]> {
    return [];
  }

  async createEvent(
    _calendarId: string,
    _input: CreateEventInput,
  ): Promise<CreatedEvent> {
    return { eventId: `mock_${randomUUID()}` };
  }

  async deleteEvent(_calendarId: string, _eventId: string): Promise<void> {
    // no-op
  }
}
