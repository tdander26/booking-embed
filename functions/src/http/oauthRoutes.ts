import { Router, type Request } from 'express';
import { logger } from 'firebase-functions';
import { db, COL } from '../firebase';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '../config';
import {
  makeOAuthClient,
  saveGoogleTokens,
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
    const redirectBack = (status: string) => res.redirect(`/admin?google=${status}`);
    const code = req.query.code;
    const state = req.query.state;
    if (typeof code !== 'string' || typeof state !== 'string') {
      redirectBack('error');
      return;
    }

    const stateRef = db.collection(COL.oauthStates).doc(state);
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
    // v2: a per-member connect flow stamps the member id into the state doc. When
    // present we write a multi-account connection; when absent we keep the legacy
    // single-token path so the live single-provider site never breaks mid-rollout.
    const memberId = snap.data()?.memberId as string | undefined;

    const clientId = safeValue(GOOGLE_CLIENT_ID);
    const clientSecret = safeValue(GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      redirectBack('unconfigured');
      return;
    }

    try {
      const client = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) {
        // Happens if the user previously consented without prompt=consent.
        redirectBack('norefresh');
        return;
      }

      if (!memberId) {
        // LEGACY path unchanged — keeps the live single-provider site working.
        await saveGoogleTokens({
          refreshToken: tokens.refresh_token,
          calendarId: 'primary',
          scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
          updatedAt: new Date().toISOString(),
        });
        redirectBack('connected');
        return;
      }

      // NEW per-member multi-account path. Bind a fresh OAuth client to the
      // account's refresh token, discover its identity + calendar list, then
      // upsert the connection under members/{memberId}/connections/{connId}.
      const oauth = makeOAuthClient(clientId, clientSecret, resolveRedirectUri(req));
      oauth.setCredentials({ refresh_token: tokens.refresh_token });
      const accountEmail = await fetchAccountEmail(oauth);
      const calendars = await listCalendars(oauth);
      await upsertConnection(memberId, {
        accountEmail,
        refreshToken: tokens.refresh_token,
        scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
        calendars,
      });
      redirectBack(`connected&member=${encodeURIComponent(memberId)}`);
    } catch (err) {
      logger.error('Google OAuth callback failed');
      redirectBack('error');
    }
  }),
);
