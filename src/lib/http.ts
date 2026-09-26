// Server-side page fetching with realistic browser headers, timeouts,
// an SSRF guard, and explicit blocked/ambiguous detection.
// Nothing here ever invents a price — failures surface as typed errors.
import dns from "node:dns/promises";
import net from "node:net";
import { BlockedError, FetchError, NotFoundError } from "./errors.js";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB cap per page

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  Referer: "https://www.google.com/",
};

// Snippets that indicate a bot-wall / captcha page rather than a product.
const BOT_WALL_MARKERS =
  /captcha|are you (a )?robot|automated access|unusual traffic|verify you('| a)re (a )?human|access denied|request blocked/i;

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

function isPrivateV6(ip: string): boolean {
  const low = ip.toLowerCase();
  return low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
}

/** Reject URLs that point at private infrastructure (SSRF protection). */
async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("The URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError("Only http(s) URLs are allowed.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new FetchError("That host is not allowed.");
  }
  if (net.isIP(host)) {
    const v = net.isIPv4(host) ? isPrivateV4(host) : isPrivateV6(host);
    if (v) throw new FetchError("That host is not allowed.");
    return url;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new FetchError("Could not resolve that hostname.");
  }
  for (const a of addrs) {
    const private_ = a.family === 4 ? isPrivateV4(a.address) : isPrivateV6(a.address);
    if (private_) throw new FetchError("That host is not allowed.");
  }
  return url;
}

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
}

function looksLikeBotWall(status: number, htmlHead: string, title: string): boolean {
  if (status === 403 || status === 429) return true;
  return BOT_WALL_MARKERS.test(title) || BOT_WALL_MARKERS.test(htmlHead);
}

export async function fetchPage(rawUrl: string, timeoutMs = TIMEOUT_MS): Promise<FetchedPage> {
  const url = await assertPublicUrl(rawUrl);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new FetchError("The retailer page timed out.");
    }
    throw new FetchError("Could not reach the retailer page.");
  }

  if (res.status === 404 || res.status === 410) {
    throw new NotFoundError("The retailer page was not found (404).");
  }

  const buf = await res.arrayBuffer().catch(() => {
    throw new FetchError("Failed while reading the retailer page.");
  });
  if (buf.byteLength > MAX_BYTES) throw new FetchError("The retailer page is too large to process.");
  const html = Buffer.from(buf).toString("utf8");

  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").slice(0, 300);
  if (res.status >= 400 || looksLikeBotWall(res.status, html.slice(0, 20_000), title)) {
    throw new BlockedError(
      `The retailer refused the request (HTTP ${res.status}). No price was read; try again later.`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/i.test(contentType) && html.length < 500) {
    throw new FetchError("The retailer did not return a readable product page.");
  }

  return { html, finalUrl: res.url || url.toString(), status: res.status };
}
