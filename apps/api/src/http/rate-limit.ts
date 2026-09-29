/**
 * Minimal in-process rate limiting (Phase 6): a fixed one-minute window per client address and
 * bucket. Protects the expensive endpoints (uploads, processing, demo tooling) from floods; it is
 * not a substitute for an edge proxy's limits. Per process and in memory: several API processes
 * each count separately and a restart resets the counts. A distributed limiter (shared store) is
 * future work (docs/SECURITY.md).
 */
/** `login`: sign-in attempts, counted per client address and, separately, per account. */
export type RateBucket = 'upload' | 'processing' | 'dev' | 'login';

export class RateLimiter {
  readonly #limits: Record<RateBucket, number>;
  readonly #windowMs: number;
  readonly #now: () => number;
  #window = 0;
  #counts = new Map<string, number>();

  constructor(limits: Record<RateBucket, number>, windowMs = 60_000, now = () => Date.now()) {
    this.#limits = limits;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Counts one request. Returns null when allowed, or seconds until the window resets. */
  hit(bucket: RateBucket, client: string): number | null {
    const now = this.#now();
    const window = Math.floor(now / this.#windowMs);
    if (window !== this.#window) {
      this.#window = window;
      this.#counts = new Map();
    }
    const key = `${bucket}\u0000${client}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    if (count <= this.#limits[bucket]) return null;
    return Math.max(1, Math.ceil(((window + 1) * this.#windowMs - now) / 1000));
  }
}

/** Which bucket a route belongs to (method + route pattern), or null when it is not limited. */
export function bucketOf(method: string, route: string | undefined): RateBucket | null {
  if (!route) return null;
  if (route.startsWith('/api/v1/dev/')) return 'dev';
  if (method !== 'POST') return null;
  if (route === '/api/v1/auth/login' || route === '/api/v1/auth/demo') return 'login';
  if (route === '/api/v1/documents' || route === '/api/v1/imports') return 'upload';
  if (
    route === '/api/v1/invoices/:id/reprocess' ||
    route === '/api/v1/invoices/:id/reject' ||
    route === '/api/v1/questions/:id/answer' ||
    route === '/api/v1/imports/:id/confirm'
  )
    return 'processing';
  return null;
}
