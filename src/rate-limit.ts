interface WindowEntry {
  timestamps: number[];
}

export function createRateLimiter(limit: number, windowMs: number) {
  const store = new Map<string, WindowEntry>();

  // Periodic cleanup to prevent memory leaks
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return {
    check(key: string): { allowed: boolean; remaining: number; resetAt: Date } {
      const now = Date.now();
      let entry = store.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        store.set(key, entry);
      }

      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

      if (entry.timestamps.length >= limit) {
        const oldest = entry.timestamps[0];
        return {
          allowed: false,
          remaining: 0,
          resetAt: new Date(oldest + windowMs),
        };
      }

      entry.timestamps.push(now);
      return {
        allowed: true,
        remaining: limit - entry.timestamps.length,
        resetAt: new Date(now + windowMs),
      };
    },
  };
}
