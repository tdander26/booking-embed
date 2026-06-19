import { DateTime } from 'luxon';
import type { Booking, Branding } from '../types';
import { manageUrl } from '../util/urls';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function fmtWhen(iso: string, tz: string): string {
  return DateTime.fromISO(iso)
    .setZone(tz)
    .toLocaleString({
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
}

function locationLine(booking: Booking): string {
  switch (booking.location.type) {
    case 'google_meet':
      return booking.location.meetUrl
        ? `Google Meet: ${booking.location.meetUrl}`
        : 'Google Meet (link to follow)';
    case 'phone':
      return booking.location.details
        ? `Phone: ${booking.location.details}`
        : 'Phone call';
    case 'in_person':
      return booking.location.details
        ? `Location: ${booking.location.details}`
        : 'In person';
    default:
      return booking.location.details ?? '';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(branding: Branding, heading: string, bodyHtml: string): string {
  const brand = escapeHtml(branding.brandColor || '#0f766e');
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="background:${brand};height:8px;line-height:8px;font-size:8px;">&nbsp;</td></tr>
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(branding.displayName)}</div>
          <h1 style="margin:6px 0 16px;font-size:22px;line-height:1.25;">${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:0 32px 28px;font-size:15px;line-height:1.6;color:#334155;">${bodyHtml}</td></tr>
      </table>
      <div style="color:#94a3b8;font-size:12px;margin-top:16px;">Sent by ${escapeHtml(
        branding.displayName,
      )}'s scheduling page</div>
    </td></tr>
  </table></body></html>`;
}

function detailsBlock(booking: Booking, branding: Branding): string {
  const when = fmtWhen(booking.startUtc, booking.invitee.timezone);
  const loc = locationLine(booking);
  const brand = escapeHtml(branding.brandColor || '#0f766e');
  const manage = manageUrl(booking.id, booking.cancelToken);
  return `
    <table role="presentation" width="100%" style="background:#f8fafc;border-radius:10px;margin:4px 0 20px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-weight:600;font-size:16px;">${escapeHtml(booking.eventTypeName)}</div>
        <div style="margin-top:6px;">🗓 ${escapeHtml(when)}</div>
        ${loc ? `<div style="margin-top:4px;">📍 ${escapeHtml(loc)}</div>` : ''}
        <div style="margin-top:4px;color:#64748b;">⏱ ${booking.durationMinutes} minutes</div>
      </td></tr>
    </table>
    ${
      booking.location.type === 'google_meet' && booking.location.meetUrl
        ? `<p><a href="${escapeHtml(booking.location.meetUrl)}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Join Google Meet</a></p>`
        : ''
    }
    <p style="font-size:13px;color:#64748b;">Need to make a change?
      <a href="${escapeHtml(manage)}" style="color:${brand};">Reschedule or cancel</a>.
    </p>`;
}

function textVersion(booking: Booking, branding: Branding, lead: string): string {
  const when = fmtWhen(booking.startUtc, booking.invitee.timezone);
  return [
    lead,
    '',
    booking.eventTypeName,
    when,
    locationLine(booking),
    `${booking.durationMinutes} minutes`,
    '',
    `Manage: ${manageUrl(booking.id, booking.cancelToken)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function confirmationEmail(booking: Booking, branding: Branding): EmailContent {
  const heading = `You're booked with ${branding.displayName}`;
  return {
    subject: `Confirmed: ${booking.eventTypeName} — ${fmtWhen(
      booking.startUtc,
      booking.invitee.timezone,
    )}`,
    html: shell(
      branding,
      heading,
      `<p>Hi ${escapeHtml(booking.invitee.name)}, your time is confirmed.</p>${detailsBlock(
        booking,
        branding,
      )}`,
    ),
    text: textVersion(booking, branding, `Hi ${booking.invitee.name}, your time is confirmed.`),
  };
}

export function reminderEmail(
  booking: Booking,
  branding: Branding,
  minutesBefore: number,
): EmailContent {
  const soon =
    minutesBefore >= 1440
      ? `${Math.round(minutesBefore / 1440)} day${minutesBefore >= 2880 ? 's' : ''}`
      : minutesBefore >= 60
        ? `${Math.round(minutesBefore / 60)} hour${minutesBefore >= 120 ? 's' : ''}`
        : `${minutesBefore} minutes`;
  return {
    subject: `Reminder: ${booking.eventTypeName} in ${soon}`,
    html: shell(
      branding,
      `Reminder: your appointment is in ${soon}`,
      `<p>Hi ${escapeHtml(booking.invitee.name)}, this is a reminder of your upcoming time with ${escapeHtml(
        branding.displayName,
      )}.</p>${detailsBlock(booking, branding)}`,
    ),
    text: textVersion(
      booking,
      branding,
      `Reminder: your appointment with ${branding.displayName} is in ${soon}.`,
    ),
  };
}

export function cancellationEmail(booking: Booking, branding: Branding): EmailContent {
  return {
    subject: `Cancelled: ${booking.eventTypeName} — ${fmtWhen(
      booking.startUtc,
      booking.invitee.timezone,
    )}`,
    html: shell(
      branding,
      'Your appointment was cancelled',
      `<p>Hi ${escapeHtml(booking.invitee.name)}, the following appointment has been cancelled.</p>
       <table role="presentation" width="100%" style="background:#f8fafc;border-radius:10px;margin:4px 0 8px;">
         <tr><td style="padding:16px 18px;">
           <div style="font-weight:600;">${escapeHtml(booking.eventTypeName)}</div>
           <div style="margin-top:6px;text-decoration:line-through;color:#94a3b8;">${escapeHtml(
             fmtWhen(booking.startUtc, booking.invitee.timezone),
           )}</div>
         </td></tr>
       </table>`,
    ),
    text: textVersion(
      booking,
      branding,
      `Your appointment with ${branding.displayName} has been cancelled.`,
    ),
  };
}
