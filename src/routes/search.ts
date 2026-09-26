// POST /api/search — live product search across retailers.
// Body: { "query": "sony wh-1000xm5" }
// Only offers with a *verified* price+currency are returned; blocked or
// unreadable stores land in `unavailable` with an explicit reason.
import { Hono } from "hono";
import { config } from "../config.js";
import { TtlCache } from "../lib/cache.js";
import { BadRequestError } from "../lib/errors.js";
import { Offer, searchOffers } from "../lib/search.js";

export function searchRoute(priceCache: TtlCache<Offer>) {
  const r = new Hono();
  const searchCache = new TtlCache<{ offers: Offer[]; unavailable: unknown[] }>(
    config.searchCacheTtlSeconds * 1000,
  );

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) throw new BadRequestError('Provide "query" as a non-empty string.');
    if (query.length > 200) throw new BadRequestError("Query is too long (max 200 characters).");

    const cacheKey = `search:${query.toLowerCase()}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return c.json({ query, ...cached, cached: true });

    const result = await searchOffers(query, priceCache);
    const payload = {
      query,
      offers: result.offers,
      unavailable: result.unavailable,
      ...(result.offers.length === 0
        ? {
            note: "No verifiable offers found — stores may have blocked the requests (see `unavailable`).",
          }
        : {}),
    };
    searchCache.set(cacheKey, { offers: result.offers, unavailable: result.unavailable });
    return c.json(payload);
  });

  return r;
}
