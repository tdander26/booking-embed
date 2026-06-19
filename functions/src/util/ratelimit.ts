/**
 * Best-effort in-memory rate limiter. Per Cloud Functions instance (so not a
 * hard global guarantee across many instances), but enough to blunt abusive
 * bursts from a single client on the public booking endpoints. App Check is the
 * stronger control; this is the cheap first line.
 */
const buckets = new Map<string, { count: number; reset: number }>();
const MAX_KEYS = 10_000;

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    // Per-key eviction (never a wholesale clear() — that would let one client
    // flush everyone's counters): drop expired buckets, then the oldest.
    for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    if (buckets.size > MAX_KEYS) {
      const oldest = [...buckets.entries()].sort((a, b) => a[1].reset - b[1].reset);
      for (let i = 0; i < oldest.length && buckets.size > MAX_KEYS; i++) {
        buckets.delete(oldest[i][0]);
      }
    }
  }
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
