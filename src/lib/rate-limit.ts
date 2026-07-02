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

/**
 * Hard cap on tracked buckets. Without a trusted proxy every caller shares the
 * "anon" key so the map stays tiny; with one, a client rotating X-Forwarded-For
 * could otherwise grow it without bound. When the cap is reached we evict the
 * oldest-inserted entry (Map preserves insertion order) so memory stays bounded
 * regardless of input.
 */
const MAX_BUCKETS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next attempt is permitted (0 if allowed now). */
  retryAfter: number;
  remaining: number;
}

/**
 * Prune buckets whose most recent hit is older than `cutoff`, then enforce the
 * size cap. Runs on every call — deterministic rather than probabilistic, so a
 * burst can't outrun the collector — and is cheap because expired hits are
 * dropped and empty buckets removed each pass.
 */
function sweep(cutoff: number): void {
  for (const [k, b] of buckets) {
    if (b.hits.length === 0 || b.hits[b.hits.length - 1] < cutoff) {
      buckets.delete(k);
    }
  }
  // Backstop: if live buckets still exceed the cap (many distinct keys inside
  // one window), evict oldest-inserted until we're back under it.
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/**
 * Record an attempt against `key` and report whether it's within `limit` per
 * sliding `windowMs`. An attempt is only counted (pushed) while under the
 * limit, so the stored history — and thus memory — is bounded by `limit` per
 * key even under sustained abuse.
 */
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
    sweep(cutoff);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  sweep(cutoff);

  return {
    allowed: true,
    retryAfter: 0,
    remaining: Math.max(0, limit - bucket.hits.length),
  };
}

/**
 * Forget a key's recorded attempts. Called after a successful login so a few
 * typos followed by the correct password don't leave the bucket near its limit
 * (and, combined with checking the password before the limit, guarantees a
 * valid credential is never thrown away to lockout).
 */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
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
