/** In-memory per-key rate limiting (one instance; resets on restart). */

export interface KeyedRateLimiter {
  /** Record an attempt for `key`: 0 if allowed, else ms until the next one is. */
  take(key: string): number;
  reset(): void;
}

/** Allow one attempt per key per `windowMs`. */
export function createKeyedRateLimiter(
  windowMs: number,
  now: () => number = Date.now,
): KeyedRateLimiter {
  const last = new Map<string, number>();
  return {
    take(key) {
      const time = now();
      const previous = last.get(key);
      if (previous !== undefined && time - previous < windowMs) {
        return windowMs - (time - previous);
      }
      last.set(key, time);
      if (last.size > 10_000) {
        // Drop expired entries so the map can't grow without bound.
        for (const [k, at] of last) if (time - at >= windowMs) last.delete(k);
      }
      return 0;
    },
    reset() {
      last.clear();
    },
  };
}
