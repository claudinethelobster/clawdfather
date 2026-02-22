export function createRateLimiter(maxRequests: number, windowMs: number) {
  const store = new Map<string, number[]>();

  return {
    check(key: string): { allowed: boolean; remaining: number; resetAt: Date } {
      const now = Date.now();
      const cutoff = now - windowMs;
      let timestamps = store.get(key);

      if (timestamps) {
        timestamps = timestamps.filter((t) => t > cutoff);
      } else {
        timestamps = [];
      }

      const remaining = Math.max(0, maxRequests - timestamps.length);
      const resetAt = new Date(now + windowMs);

      if (timestamps.length >= maxRequests) {
        store.set(key, timestamps);
        return { allowed: false, remaining: 0, resetAt };
      }

      timestamps.push(now);
      store.set(key, timestamps);
      return { allowed: true, remaining: remaining - 1, resetAt };
    },
  };
}
