// API-key auth for /api/* routes, with an explicit public-path allowlist.
// The PriceHawk website calls /api/search and /api/compare directly from
// browsers, and browsers can't hold a secret — so those two endpoints are
// public and protected instead by strict per-IP rate limits + result cache.
// Everything else (price checks, watchlists) still requires the key.
//
// The client sends the shared secret as the `x-api-key` header
// (or `Authorization: Bearer <key>`), compared in constant time.
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "../lib/errors.js";

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export function apiKeyAuth(expected: string, opts?: { publicPaths?: string[] }) {
  const publicPaths = new Set((opts?.publicPaths ?? []).map(normalize));
  return createMiddleware(async (c, next) => {
    const path = normalize(c.req.path);
    // Exact match, or prefix match for /api/track/* (product detail + delete).
    if (publicPaths.has(path) || path.startsWith("/api/track/")) return next();

    const headerKey = c.req.header("x-api-key") ?? "";
    const auth = c.req.header("authorization") ?? "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const provided = headerKey || bearer;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedError();
    }
    await next();
  });
}
