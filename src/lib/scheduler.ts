// Daily price-alert scheduler.
// On boot it waits 60s (so Render free-tier deploys get a check per deploy),
// then runs once every 24h. For each active alert it re-runs the SerpAPI
// product search with the operator's server-side SERPAPI_KEY, converts the
// cheapest offer into the alert's target currency, and emails the user when
// the price hits (or beats) their target for the first time / a new low.
//
// Conservative by design: alerts checked within the last 20h are skipped
// (restarts don't re-burn quota), alerts are processed sequentially with a
// short pause between searches, and everything is logged to the console.
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { priceAlerts, users } from "../db/schema.js";
import { searchSerpApiShopping, SerpApiOffer } from "./serpapi.js";
import { convert, getFxRates, FxRates, round2 } from "./fx.js";
import { sendPriceDropEmail } from "./email.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 60_000;
const RECENT_CHECK_MS = 20 * 60 * 60 * 1000;
const SEARCH_PAUSE_MS = 3_000;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Cheapest {
  price: number; // converted into target currency
  originalPrice: number;
  originalCurrency: string;
  retailer: string;
}

/** Find the cheapest offer, converted into targetCurrency via live FX rates. */
function findCheapest(offers: SerpApiOffer[], targetCurrency: string, fx: FxRates | null): Cheapest | null {
  let best: Cheapest | null = null;
  for (const o of offers) {
    const from = (o.currency || "USD").toUpperCase();
    let price: number;
    try {
      price = fx ? convert(o.price, from, targetCurrency, fx) : o.price;
    } catch {
      continue; // skip offers that can't be compared
    }
    if (from !== targetCurrency && !fx) continue; // no silent mixed-currency ranking
    if (!best || price < best.price) {
      best = { price: round2(price), originalPrice: o.price, originalCurrency: from, retailer: o.retailer };
    }
  }
  return best;
}

async function checkAlerts(): Promise<void> {
  if (!config.serpapiKey) {
    console.log("[scheduler] SERPAPI_KEY not set — skipping scheduled price checks.");
    return;
  }

  const rows = await db
    .select({
      id: priceAlerts.id,
      query: priceAlerts.query,
      targetPrice: priceAlerts.targetPrice,
      targetCurrency: priceAlerts.targetCurrency,
      lastPrice: priceAlerts.lastPrice,
      lastCheckedAt: priceAlerts.lastCheckedAt,
      lastNotifiedPrice: priceAlerts.lastNotifiedPrice,
      email: users.email,
    })
    .from(priceAlerts)
    .innerJoin(users, eq(priceAlerts.userId, users.id))
    .where(eq(priceAlerts.active, true));

  if (rows.length === 0) {
    console.log("[scheduler] no active alerts to check.");
    return;
  }

  let fx: FxRates | null = null;
  try {
    fx = await getFxRates();
  } catch (err) {
    console.log("[scheduler] FX rates unavailable — will only compare same-currency offers.");
  }

  let checked = 0;
  let notified = 0;
  for (const alert of rows) {
    if (alert.lastCheckedAt && Date.now() - alert.lastCheckedAt.getTime() < RECENT_CHECK_MS) {
      console.log(`[scheduler] skipping "${alert.query}" (checked recently)`);
      continue;
    }

    try {
      console.log(`[scheduler] checking "${alert.query}" (target ${alert.targetPrice} ${alert.targetCurrency})`);
      const result = await searchSerpApiShopping(alert.query, config.serpapiKey);
      if (result.error) {
        console.log(`[scheduler] search failed for "${alert.query}": ${result.error}`);
        continue;
      }

      const cheapest = findCheapest(result.offers, alert.targetCurrency, fx);
      if (!cheapest) {
        console.log(`[scheduler] no comparable offers for "${alert.query}"`);
        continue;
      }

      const prevLastPrice = alert.lastPrice === null ? null : Number(alert.lastPrice);
      const prevNotified = alert.lastNotifiedPrice === null ? null : Number(alert.lastNotifiedPrice);

      await db
        .update(priceAlerts)
        .set({
          lastPrice: String(cheapest.price),
          lastCurrency: alert.targetCurrency,
          lastCheckedAt: new Date(),
        })
        .where(eq(priceAlerts.id, alert.id));
      checked++;

      const target = Number(alert.targetPrice);
      const hitTarget = cheapest.price <= target;
      const isNewLow = prevNotified === null || cheapest.price < prevNotified;
      if (hitTarget && isNewLow) {
        await sendPriceDropEmail({
          to: alert.email,
          query: alert.query,
          currentPrice: cheapest.price,
          currentCurrency: alert.targetCurrency,
          previousPrice: prevLastPrice,
          targetPrice: target,
          targetCurrency: alert.targetCurrency,
          retailer: cheapest.retailer,
        });
        await db
          .update(priceAlerts)
          .set({ lastNotifiedPrice: String(cheapest.price) })
          .where(eq(priceAlerts.id, alert.id));
        notified++;
      } else {
        console.log(
          `[scheduler] "${alert.query}": cheapest ${cheapest.price} ${alert.targetCurrency} (target ${target}) — no alert`,
        );
      }
    } catch (err) {
      console.log(`[scheduler] error checking "${alert.query}":`, err instanceof Error ? err.message : err);
    }

    await sleep(SEARCH_PAUSE_MS);
  }

  console.log(`[scheduler] run complete: ${checked} checked, ${notified} notified`);
}

/** Starts the daily scheduler. Called once at boot. Never throws. */
export function startAlertScheduler(): void {
  console.log("[scheduler] alert scheduler armed (first run in 60s, then every 24h)");
  const run = () => {
    checkAlerts().catch((err) => console.log("[scheduler] run failed:", err instanceof Error ? err.message : err));
  };
  const bootTimer = setTimeout(run, BOOT_DELAY_MS);
  const dailyTimer = setInterval(run, CHECK_INTERVAL_MS);
  // The HTTP server already keeps the process alive; unref so the
  // scheduler never blocks a graceful shutdown.
  bootTimer.unref();
  dailyTimer.unref();
}
