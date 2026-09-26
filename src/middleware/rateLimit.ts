// In-memory per-IP rate limiter (token-bucket style, fixed window).
// Fine for a single instance (Render free tier). For multi-instance
// deployments, replace with a shared store such as Redis.
import { createMiddleware } from "hono/factory";

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: { windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();

  // Periodically drop expired buckets so the map can't grow forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (now > b.resetAt) buckets.delete(ip);
    }
  }, options.windowMs);
  sweep.unref?.();

  return createMiddleware(async (c, next) => {
    const forwarded = c.req.header("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() || "unknown";

    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;

    c.header("X-RateLimit-Limit", String(options.max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));

    if (bucket.count > options.max) {
      c.header("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests — please slow down." } },
        429,
      );
    }
    await next();
  });
}
