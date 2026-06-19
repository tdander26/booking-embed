import express from 'express';
import cors from 'cors';
import { publicRouter } from './http/publicApi';
import { adminRouter } from './http/adminApi';
import { oauthRouter } from './http/oauthRoutes';
import { errorHandler } from './util/http';

export function buildApp(): express.Express {
  const app = express();
  // Trust a fixed number of proxy hops (Firebase Hosting -> Cloud Run) so
  // req.ip is the platform-appended client IP, not a client-spoofable XFF
  // value. Adjust the hop count if your deployment topology differs.
  app.set('trust proxy', 1);
  // Single CORS layer — do NOT also set the v2 `cors` option (they conflict).
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use(oauthRouter); // public OAuth callback
  app.use(publicRouter); // public booking endpoints
  app.use(adminRouter); // /api/admin/* (auth-gated inside the router)

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
