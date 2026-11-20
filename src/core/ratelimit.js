// In-memory sliding-window limiter + in-flight lock to stop double clicks.
export class RateLimiter {
  constructor() { this.hits = new Map(); this.locks = new Set(); }
  check(key, max, windowMs, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this.hits.set(key, arr); return { ok: false, retryMs: windowMs - (now - arr[0]) }; }
    arr.push(now); this.hits.set(key, arr); return { ok: true };
  }
  async once(key, fn) {
    if (this.locks.has(key)) return { duplicate: true };
    this.locks.add(key);
    try { return { duplicate: false, value: await fn() }; } finally { this.locks.delete(key); }
  }
  sweep(now = Date.now()) { for (const [k, v] of this.hits) if (!v.some((t) => now - t < 3600e3)) this.hits.delete(k); }
}
