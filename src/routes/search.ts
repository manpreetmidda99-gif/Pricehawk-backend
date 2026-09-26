// POST /api/search — live product search across retailers.
// Body: { "query": "sony wh-1000xm5", "serpapi_key": "optional-user-key" }
// If serpapi_key is provided, uses SerpAPI Google Shopping (BYOK model).
// Otherwise falls back to direct scraping (usually blocked).
import { Hono } from "hono";
import { config } from "../config.js";
import { TtlCache } from "../lib/cache.js";
import { BadRequestError } from "../lib/errors.js";
import { Offer, searchOffers } from "../lib/search.js";
import { searchSerpApiShopping } from "../lib/serpapi.js";

export function searchRoute(priceCache: TtlCache<Offer>) {
  const r = new Hono();
  const searchCache = new TtlCache<{ offers: Offer[]; unavailable: unknown[] }>(
    config.searchCacheTtlSeconds * 1000,
  );

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      query?: unknown;
      serpapi_key?: unknown;
    };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const serpapiKey = typeof body.serpapi_key === "string" ? body.serpapi_key.trim() : "";

    if (!query) throw new BadRequestError('Provide "query" as a non-empty string.');
    if (query.length > 200) throw new BadRequestError("Query is too long (max 200 characters).");

    // BYOK: If user provided their SerpAPI key, use it for real prices
    if (serpapiKey) {
      const cacheKey = `serpapi:${query.toLowerCase()}`;
      const cached = searchCache.get(cacheKey);
      if (cached) return c.json({ query, ...cached, cached: true, via: "serpapi" });

      const result = await searchSerpApiShopping(query, serpapiKey);

      if (result.error) {
        return c.json({
          query,
          offers: [],
          unavailable: [],
          error: result.error,
          via: "serpapi",
        });
      }

      // Convert to Offer format
      const offers: Offer[] = result.offers.map((o) => ({
        store: o.retailer,
        title: o.title,
        price: o.price,
        currency: o.currency,
        url: o.url,
        inStock: true,
        image: o.thumbnail,
      }));

      // Find cheapest
      const payload = {
        query,
        offers,
        unavailable: [],
        via: "serpapi",
        ...(offers.length === 0
          ? { note: "No offers found for this search." }
          : {}),
      };
      searchCache.set(cacheKey, { offers, unavailable: [] });
      return c.json(payload);
    }

    // Fallback: direct scraping (usually blocked)
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
            note: "No verifiable offers found — add your free SerpAPI key in Settings for automatic prices, or use Track prices to enter them manually.",
          }
        : {}),
    };
    searchCache.set(cacheKey, { offers: result.offers, unavailable: result.unavailable });
    return c.json(payload);
  });

  return r;
}
