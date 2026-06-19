import { Router, type Request } from 'express';
import { logger } from 'firebase-functions';
import { db, ROOT } from '../firebase';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '../config';
import {
  makeOAuthClient,
  fetchAccountEmail,
  listCalendars,
  GOOGLE_SCOPES,
} from '../google/oauth';
import { upsertConnection } from '../members';
import { wrap } from '../util/http';

export const oauthRouter = Router();

/** Read a secret/param without throwing when unset. */
export function safeValue(p: { value(): string }): string {
  try {
    return p.value() ?? '';
  } catch {
    return '';
  }
}

/** The redirect URI must be identical on both the consent request and the
 * callback, and must match an Authorized redirect URI in the Google console. */
export function resolveRedirectUri(req: Request): string {
  const configured = safeValue(GOOGLE_REDIRECT_URI);
  if (configured) return configured;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}/api/google/callback`;
}

const STATE_TTL_MS = 10 * 60 * 1000;

oauthRouter.get(
  '/api/google/callback',
  wrap(async (req, res) => {
    // Until the tenant is known (state read), errors go to the default admin.
    const redirectBack = (status: string, tenant?: string) => {
      const base = tenant ? `/${encodeURIComponent(tenant)}/admin` : '/admin';
      res.redirect(`${base}?google=${status}`);
    };
    const code = req.query.code;
    const state = req.query.state;
    if (typeof code !== 'string' || typeof state !== 'string') {
      redirectBack('error');
      return;
    }

    const stateRef = db.collection(ROOT.oauthStates).doc(state);
    const snap = await stateRef.get();
    await stateRef.delete().catch(() => undefined); // single-use
    if (!snap.exists) {
      redirectBack('error');
      return;
    }
    const createdAt = snap.data()?.createdAt as string | undefined;
    if (!createdAt || Date.now() - new Date(createdAt).getTime() > STATE_TTL_MS) {
      redirectBack('expired');
      return;
    }
    // The connect flow stamps tenantId + memberId into the state doc; both are
    // required. The connection binds to the state's tenant+member REGARDLESS of
    // which Google account actually consents.
    const tenantId = snap.data()?.tenantId as string | undefined;
    const memberId = snap.data()?.memberId as string | undefined;
    if (!tenantId || !memberId) {
      redirectBack('error', tenantId);
      return;
    }

    const clientId = safeValue(GOOGLE_CLIENT_ID);
    const clientSecret = safeValue(GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      redirectBack('unconfigured', tenantId);
      return;
    }

    try {
      const client = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) {
        // Happens if the user previously consented without prompt=consent.
        redirectBack('norefresh', tenantId);
        return;
      }

      // Bind a fresh OAuth client to the account's refresh token, discover its
      // identity + calendar list, then upsert the connection under
      // tenants/{tenantId}/members/{memberId}/connections/{connId}.
      const oauth = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
      oauth.setCredentials({ refresh_token: tokens.refresh_token });
      const accountEmail = await fetchAccountEmail(oauth);
      const calendars = await listCalendars(oauth);
      await upsertConnection(tenantId, memberId, {
        accountEmail,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
        calendars,
      });
      redirectBack(`connected&member=${encodeURIComponent(memberId)}`, tenantId);
    } catch (err) {
      logger.error('Google OAuth callback failed');
      redirectBack('error', tenantId);
    }
  }),
);
