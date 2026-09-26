// Drizzle schema for the watchlist. Tables are created idempotently at
// boot by ensureSchema() in client.ts (no migration runner needed).
import { boolean, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

// User accounts for price alerts.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Login sessions — only the SHA-256 hash of the token is stored.
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Scheduled price alerts: daily SerpAPI re-checks against a target price.
export const priceAlerts = pgTable("price_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  query: text("query").notNull(),
  targetPrice: numeric("target_price").notNull(),
  targetCurrency: text("target_currency").notNull().default("USD"),
  lastPrice: numeric("last_price"),
  lastCurrency: text("last_currency"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastNotifiedPrice: numeric("last_notified_price"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type PriceAlert = typeof priceAlerts.$inferSelect;
