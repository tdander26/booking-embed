import { Resend } from 'resend';
import { logger } from 'firebase-functions';
import { RESEND_API_KEY, EMAIL_FROM, isEmulator } from '../config';

function secret(): string {
  try {
    return RESEND_API_KEY.value();
  } catch {
    return '';
  }
}

/**
 * Send one transactional email. In the emulator, or when no API key is set,
 * logs instead of sending so the flow works offline. Returns the provider id
 * (or null when not actually sent).
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string; // per-tenant sender; falls back to the shared EMAIL_FROM
  idempotencyKey?: string;
}): Promise<string | null> {
  const key = secret();
  // Real Resend keys start with "re_"; anything else (incl. deploy placeholders)
  // means email isn't configured yet — log instead of erroring on every send.
  if (isEmulator() || !key.startsWith('re_')) {
    logger.info('[email:dev] (not sent — Resend not configured)', {
      to: opts.to,
      subject: opts.subject,
    });
    return null;
  }
  const resend = new Resend(key);
  const { data, error } = await resend.emails.send(
    {
      from: opts.from || EMAIL_FROM.value(),
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    },
    // Idempotency key goes in the SECOND options argument, not the payload.
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  if (error) {
    throw new Error(`Resend send failed: ${error.name} — ${error.message}`);
  }
  return data?.id ?? null;
}
