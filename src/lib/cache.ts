// Tiny in-memory TTL cache. Keeps retailer pages from being hammered.
// Single-instance safe; for multi-instance deployments swap in Redis.
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private defaultTtlMs: number,
    private maxEntries = 2000,
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number = this.defaultTtlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
