// Central environment configuration. Fails fast at boot when a
// required variable is missing so misconfiguration is never silent.
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return n;
}

export const config = {
  port: int("PORT", 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",

  // Shared secret for all /api/* routes (x-api-key header).
  apiKey: required("API_KEY"),

  databaseUrl: required("DATABASE_URL"),

  // Browser origins allowed to call the API (the PriceHawk site).
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  cacheTtlSeconds: int("CACHE_TTL_SECONDS", 900),
  searchCacheTtlSeconds: int("SEARCH_CACHE_TTL_SECONDS", 300),

  rateLimitWindowMs: int("RATE_LIMIT_WINDOW_MS", 60_000),
  rateLimitMax: int("RATE_LIMIT_MAX", 100),
  searchRateLimitMax: int("SEARCH_RATE_LIMIT_MAX", 20),

  fxApiUrl: process.env.FX_API_URL ?? "https://open.er-api.com/v6/latest/USD",
};
