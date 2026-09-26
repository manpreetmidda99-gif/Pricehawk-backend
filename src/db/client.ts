// Postgres connection + idempotent schema creation at boot.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";

function useSsl(url: string): boolean | { rejectUnauthorized: boolean } {
  // Local docker Postgres has no SSL; hosted providers (Render, etc.) do.
  if (/(localhost|127\.0\.0\.1)/.test(url)) return false;
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
  ssl: useSsl(config.databaseUrl),
});

export const db = drizzle(pool);

/** Creates tables if they don't exist yet. Safe to run on every boot. */
export async function ensureSchema(): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      url TEXT NOT NULL,
      title TEXT,
      target_price NUMERIC,
      target_currency TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS price_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id UUID NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
      price NUMERIC,
      currency TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      note TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_item
      ON price_history (item_id, checked_at DESC);
    CREATE TABLE IF NOT EXISTS manual_products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      target_price NUMERIC,
      target_currency TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS manual_prices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id UUID NOT NULL REFERENCES manual_products(id) ON DELETE CASCADE,
      store TEXT NOT NULL,
      price NUMERIC NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      url TEXT,
      notes TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_manual_prices_product
      ON manual_prices (product_id, recorded_at DESC);
  `);
}
