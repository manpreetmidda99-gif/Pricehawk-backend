// PriceHawk public API — app bootstrap.
// Wiring: logging, security headers, CORS allowlist, rate limits,
// API-key auth on /api/*, routes, and the global error handler.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { ensureSchema, pool } from "./db/client.js";
import { TtlCache } from "./lib/cache.js";
import { HttpError } from "./lib/errors.js";
import { Offer } from "./lib/search.js";
import { apiKeyAuth } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { compareRoute } from "./routes/compare.js";
import { healthRoute } from "./routes/health.js";
import { priceRoute } from "./routes/price.js";
import { searchRoute } from "./routes/search.js";
import { trackRoute } from "./routes/track.js";
import { watchlistRoute } from "./routes/watchlist.js";
import { authRoute } from "./routes/auth.js";
import { alertsRoute } from "./routes/alerts.js";
import { startAlertScheduler } from "./lib/scheduler.js";

const app = new Hono();

app.use(logger());
app.use(secureHeaders());

// CORS: only the configured site origins may call from a browser.
// Non-browser clients (curl, servers) send no Origin and pass through.
app.use(
  "*",
  cors({
    // "*" allows any browser origin (public search API: no cookies or
    // credentials involved, so reflecting the origin is safe).
    origin: (origin) =>
      config.corsOrigins.includes("*")
        ? origin
        : config.corsOrigins.includes(origin)
          ? origin
          : undefined,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-api-key", "Authorization"],
    credentials: true,
    maxAge: 600,
  }),
);

// Global per-IP rate limit for the whole API surface.
app.use(
  "/api/*",
  rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax }),
);

// Shared-secret auth on /api/* — except the public endpoints the
// website calls directly from browsers (/api/search, /api/compare,
// /api/track), which rely on strict rate limits instead of a key,
// and /api/auth + /api/alerts, which use cookie sessions (requireAuth)
// instead of the shared secret. /health stays public.
app.use(
  "/api/*",
  apiKeyAuth(config.apiKey, {
    publicPaths: ["/api/search", "/api/compare", "/api/track"],
    publicPrefixes: ["/api/auth", "/api/alerts"],
  }),
);

// Stricter limits on the expensive endpoints (retailer fetching).
const strict = rateLimit({ windowMs: config.rateLimitWindowMs, max: config.searchRateLimitMax });
app.use("/api/search", strict);
app.use("/api/compare", strict);

// Short-lived price cache so retailers aren't hammered by repeats.
const priceCache = new TtlCache<Offer>(config.cacheTtlSeconds * 1000);

app.route("/health", healthRoute());
app.route("/api/search", searchRoute(priceCache));
app.route("/api/price", priceRoute(priceCache));
app.route("/api/compare", compareRoute(priceCache));
app.route("/api/watchlist", watchlistRoute(priceCache));
app.route("/api/track", trackRoute());
app.route("/api/auth", authRoute());
app.route("/api/alerts", alertsRoute());

// Serve the PriceHawk website (same origin, so no mixed-content issues).
const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = join(here, "..", "public", "index.html");
const imagesDir = join(here, "..", "public", "images");
app.get("/", async (c) => {
  try {
    const html = await readFile(indexHtml, "utf8");
    return c.html(html);
  } catch {
    return c.json({ error: { code: "not_found", message: "Website not built." } }, 404);
  }
});

// Serve product images
app.get("/images/:file", async (c) => {
  const file = c.req.param("file");
  // Only allow safe filenames
  if (!/^[a-z0-9_-]+\.(webp|png|jpg|jpeg)$/i.test(file)) {
    return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  }
  try {
    const data = await readFile(join(imagesDir, file));
    const ext = file.split(".").pop()?.toLowerCase();
    const mime = ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
    return new Response(data as any, {
      headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  }
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
  }
  console.error("Unhandled error:", err);
  return c.json({ error: { code: "internal_error", message: "Something went wrong." } }, 500);
});

async function main() {
  await ensureSchema();
  // Touch the pool so a bad DATABASE_URL fails fast here, not on first request.
  await pool.query("SELECT 1");
  // Daily price-alert checks (first run 60s after boot).
  startAlertScheduler();
  serve({ fetch: app.fetch, port: config.port }, () => {
    console.log(`pricehawk-api listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
