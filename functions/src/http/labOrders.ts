import type { Request, Response } from 'express';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase';
import { sendEmail } from '../email/resend';
import { appendLabOrderRow } from '../sheet';

/**
 * Lab-order intake for the momentumhealthwellnessmn.com new-patient wizard.
 *
 * This is a STANDALONE handler exported as its own Cloud Function (`labOrder`
 * in index.ts), deliberately separate from the booking `api` Express app so
 * deploying/changing it can never affect the live booking flow.
 *
 * HIPAA posture (mirrors the rest of this codebase):
 * - PHI is written ONLY server-side via the Admin SDK into a root `labOrders`
 *   collection. Firestore rules deny ALL direct client read/write (catch-all
 *   `match /{document=**} { allow read,write: if false }`), so the public can
 *   never read these docs. Dr. Todd reads them from the authenticated Firebase
 *   console (or a future Google-sign-in admin view).
 * - Only handle real patient PHI once the Google Cloud BAA is in place for this
 *   project (Dr. Todd has confirmed it is, via his other apps under the same
 *   Google Cloud account).
 * - Notifications are PHI-FREE: they say only "a new order came in, log in to
 *   view." NO name/DOB/phone/address ever leaves in an email or text, so we
 *   don't need a separate BAA with Resend/the carrier.
 */

const COLLECTION = 'labOrders';

// PHI-FREE alert recipients. Change these to update who gets notified.
const ALERT_EMAIL = 'doc@drtoddanderson.com';
// Free "text": Verizon email-to-SMS gateway for 309-846-7884. (For true SMS,
// wire Twilio later — small per-message cost.)
const ALERT_SMS = '3098467884@vtext.com';
// From-address on the Resend-verified domain (momentumhealthwellnessmn.com).
// Required so sends to addresses other than the Resend owner are accepted.
const ALERT_FROM = 'Momentum Health <alerts@momentumhealthwellnessmn.com>';
// Where Dr. Todd reads the actual order details: the "Momentum — Lab Orders"
// Google Sheet (opens with his existing Google login).
const ADMIN_URL = 'https://docs.google.com/spreadsheets/d/1V0Cbwr9NvkyTbXzQZRDhPMosrecMb5h12x80nsM16yw/edit';

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Validate + normalize the four PHI fields. Returns field-level errors (safe to
 * expose — they contain no PHI) so the client can highlight what to fix. */
function validate(body: Record<string, unknown>) {
  const errors: Record<string, string> = {};

  const name = str(body.name);
  if (name.length < 2 || name.length > 200) errors.name = 'A full legal name is required.';

  const dob = str(body.dob);
  let dobOk = /^\d{4}-\d{2}-\d{2}$/.test(dob);
  if (dobOk) {
    const d = new Date(dob + 'T00:00:00Z');
    const year = Number(dob.slice(0, 4));
    dobOk = !Number.isNaN(d.getTime()) && d.getTime() < Date.now() && year >= 1900;
  }
  if (!dobOk) errors.dob = 'A valid date of birth is required.';

  const phoneDigits = str(body.phone).replace(/\D/g, '');
  if (phoneDigits.length !== 10) errors.phone = 'A 10-digit phone number is required.';

  const street = str(body.street);
  if (street.length < 2 || street.length > 200) errors.street = 'A street address is required.';

  const city = str(body.city);
  if (city.length < 1 || city.length > 100) errors.city = 'A city is required.';

  const state = str(body.state).toUpperCase();
  if (!US_STATES.has(state)) errors.state = 'A valid state is required.';

  const zip = str(body.zip);
  if (!/^\d{5}$/.test(zip)) errors.zip = 'A 5-digit ZIP code is required.';

  // Optional free-text: extra tests the patient asks for (e.g. Testosterone).
  const additionalTests = str(body.additionalTests).slice(0, 1000);

  return {
    errors,
    value: { name, dob, phone: phoneDigits, street, city, state, zip, additionalTests },
  };
}

/** Best-effort PHI-FREE alerts. Never throws — a notify failure must not fail
 * the patient's submission (their order is already saved). */
async function notify(id: string): Promise<void> {
  const results = await Promise.allSettled([
    sendEmail({
      from: ALERT_FROM,
      to: ALERT_EMAIL,
      subject: 'New lab order submitted',
      text:
        'A new patient just submitted the lab-order form on your website.\n\n' +
        'Open your Lab Orders sheet to view the details: ' + ADMIN_URL + '\n\n' +
        'Then place the order in Evexia.\n\nReference: ' + id,
      html:
        '<p>A new patient just submitted the lab-order form on your website.</p>' +
        '<p><a href="' + ADMIN_URL + '">Open your Lab Orders sheet</a> to view the details, then place the order in Evexia.</p>' +
        '<p style="color:#888;font-size:12px">Reference: ' + id + '</p>',
      idempotencyKey: 'laborder-email-' + id,
    }),
    sendEmail({
      from: ALERT_FROM,
      to: ALERT_SMS,
      subject: 'Momentum',
      text: 'New lab order submitted on your website. Log in to view and place it in Evexia.',
      html: 'New lab order submitted on your website. Log in to view and place it in Evexia.',
      idempotencyKey: 'laborder-sms-' + id,
    }),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error('lab_order_notify_failed', { channel: i === 0 ? 'email' : 'sms', reason: String(r.reason) });
    }
  });
}

/**
 * HTTPS handler for the standalone `labOrder` function. CORS + preflight are
 * handled by the onRequest({ cors: true }) wrapper in index.ts, so this only
 * needs to handle POST.
 */
export async function handleLabOrder(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'POST only.' });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const { errors, value } = validate(body);

  if (Object.keys(errors).length > 0) {
    // `fields` is PHI-free (messages only) and surfaced to the client.
    res.status(400).json({ error: 'invalid_lab_order', message: 'Some details need another look.', fields: errors });
    return;
  }

  try {
    const ref = await db.collection(COLLECTION).add({
      ...value,
      status: 'new', // new -> ordered -> done (managed from the admin view)
      source: 'website-wizard',
      createdAt: FieldValue.serverTimestamp(),
    });

    // PHI-FREE server log (doc id is not PHI). Never log the patient fields.
    logger.info('lab_order_received', { id: ref.id });

    // Best-effort side effects — neither can fail the submission (already saved):
    //  - PHI-free email + text alert
    //  - append a row to the "Momentum — Lab Orders" Google Sheet
    const submitted = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    await Promise.all([
      notify(ref.id),
      appendLabOrderRow([
        submitted, value.name, value.dob, value.phone,
        value.street, value.city, value.state, value.zip,
        value.additionalTests || '', '', 'new', ref.id,
      ]),
    ]);

    res.status(201).json({ ok: true, id: ref.id });
  } catch (err) {
    logger.error('lab_order_write_failed', err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
}
