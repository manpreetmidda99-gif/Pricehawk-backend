// Manual price tracking — user enters prices they observe on retailer sites.
//   GET    /api/track              — all products with latest price per store
//   POST   /api/track              — { productName, store, price, currency?, url?, notes?, targetPrice? }
//   GET    /api/track/:id          — product detail with full price history
//   DELETE /api/track/:id          — remove product and its prices
//
// No auto-fetching; works regardless of retailer bot-blocking.
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { manualPrices, manualProducts } from "../db/schema.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface TrackBody {
  productName?: unknown;
  store?: unknown;
  price?: unknown;
  currency?: unknown;
  url?: unknown;
  notes?: unknown;
  targetPrice?: unknown;
}

function validateBody(body: TrackBody) {
  const productName = typeof body.productName === "string" ? body.productName.trim() : "";
  if (!productName) throw new BadRequestError('Provide "productName" as a non-empty string.');
  if (productName.length > 200) throw new BadRequestError('"productName" is too long (max 200).');

  const store = typeof body.store === "string" ? body.store.trim() : "";
  if (!store) throw new BadRequestError('Provide "store" as a non-empty string (e.g. "Amazon", "Best Buy").');
  if (store.length > 100) throw new BadRequestError('"store" is too long (max 100).');

  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw new BadRequestError('"price" must be a positive number.');

  let currency = "USD";
  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !/^[A-Za-z]{3}$/.test(body.currency.trim())) {
      throw new BadRequestError('"currency" must be a 3-letter code like "USD".');
    }
    currency = body.currency.trim().toUpperCase();
  }

  let url: string | undefined;
  if (body.url !== undefined && body.url !== null && body.url !== "") {
    if (typeof body.url !== "string") throw new BadRequestError('"url" must be a string.');
    url = body.url.trim();
    if (url && !/^https?:\/\//i.test(url)) throw new BadRequestError('"url" must start with http:// or https://.');
  }

  let notes: string | undefined;
  if (body.notes !== undefined && body.notes !== null && body.notes !== "") {
    if (typeof body.notes !== "string") throw new BadRequestError('"notes" must be a string.');
    notes = body.notes.trim().slice(0, 500);
  }

  let targetPrice: number | undefined;
  if (body.targetPrice !== undefined && body.targetPrice !== null && body.targetPrice !== "") {
    const n = Number(body.targetPrice);
    if (!Number.isFinite(n) || n <= 0) throw new BadRequestError('"targetPrice" must be a positive number.');
    targetPrice = n;
  }

  return { productName, store, price, currency, url, notes, targetPrice };
}

export function trackRoute() {
  const r = new Hono();

  // List all products with their latest price per store, cheapest highlighted.
  r.get("/", async (c) => {
    const products = await db.select().from(manualProducts).orderBy(desc(manualProducts.createdAt));
    const out = [];
    for (const p of products) {
      const prices = await db
        .select()
        .from(manualPrices)
        .where(eq(manualPrices.productId, p.id))
        .orderBy(desc(manualPrices.recordedAt));

      // Latest price per store (dedupe by store, keep most recent)
      const seen = new Set<string>();
      const latestByStore: typeof prices = [];
      for (const pr of prices) {
        const key = pr.store.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          latestByStore.push(pr);
        }
      }

      // Find cheapest (same currency only for fair comparison)
      const currencies = [...new Set(latestByStore.map((x) => x.currency))];
      let cheapest: string | null = null;
      if (currencies.length === 1 && latestByStore.length > 0) {
        let min = Infinity;
        for (const pr of latestByStore) {
          const v = Number(pr.price);
          if (v < min) {
            min = v;
            cheapest = pr.id;
          }
        }
      }

      const target = num(p.targetPrice);
      const hitTarget =
        target !== null && cheapest !== null
          ? latestByStore.find((x) => x.id === cheapest && Number(x.price) <= target)
          : null;

      out.push({
        id: p.id,
        name: p.name,
        targetPrice: target,
        targetCurrency: p.targetCurrency,
        createdAt: iso(p.createdAt),
        stores: latestByStore.map((pr) => ({
          id: pr.id,
          store: pr.store,
          price: num(pr.price),
          currency: pr.currency,
          url: pr.url,
          notes: pr.notes,
          recordedAt: iso(pr.recordedAt),
          isCheapest: pr.id === cheapest,
        })),
        cheapestId: cheapest,
        targetHit: !!hitTarget,
        priceCount: prices.length,
      });
    }
    return c.json({ products: out });
  });

  // Add a price entry (creates the product if the name is new, case-insensitive).
  r.post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as TrackBody;
    const v = validateBody(body);

    // Find existing product by case-insensitive name, or create it.
    const existing = await db.select().from(manualProducts);
    let product = existing.find((p) => p.name.toLowerCase() === v.productName.toLowerCase());

    if (!product) {
      const [created] = await db
        .insert(manualProducts)
        .values({
          name: v.productName,
          targetPrice: v.targetPrice !== undefined ? String(v.targetPrice) : null,
          targetCurrency: v.targetPrice !== undefined ? v.currency : null,
        })
        .returning();
      product = created;
    } else if (v.targetPrice !== undefined && product.targetPrice === null) {
      // Backfill target price if the product didn't have one.
      await db
        .update(manualProducts)
        .set({ targetPrice: String(v.targetPrice), targetCurrency: v.currency })
        .where(eq(manualProducts.id, product.id));
      product = { ...product, targetPrice: String(v.targetPrice), targetCurrency: v.currency };
    }

    const [entry] = await db
      .insert(manualPrices)
      .values({
        productId: product.id,
        store: v.store,
        price: String(v.price),
        currency: v.currency,
        url: v.url ?? null,
        notes: v.notes ?? null,
      })
      .returning();

    // Check if this hits the target price.
    const target = num(product.targetPrice);
    const targetHit = target !== null && v.price <= target;

    return c.json(
      {
        id: entry.id,
        productId: product.id,
        productName: product.name,
        store: entry.store,
        price: num(entry.price),
        currency: entry.currency,
        url: entry.url,
        notes: entry.notes,
        recordedAt: iso(entry.recordedAt),
        targetHit,
      },
      201,
    );
  });

  // Full price history for one product.
  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await db.select().from(manualProducts).where(eq(manualProducts.id, id)).limit(1);
    const product = rows[0];
    if (!product) throw new NotFoundError("Product not found.");

    const prices = await db
      .select()
      .from(manualPrices)
      .where(eq(manualPrices.productId, id))
      .orderBy(desc(manualPrices.recordedAt));

    return c.json({
      id: product.id,
      name: product.name,
      targetPrice: num(product.targetPrice),
      targetCurrency: product.targetCurrency,
      createdAt: iso(product.createdAt),
      history: prices.map((pr) => ({
        id: pr.id,
        store: pr.store,
        price: num(pr.price),
        currency: pr.currency,
        url: pr.url,
        notes: pr.notes,
        recordedAt: iso(pr.recordedAt),
      })),
    });
  });

  // Delete a product and all its prices.
  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await db
      .delete(manualProducts)
      .where(eq(manualProducts.id, id))
      .returning({ id: manualProducts.id });
    if (deleted.length === 0) throw new NotFoundError("Product not found.");
    return c.json({ ok: true, deleted: id });
  });

  return r;
}
