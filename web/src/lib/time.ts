import { DateTime } from 'luxon';

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function fmtTime(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toLocaleString(DateTime.TIME_SIMPLE);
}

export function fmtTimeWithZone(iso: string, tz: string): string {
  return DateTime.fromISO(iso)
    .setZone(tz)
    .toLocaleString({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

export function fmtLongDate(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toLocaleString({
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function fmtFull(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toLocaleString({
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Short label for the zone, e.g. "CDT" / "GMT+2". */
export function zoneAbbrev(tz: string): string {
  return DateTime.now().setZone(tz).toFormat('ZZZZ');
}

/** A curated set of common IANA zones for the picker, with the guessed zone
 * pinned to the top if it isn't already present. */
export function timezoneOptions(): string[] {
  const common = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Toronto',
    'America/Mexico_City',
    'America/Sao_Paulo',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Athens',
    'Africa/Johannesburg',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Auckland',
    'UTC',
  ];
  const guess = guessTimezone();
  return common.includes(guess) ? common : [guess, ...common];
}
