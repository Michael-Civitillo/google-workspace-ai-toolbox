/**
 * Tiny in-process rate limiter for the login endpoint.
 *
 * Single-process only — fine for the toolbox's single-instance deployment
 * model. If you ever scale horizontally, swap this for Redis or a similar
 * shared store.
 *
 * Tracks attempts per identifier (IP) in a sliding window; rejects further
 * attempts once the limit is exceeded.
 */

interface Bucket {
  /** Timestamps of attempts within the current window (ms since epoch). */
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next attempt is permitted (0 if allowed now). */
  retryAfter: number;
  remaining: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    buckets.set(key, bucket);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  // Simple GC: occasionally prune empty buckets.
  if (Math.random() < 0.01) {
    for (const [k, b] of buckets) {
      if (b.hits.length === 0 || b.hits[b.hits.length - 1] < cutoff) {
        buckets.delete(k);
      }
    }
  }

  return {
    allowed: true,
    retryAfter: 0,
    remaining: Math.max(0, limit - bucket.hits.length),
  };
}

/**
 * Best-effort IP extraction.
 *
 * Reverse-proxy headers are client-controllable unless a trusted proxy
 * overwrites them, so we refuse to read them by default — that would let an
 * attacker rotate `X-Forwarded-For` per request and bypass per-IP login
 * limits. The operator must opt in with `TRUSTED_PROXY=true` once they've
 * confirmed their proxy strips/replaces inbound `X-Forwarded-For` and
 * `X-Real-IP` headers.
 *
 * When direct clients reach the app, this returns a fixed string so the
 * limiter degrades to a single global bucket. That throttles everyone in
 * aggregate rather than nobody — the safer failure mode.
 */
const TRUSTED_PROXY = process.env.TRUSTED_PROXY === "true";

export function clientKey(req: Request): string {
  if (!TRUSTED_PROXY) return "anon";
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "anon";
}
