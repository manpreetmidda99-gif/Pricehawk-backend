// Product search: query public search-engine result pages for candidate
// product URLs, then fetch each page and extract a *verified* price.
// Offers only appear when a real price + currency was read from the page.
// Stores that block us (or yield nothing usable) are reported in
// `unavailable` — never silently dropped, never faked.
import * as cheerio from "cheerio";
import { TtlCache } from "./cache.js";
import { HttpError } from "./errors.js";
import { extractOfferOrThrow } from "./extract.js";
import { fetchPage } from "./http.js";
import { identifyStore } from "./retailers.js";

export interface Offer {
  store: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  image?: string;
  inStock?: boolean;
}

export interface Unavailable {
  store: string;
  url: string;
  code: string;
  message: string;
}

export interface SearchResult {
  offers: Offer[];
  unavailable: Unavailable[];
}

// Hosts that are never product pages — filtered out of candidates.
const JUNK_HOSTS =
  /duckduckgo\.com|bing\.com|google\.|youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|pinterest\.|reddit\.com|wikipedia\.org|x\.com|linkedin\.com/i;

const MAX_CANDIDATES = 10;
const MAX_FETCHES = 8;
const CONCURRENCY = 4;

function cleanCandidates(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (JUNK_HOSTS.test(u.hostname)) continue;
    const key = u.hostname + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.toString());
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

async function duckduckgoSearch(query: string): Promise<string[]> {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const { html } = await fetchPage(url, 12_000);
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $("a.result__a").each((_i, el) => {
    let href = $(el).attr("href") ?? "";
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) {
      try {
        href = decodeURIComponent(m[1]);
      } catch {
        /* keep raw href */
      }
    }
    if (/^https?:\/\//i.test(href)) urls.push(href);
  });
  return urls;
}

async function bingSearch(query: string): Promise<string[]> {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
  const { html } = await fetchPage(url, 12_000);
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $("li.b_algo h2 a").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (/^https?:\/\//i.test(href)) urls.push(href);
  });
  return urls;
}

/** Verified single-URL price lookup with caching. Throws typed HttpErrors. */
export async function getPriceForUrl(rawUrl: string, cache: TtlCache<Offer>): Promise<Offer> {
  const cacheKey = `price:${rawUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const page = await fetchPage(rawUrl);
  const extracted = extractOfferOrThrow(page.html);
  const offer: Offer = {
    store: identifyStore(page.finalUrl),
    title: extracted.title,
    price: extracted.price,
    currency: extracted.currency,
    url: page.finalUrl,
    ...(extracted.image ? { image: extracted.image } : {}),
    ...(extracted.inStock !== undefined ? { inStock: extracted.inStock } : {}),
  };
  cache.set(cacheKey, offer);
  return offer;
}

async function offerFromCandidate(url: string, cache: TtlCache<Offer>): Promise<Offer> {
  return getPriceForUrl(url, cache);
}

/** Simple concurrency pool. */
async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

export async function searchOffers(query: string, cache: TtlCache<Offer>): Promise<SearchResult> {
  let candidates = await duckduckgoSearch(query).catch(() => [] as string[]);
  if (candidates.length < 3) {
    const bing = await bingSearch(query).catch(() => [] as string[]);
    candidates = [...candidates, ...bing];
  }
  const urls = cleanCandidates(candidates).slice(0, MAX_FETCHES);

  const offers: Offer[] = [];
  const unavailable: Unavailable[] = [];

  await mapPool(urls, CONCURRENCY, async (url) => {
    try {
      offers.push(await offerFromCandidate(url, cache));
    } catch (err) {
      const code = err instanceof HttpError ? err.code : "fetch_error";
      const message = err instanceof Error ? err.message : "Unknown error.";
      unavailable.push({ store: identifyStore(url), url, code, message });
    }
  });

  // Cheapest-first ordering is only meaningful per currency; the compare
  // endpoint handles cross-currency ranking. Here we keep discovery order
  // but sort same-currency groups by price for readability.
  offers.sort((a, b) => (a.currency === b.currency ? a.price - b.price : 0));
  return { offers, unavailable };
}
