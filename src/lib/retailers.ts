// Maps a product URL to a human-friendly store name.
// Unknown hosts fall back to their registrable domain — never invented.
const STORE_PATTERNS: Array<[RegExp, string]> = [
  [/amazon\./, "Amazon"],
  [/bestbuy\.com$/, "Best Buy"],
  [/walmart\.com$/, "Walmart"],
  [/target\.com$/, "Target"],
  [/ebay\./, "eBay"],
  [/newegg\.com$/, "Newegg"],
  [/costco\.com$/, "Costco"],
  [/homedepot\.com$/, "Home Depot"],
  [/lowes\.com$/, "Lowe's"],
  [/bhphotovideo\.com$/, "B&H Photo"],
  [/adorama\.com$/, "Adorama"],
  [/etsy\.com$/, "Etsy"],
  [/wayfair\.com$/, "Wayfair"],
  [/ikea\./, "IKEA"],
  [/nike\.com$/, "Nike"],
  [/apple\.com$/, "Apple"],
  [/samsung\.com$/, "Samsung"],
  [/dell\.com$/, "Dell"],
  [/lenovo\.com$/, "Lenovo"],
  [/gamestop\.com$/, "GameStop"],
  [/kohls\.com$/, "Kohl's"],
  [/macys\.com$/, "Macy's"],
  [/nordstrom\.com$/, "Nordstrom"],
  [/zappos\.com$/, "Zappos"],
  [/aliexpress\./, "AliExpress"],
  [/shein\.com$/, "SHEIN"],
  [/temu\.com$/, "Temu"],
];

export function identifyStore(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "Unknown store";
  }
  for (const [pattern, name] of STORE_PATTERNS) {
    if (pattern.test(host)) return name;
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return host;
  // Handle multi-part public suffixes (co.uk, com.au, ...) with a small heuristic.
  const SUFFIX_PARTS = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
  if (parts.length >= 3 && SUFFIX_PARTS.has(parts[parts.length - 2])) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}
