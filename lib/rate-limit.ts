// Tiny in-process, best-effort rate limiter (no next/* imports so it unit
// tests cleanly). Per-instance sliding window keyed by an arbitrary string.
// Not a security boundary on its own — it caps casual abuse of unauthenticated
// endpoints; a CAPTCHA / edge WAF is the intended follow-up.

export interface RateLimitOptions {
  /** window length in ms */
  windowMs: number;
  /** max requests allowed within the window before limiting kicks in */
  max: number;
}

/**
 * Returns a `limited(key, now?)` predicate: records the hit and returns true
 * once a key exceeds `max` within `windowMs`. State lives in a closure Map and
 * resets on process restart.
 */
export function createFixedWindowLimiter(opts: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  return function limited(key: string, now: number = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > opts.max;
  };
}
