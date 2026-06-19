import { randomUUID } from '../util/ids';
import type { Interval } from '../scheduling/slots';
import type {
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
} from './provider';

/**
 * Used in the emulator and before a real Google calendar is connected. Reports
 * no external busy times (the calendar is wide open) and fabricates plausible
 * event ids / Meet links so the booking flow is fully demoable offline.
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
    input: CreateEventInput,
  ): Promise<CreatedEvent> {
    return {
      eventId: `mock_${randomUUID()}`,
      meetUrl: input.withMeet
        ? 'https://meet.google.com/lookup/mock-demo-link'
        : undefined,
    };
  }

  async deleteEvent(_calendarId: string, _eventId: string): Promise<void> {
    // no-op
  }
}
