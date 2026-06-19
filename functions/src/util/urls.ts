import { APP_BASE_URL, isEmulator } from '../config';

/** Absolute base URL of the deployed app, for links in emails / OAuth redirect. */
export function appBaseUrl(): string {
  let v = '';
  try {
    v = APP_BASE_URL.value();
  } catch {
    v = '';
  }
  if (v) return v.replace(/\/$/, '');
  return isEmulator() ? 'http://localhost:5000' : '';
}

export function manageUrl(bookingId: string, token: string): string {
  const base = appBaseUrl();
  const path = `/manage?b=${encodeURIComponent(bookingId)}&t=${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}
