// POST /api/price — verified price for one retailer URL.
// Body: { "url": "https://www.example.com/product/123" }
// Success: { title, price, currency, store, url, image?, inStock? }
// Failure: honest error (blocked / ambiguous / not_found / fetch_error).
import { Hono } from "hono";
import { TtlCache } from "../lib/cache.js";
import { BadRequestError } from "../lib/errors.js";
import { Offer, getPriceForUrl } from "../lib/search.js";

export function priceRoute(priceCache: TtlCache<Offer>) {
  const r = new Hono();

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new BadRequestError('Provide "url" as a non-empty string.');

    const offer = await getPriceForUrl(url, priceCache);
    return c.json({
      title: offer.title,
      price: offer.price,
      currency: offer.currency,
      store: offer.store,
      url: offer.url,
      ...(offer.image ? { image: offer.image } : {}),
      ...(offer.inStock !== undefined ? { inStock: offer.inStock } : {}),
    });
  });

  return r;
}
