// POST /api/compare — cross-retailer comparison with honest currency rules.
// Body: { "query": "..." } OR { "url": "..." } (exactly one).
//
// - Every offer carries its currency.
// - Single-currency sets are ranked by price; the cheapest in-stock
//   offer is crowned.
// - Mixed-currency sets are converted to USD using timestamped public FX
//   rates, and the conversion metadata is returned. If FX rates are
//   unavailable, NO cheapest is crowned — the response says why.
import { Hono } from "hono";
import { TtlCache } from "../lib/cache.js";
import { BadRequestError, HttpError } from "../lib/errors.js";
import { convert, getFxRates, round2 } from "../lib/fx.js";
import { Offer, Unavailable, getPriceForUrl, searchOffers } from "../lib/search.js";

interface RankedOffer extends Offer {
  /** Present only when a mixed-currency set was converted for ranking. */
  priceUSD?: number;
}

function pickCheapest(offers: RankedOffer[]): RankedOffer | null {
  if (offers.length === 0) return null;
  // Prefer in-stock offers; fall back to the outright cheapest.
  return offers.find((o) => o.inStock !== false) ?? offers[0];
}

export function compareRoute(priceCache: TtlCache<Offer>) {
  const r = new Hono();

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; url?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if ((query && url) || (!query && !url)) {
      throw new BadRequestError('Provide exactly one of "query" or "url".');
    }

    let offers: Offer[] = [];
    let unavailable: Unavailable[] = [];
    let sourceNote: string | undefined;

    if (query) {
      if (query.length > 200) throw new BadRequestError("Query is too long (max 200 characters).");
      const result = await searchOffers(query, priceCache);
      offers = result.offers;
      unavailable = result.unavailable;
    } else {
      // URL mode: verify the given page, then hunt the same product elsewhere
      // by searching its title so `offers` is a real comparison, not one row.
      const base = await getPriceForUrl(url, priceCache);
      offers = [base];
      sourceNote = `Base offer verified from ${base.store}.`;
      try {
        const result = await searchOffers(base.title, priceCache);
        const seen = new Set(offers.map((o) => `${o.store}|${o.url}`));
        for (const o of result.offers) {
          const key = `${o.store}|${o.url}`;
          if (!seen.has(key)) {
            seen.add(key);
            offers.push(o);
          }
        }
        unavailable = result.unavailable.filter((u) => u.url !== base.url);
      } catch {
        // Search-hunt is best-effort; the verified base offer still stands.
      }
    }

    if (offers.length === 0) {
      return c.json({
        query: query || undefined,
        offers: [],
        cheapest: null,
        unavailable,
        note: "No verifiable offers found — stores may have blocked the requests (see `unavailable`).",
      });
    }

    const currencies = [...new Set(offers.map((o) => o.currency))];

    // Single currency: rank directly.
    if (currencies.length === 1) {
      const ranked: RankedOffer[] = [...offers].sort((a, b) => a.price - b.price);
      return c.json({
        ...(query ? { query } : { url }),
        ...(sourceNote ? { note: sourceNote } : {}),
        offers: ranked,
        cheapest: pickCheapest(ranked),
        unavailable,
      });
    }

    // Mixed currencies: convert transparently, or decline to rank.
    try {
      const fx = await getFxRates();
      const ranked: RankedOffer[] = offers
        .map((o) => ({ ...o, priceUSD: round2(convert(o.price, o.currency, "USD", fx)) }))
        .sort((a, b) => (a.priceUSD as number) - (b.priceUSD as number));
      return c.json({
        ...(query ? { query } : { url }),
        ...(sourceNote ? { note: sourceNote } : {}),
        offers: ranked,
        cheapest: pickCheapest(ranked),
        unavailable,
        fx: {
          convertedTo: "USD",
          source: fx.source,
          ratesAt: fx.fetchedAt,
          ...(fx.stale ? { stale: true } : {}),
        },
        note:
          "Offers span multiple currencies, so prices were converted to USD for ranking " +
          `using ${fx.source} rates from ${fx.fetchedAt}. Original prices and currencies are preserved on each offer.`,
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return c.json({
        ...(query ? { query } : { url }),
        offers,
        cheapest: null,
        unavailable,
        ranking: {
          status: "declined",
          reason:
            `Offers span multiple currencies (${currencies.join(", ")}) and live FX rates ` +
            "are currently unavailable, so no cross-currency ranking was performed. " +
            "Compare the per-offer prices and currencies manually.",
        },
      });
    }
  });

  return r;
}
