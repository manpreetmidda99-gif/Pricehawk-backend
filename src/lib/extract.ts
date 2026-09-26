// Honest price extraction from retailer HTML.
// Only structured data counts: schema.org JSON-LD and Open Graph product
// tags. If a price can't be tied to an identifiable currency (or the page
// has no structured price at all), the result is `ambiguous` — never a guess.
import * as cheerio from "cheerio";
import { AmbiguousError } from "./errors.js";

export interface ExtractedOffer {
  title: string;
  price: number;
  currency: string;
  image?: string;
  inStock?: boolean;
}

export type ExtractResult =
  | { ok: true; offer: ExtractedOffer }
  | { ok: false; reason: string };

function parsePriceNumber(raw: unknown): number | null {
  if (typeof raw === "number") return raw > 0 && Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot > -1 && lastComma > -1) {
    // "1,299.99" or "1.299,99": the last separator is the decimal mark.
    const dec = lastDot > lastComma ? "." : ",";
    s = s
      .replace(/[.,]/g, (m) => (m === dec ? "|" : ""))
      .replace("|", ".");
  } else if (lastComma > -1) {
    s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanTitle(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return t || null;
}

function availabilityFlag(raw: unknown): boolean | undefined {
  if (typeof raw !== "string") return undefined;
  const low = raw.toLowerCase();
  if (low.includes("instock")) return true;
  if (low.includes("outofstock")) return false;
  return undefined;
}

/** Recursively find every schema.org Product node (handles @graph, arrays). */
function findProducts(node: unknown, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const n of node) findProducts(n, out);
    return out;
  }
  if (node && typeof node === "object") {
    const rec = node as Record<string, any>;
    const types = Array.isArray(rec["@type"]) ? rec["@type"] : [rec["@type"]];
    if (types.some((t) => typeof t === "string" && t.toLowerCase() === "product")) out.push(rec);
    if (rec["@graph"]) findProducts(rec["@graph"], out);
    if (rec.mainEntity) findProducts(rec.mainEntity, out);
  }
  return out;
}

function offerFromJsonLd(product: any): { price: number; currency: string; inStock?: boolean } | null {
  const rawOffers = product.offers;
  const list = Array.isArray(rawOffers) ? rawOffers : rawOffers ? [rawOffers] : [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const price = parsePriceNumber(o.price ?? o.priceSpecification?.price);
    const curRaw = o.priceCurrency ?? o.priceSpecification?.priceCurrency;
    const currency = typeof curRaw === "string" ? curRaw.toUpperCase() : "";
    if (price && /^[A-Z]{3}$/.test(currency)) {
      return { price, currency, inStock: availabilityFlag(o.availability) };
    }
  }
  return null;
}

export function extractOffer(html: string): ExtractResult {
  const $ = cheerio.load(html);
  const meta = (prop: string): string | undefined =>
    $(`meta[property="${prop}"]`).attr("content") ?? $(`meta[name="${prop}"]`).attr("content");

  const ogImage = meta("og:image") || undefined;

  // 1) schema.org JSON-LD — the most reliable structured source.
  const scripts = $('script[type="application/ld+json"]');
  let sawPriceWithoutCurrency = false;
  for (let i = 0; i < scripts.length; i++) {
    let data: unknown;
    try {
      data = JSON.parse($(scripts[i]).html() ?? "");
    } catch {
      continue; // malformed JSON-LD is common; skip it
    }
    for (const product of findProducts(data)) {
      const title = cleanTitle(
        typeof product.name === "string" ? product.name : meta("og:title"),
      );
      const offer = offerFromJsonLd(product);
      if (offer && title) return { ok: true, offer: { title, ...offer, image: ogImage } };
      if (offer && !title) {
        return { ok: false, reason: "A price was found but the product title is missing." };
      }
      // A Product node with offers but no parseable price+currency.
      if (product.offers) sawPriceWithoutCurrency = true;
    }
  }

  // 2) Open Graph product tags fallback.
  const ogPrice = parsePriceNumber(meta("product:price:amount") ?? meta("og:price:amount"));
  const ogCurrency = (meta("product:price:currency") ?? meta("og:price:currency") ?? "").toUpperCase();
  const ogTitle = cleanTitle(meta("og:title") ?? $("title").text());
  if (ogPrice && /^[A-Z]{3}$/.test(ogCurrency) && ogTitle) {
    return { ok: true, offer: { title: ogTitle, price: ogPrice, currency: ogCurrency, image: ogImage } };
  }
  if (ogPrice && !/^[A-Z]{3}$/.test(ogCurrency)) {
    return { ok: false, reason: "A price was found but its currency could not be identified." };
  }

  if (sawPriceWithoutCurrency) {
    return {
      ok: false,
      reason: "The page lists offers but no single price with an identifiable currency could be pinned down.",
    };
  }
  return {
    ok: false,
    reason: "No structured price data (schema.org JSON-LD or Open Graph product tags) was found on the page.",
  };
}

/** Throwing wrapper used by routes. */
export function extractOfferOrThrow(html: string): ExtractedOffer {
  const result = extractOffer(html);
  if (!result.ok) throw new AmbiguousError(result.reason);
  return result.offer;
}
