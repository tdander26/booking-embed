import { logger } from 'firebase-functions';
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  isEmulator,
} from '../config';

function val(s: { value(): string }): string {
  try {
    return s.value();
  } catch {
    return '';
  }
}

/**
 * Send one SMS via Twilio. Disabled (logs only) in the emulator or when Twilio
 * credentials / from-number are not configured — so SMS is fully opt-in and the
 * default deployment costs nothing extra. Returns the message SID or null.
 */
export async function sendSms(to: string, body: string): Promise<string | null> {
  const sid = val(TWILIO_ACCOUNT_SID);
  const token = val(TWILIO_AUTH_TOKEN);
  const from = val(TWILIO_FROM_NUMBER);
  if (isEmulator() || !sid || !token || !from) {
    logger.info('[sms:dev] (not sent)', { to });
    return null;
  }
  // Imported lazily so the dependency is only loaded when SMS is actually used.
  const twilio = (await import('twilio')).default;
  const client = twilio(sid, token);
  const msg = await client.messages.create({ body, from, to });
  return msg.sid;
}

export function smsConfigured(): boolean {
  return !!val(TWILIO_ACCOUNT_SID) && !!val(TWILIO_AUTH_TOKEN) && !!val(TWILIO_FROM_NUMBER);
}
