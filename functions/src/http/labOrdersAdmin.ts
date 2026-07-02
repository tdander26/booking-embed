import type { Request, Response } from 'express';
import { logger } from 'firebase-functions';
import { auth, db } from '../firebase';

/**
 * Admin read/manage endpoint for lab orders (standalone `labOrderAdmin`
 * function). Separate from the booking app and from the public submit function.
 *
 * AUTH: requires a Google (Firebase Auth) ID token in `Authorization: Bearer`,
 * the email must be verified AND in ADMIN_EMAILS. PHI is returned ONLY to an
 * authenticated allowlisted admin over HTTPS; Firestore itself still denies all
 * direct client reads (everything goes through this server-side handler).
 */

const COLLECTION = 'labOrders';
const VALID_STATUS = new Set(['new', 'ordered', 'done']);

// Google-verified emails allowed to view/manage orders. Add staff here as needed.
const ADMIN_EMAILS = new Set<string>(['doc@drtoddanderson.com']);

/** Returns the admin email, or an HTTP error code to respond with. */
async function authenticate(req: Request): Promise<{ email: string } | { error: number }> {
  const header = (req.headers.authorization as string) || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return { error: 401 };
  try {
    const decoded = await auth.verifyIdToken(m[1]);
    const email = (decoded.email || '').toLowerCase();
    if (decoded.email_verified !== true || !ADMIN_EMAILS.has(email)) return { error: 403 };
    return { email };
  } catch {
    return { error: 401 };
  }
}

export async function handleLabOrderAdmin(req: Request, res: Response): Promise<void> {
  const a = await authenticate(req);
  if ('error' in a) {
    res.status(a.error).json({ error: a.error === 403 ? 'forbidden' : 'unauthorized' });
    return;
  }

  try {
    // GET — list the orders (newest first) for the authenticated admin.
    if (req.method === 'GET') {
      const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(300).get();
      const orders = snap.docs.map((d) => {
        const o = d.data();
        return {
          id: d.id,
          name: o.name ?? '',
          dob: o.dob ?? '',
          phone: o.phone ?? '',
          street: o.street ?? '',
          city: o.city ?? '',
          state: o.state ?? '',
          zip: o.zip ?? '',
          additionalTests: o.additionalTests ?? '',
          status: o.status ?? 'new',
          createdAt:
            o.createdAt && typeof o.createdAt.toMillis === 'function' ? o.createdAt.toMillis() : null,
        };
      });
      res.json({ ok: true, orders });
      return;
    }

    // POST — update one order's status (new -> ordered -> done).
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : '';
      const status = typeof body.status === 'string' ? body.status : '';
      if (!id || !VALID_STATUS.has(status)) {
        res.status(400).json({ error: 'bad_request' });
        return;
      }
      await db.collection(COLLECTION).doc(id).update({ status });
      logger.info('lab_order_status_updated', { id, status, by: a.email });
      res.json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    logger.error('lab_order_admin_error', err);
    res.status(500).json({ error: 'server_error' });
  }
}
