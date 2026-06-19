import { Router, type Request } from 'express';
import { logger } from 'firebase-functions';
import { db, COL } from '../firebase';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } from '../config';
import {
  makeOAuthClient,
  saveGoogleTokens,
  GOOGLE_SCOPES,
} from '../google/oauth';
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
      await saveGoogleTokens({
        refreshToken: tokens.refresh_token,
        calendarId: 'primary',
        scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
        updatedAt: new Date().toISOString(),
      });
      redirectBack('connected');
    } catch (err) {
      logger.error('Google OAuth callback failed');
      redirectBack('error');
    }
  }),
);
