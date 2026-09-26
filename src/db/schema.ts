// Drizzle schema for the watchlist. Tables are created idempotently at
// boot by ensureSchema() in client.ts (no migration runner needed).
import { numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const watchlistItems = pgTable("watchlist_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(),
  title: text("title"),
  targetPrice: numeric("target_price"),
  targetCurrency: text("target_currency"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const priceHistory = pgTable("price_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id")
    .notNull()
    .references(() => watchlistItems.id, { onDelete: "cascade" }),
  price: numeric("price"),
  currency: text("currency"),
  // ok | blocked | ambiguous | error
  status: text("status").notNull().default("ok"),
  note: text("note"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
});

// Manual price tracking — user enters prices they see on store sites.
// No auto-fetching; works regardless of retailer blocking.
export const manualProducts = pgTable("manual_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  targetPrice: numeric("target_price"),
  targetCurrency: text("target_currency"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const manualPrices = pgTable("manual_prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => manualProducts.id, { onDelete: "cascade" }),
  store: text("store").notNull(),
  price: numeric("price").notNull(),
  currency: text("currency").notNull().default("USD"),
  url: text("url"),
  notes: text("notes"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type PriceHistoryEntry = typeof priceHistory.$inferSelect;
export type ManualProduct = typeof manualProducts.$inferSelect;
export type ManualPrice = typeof manualPrices.$inferSelect;
