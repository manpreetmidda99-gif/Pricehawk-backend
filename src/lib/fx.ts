// Currency conversion with a timestamped public rate source.
// Used ONLY to rank mixed-currency comparison sets transparently.
// If rates can't be fetched, callers must decline the ranking —
// the API never silently crowns a "cheapest" across currencies.
import { config } from "../config.js";
import { FxUnavailableError } from "./errors.js";

export interface FxRates {
  base: string;
  rates: Record<string, number>; // units of currency per 1 base unit
  fetchedAt: string; // ISO timestamp of when rates were pulled
  source: string;
  stale?: boolean;
}

let cached: FxRates | null = null;
const FX_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily

/** Fetch (or reuse cached) FX rates. Throws FxUnavailableError when none exist. */
export async function getFxRates(): Promise<FxRates> {
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < FX_TTL_MS) return cached;
  try {
    const res = await fetch(config.fxApiUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`FX provider HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: string;
      base_code?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
    };
    if (json.result !== "success" || !json.rates || !json.base_code) {
      throw new Error("Unexpected FX provider response shape.");
    }
    cached = {
      base: json.base_code,
      rates: json.rates,
      fetchedAt: new Date().toISOString(),
      source: "open.er-api.com",
    };
    return cached;
  } catch (err) {
    // Serve stale rates (flagged) rather than failing outright when we have them.
    if (cached) return { ...cached, stale: true };
    throw new FxUnavailableError();
  }
}

/** Convert an amount between ISO currencies via the base currency. */
export function convert(amount: number, from: string, to: string, fx: FxRates): number {
  const fromRate = fx.rates[from];
  const toRate = fx.rates[to];
  if (!fromRate || !toRate || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
    throw new FxUnavailableError();
  }
  const inBase = amount / fromRate;
  return inBase * toRate;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
