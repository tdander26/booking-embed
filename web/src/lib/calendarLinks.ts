import { DateTime } from 'luxon';

function compact(iso: string): string {
  return DateTime.fromISO(iso).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
}

function escIcs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n');
}

export interface CalEvent {
  title: string;
  startUtc: string;
  endUtc: string;
  details?: string;
  location?: string;
  uid?: string;
}

export function googleCalUrl(e: CalEvent): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${compact(e.startUtc)}/${compact(e.endUtc)}`,
  });
  if (e.details) p.set('details', e.details);
  if (e.location) p.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function icsDataUrl(e: CalEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//booking-embed//EN',
    'BEGIN:VEVENT',
    `UID:${e.uid ?? compact(e.startUtc)}@booking-embed`,
    `DTSTAMP:${compact(new Date().toISOString())}`,
    `DTSTART:${compact(e.startUtc)}`,
    `DTEND:${compact(e.endUtc)}`,
    `SUMMARY:${escIcs(e.title)}`,
    e.details ? `DESCRIPTION:${escIcs(e.details)}` : '',
    e.location ? `LOCATION:${escIcs(e.location)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.join('\r\n'));
}
