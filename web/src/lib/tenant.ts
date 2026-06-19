/**
 * Path-based tenant routing for the SPA. URLs look like:
 *   /{slug}                 → that practice's booking page
 *   /{slug}/admin           → that practice's admin
 *   /{slug}/manage          → manage/cancel a booking
 *   /signup                 → self-serve onboarding wizard
 *   /, /admin, /manage      → the DEFAULT_TENANT (back-compat for the live site
 *                             and existing slug-less embeds)
 *
 * Keep RESERVED in sync with functions/src/http/signup.ts so a practice slug can
 * never shadow a route.
 */
export const DEFAULT_TENANT = 'momentum';

export const RESERVED = new Set([
  'admin',
  'manage',
  'signup',
  'api',
  'embed.js',
  'assets',
  'favicon.ico',
  'index.html',
  'robots.txt',
  'static',
  'public',
  'app',
  'login',
  'logout',
  'auth',
]);

export type View = 'booking' | 'admin' | 'manage' | 'signup';

export interface Route {
  tenantSlug: string;
  view: View;
}

export function resolveRoute(pathname = window.location.pathname): Route {
  const segs = pathname.split('/').filter(Boolean);
  const first = segs[0];

  if (first === 'signup') return { tenantSlug: DEFAULT_TENANT, view: 'signup' };

  // Slug-less / reserved first segment → default tenant (legacy compatibility).
  if (!first || RESERVED.has(first)) {
    const view: View = first === 'admin' ? 'admin' : first === 'manage' ? 'manage' : 'booking';
    return { tenantSlug: DEFAULT_TENANT, view };
  }

  // First segment is a tenant slug.
  const second = segs[1];
  const view: View = second === 'admin' ? 'admin' : second === 'manage' ? 'manage' : 'booking';
  return { tenantSlug: first, view };
}
