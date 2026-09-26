// Watchlist CRUD with price-history tracking.
//   GET    /api/watchlist                 — items + latest check each
//   POST   /api/watchlist                 — { url, targetPrice?, targetCurrency? }
//   DELETE /api/watchlist/:id
//   POST   /api/watchlist/:id/refresh     — re-check now, append history
//
// Every check is recorded honestly: ok, blocked, ambiguous, or error.
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { priceHistory, watchlistItems } from "../db/schema.js";
import { TtlCache } from "../lib/cache.js";
import { BadRequestError, HttpError, NotFoundError } from "../lib/errors.js";
import { Offer, getPriceForUrl } from "../lib/search.js";

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

type HistoryStatus = "ok" | "blocked" | "ambiguous" | "error";

function statusFromError(err: unknown): HistoryStatus {
  const code = err instanceof HttpError ? err.code : "fetch_error";
  if (code === "blocked") return "blocked";
  if (code === "ambiguous") return "ambiguous";
  return "error";
}

async function latestEntry(itemId: string) {
  const rows = await db
    .select()
    .from(priceHistory)
    .where(eq(priceHistory.itemId, itemId))
    .orderBy(desc(priceHistory.checkedAt))
    .limit(1);
  const e = rows[0];
  if (!e) return null;
  return {
    price: num(e.price),
    currency: e.currency,
    status: e.status,
    note: e.note,
    checkedAt: iso(e.checkedAt),
  };
}

function validateTarget(body: { targetPrice?: unknown; targetCurrency?: unknown }) {
  let targetPrice: number | undefined;
  let targetCurrency: string | undefined;
  if (body.targetPrice !== undefined) {
    const n = Number(body.targetPrice);
    if (!Number.isFinite(n) || n <= 0) throw new BadRequestError('"targetPrice" must be a positive number.');
    targetPrice = n;
  }
  if (body.targetCurrency !== undefined) {
    if (typeof body.targetCurrency !== "string" || !/^[A-Za-z]{3}$/.test(body.targetCurrency.trim())) {
      throw new BadRequestError('"targetCurrency" must be a 3-letter ISO code like "USD".');
    }
    targetCurrency = body.targetCurrency.trim().toUpperCase();
  }
  return { targetPrice, targetCurrency };
}

export function watchlistRoute(priceCache: TtlCache<Offer>) {
  const r = new Hono();
  // Refresh checks bypass the read cache so they reflect *now*.
  const refresh = (url: string) => getPriceForUrl(url, new TtlCache<Offer>(1));

  r.get("/", async (c) => {
    const items = await db.select().from(watchlistItems).orderBy(desc(watchlistItems.createdAt));
    const out = [];
    for (const item of items) {
      out.push({
        id: item.id,
        url: item.url,
        title: item.title,
        targetPrice: num(item.targetPrice),
        targetCurrency: item.targetCurrency,
        createdAt: iso(item.createdAt),
        latest: await latestEntry(item.id),
      });
    }
    return c.json({ items: out });
  });

  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: unknown;
      targetPrice?: unknown;
      targetCurrency?: unknown;
    };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new BadRequestError('Provide "url" as a non-empty string.');
    const { targetPrice, targetCurrency } = validateTarget(body);

    const [item] = await db
      .insert(watchlistItems)
      .values({
        url,
        targetPrice: targetPrice !== undefined ? String(targetPrice) : null,
        targetCurrency: targetCurrency ?? null,
      })
      .returning();

    // Initial check — recorded honestly whatever the outcome.
    let initial: { status: HistoryStatus; price: number | null; currency: string | null; note: string | null };
    try {
      const offer = await refresh(url);
      await db.insert(priceHistory).values({
        itemId: item.id,
        price: String(offer.price),
        currency: offer.currency,
        status: "ok",
      });
      await db.update(watchlistItems).set({ title: offer.title }).where(eq(watchlistItems.id, item.id));
      initial = { status: "ok", price: offer.price, currency: offer.currency, note: null };
    } catch (err) {
      const status = statusFromError(err);
      const note = err instanceof Error ? err.message : "Unknown error.";
      await db.insert(priceHistory).values({ itemId: item.id, status, note });
      initial = { status, price: null, currency: null, note };
    }

    return c.json(
      {
        id: item.id,
        url: item.url,
        targetPrice: num(item.targetPrice),
        targetCurrency: item.targetCurrency,
        createdAt: iso(item.createdAt),
        initialCheck: initial,
      },
      201,
    );
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await db.delete(watchlistItems).where(eq(watchlistItems.id, id)).returning({ id: watchlistItems.id });
    if (deleted.length === 0) throw new NotFoundError("Watchlist item not found.");
    return c.json({ ok: true, deleted: id });
  });

  r.post("/:id/refresh", async (c) => {
    const id = c.req.param("id");
    const rows = await db.select().from(watchlistItems).where(eq(watchlistItems.id, id)).limit(1);
    const item = rows[0];
    if (!item) throw new NotFoundError("Watchlist item not found.");

    try {
      const offer = await refresh(item.url);
      const [entry] = await db
        .insert(priceHistory)
        .values({ itemId: id, price: String(offer.price), currency: offer.currency, status: "ok" })
        .returning();
      if (!item.title) {
        await db.update(watchlistItems).set({ title: offer.title }).where(eq(watchlistItems.id, id));
      }
      return c.json({
        price: offer.price,
        currency: offer.currency,
        status: "ok",
        note: null,
        checkedAt: iso(entry.checkedAt),
      });
    } catch (err) {
      const status = statusFromError(err);
      const note = err instanceof Error ? err.message : "Unknown error.";
      const [entry] = await db
        .insert(priceHistory)
        .values({ itemId: id, status, note })
        .returning();
      // The refresh itself succeeded — it recorded an honest non-ok outcome.
      return c.json({ price: null, currency: null, status, note, checkedAt: iso(entry.checkedAt) });
    }
  });

  return r;
}
