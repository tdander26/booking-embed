import { randomBytes, randomUUID } from 'node:crypto';

/** URL-safe unguessable token (default ~32 chars). Used for cancel tokens. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export { randomUUID };

/** Turn a name into a URL-friendly slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Firestore doc ids may not contain '/', and must avoid '.', '..'. Sanitize an
 * arbitrary string (e.g. a calendar id / email) into a safe id fragment. */
export function sanitizeForDocId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120) || 'x';
}
