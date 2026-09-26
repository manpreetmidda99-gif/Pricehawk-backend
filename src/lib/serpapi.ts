// SerpAPI Google Shopping integration (BYOK — user provides their own API key).
// https://serpapi.com/shopping-search
// Free tier: 250 searches/month per account, no credit card required.

export interface SerpApiOffer {
  retailer: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  thumbnail?: string;
  rating?: number;
}

export async function searchSerpApiShopping(
  query: string,
  apiKey: string,
): Promise<{ offers: SerpApiOffer[]; error?: string }> {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    api_key: apiKey,
    num: "20",
  });

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { offers: [], error: "Invalid SerpAPI key. Check your key in Settings." };
      }
      if (res.status === 429) {
        return { offers: [], error: "SerpAPI quota exceeded (250 free searches/month). Try again next month or upgrade." };
      }
      return { offers: [], error: `SerpAPI error: ${res.status}` };
    }

    const data = await res.json();

    if (data.error) {
      return { offers: [], error: `SerpAPI: ${data.error}` };
    }

    const results = data.shopping_results || [];
    const offers: SerpApiOffer[] = [];

    for (const item of results) {
      // Extract price - SerpAPI returns like "$299.99" or { value, currency }
      let price = 0;
      let currency = "USD";

      if (typeof item.price === "string") {
        const match = item.price.match(/[\d,]+\.?\d*/);
        if (match) price = parseFloat(match[0].replace(/,/g, ""));
        if (item.price.includes("€")) currency = "EUR";
        else if (item.price.includes("£")) currency = "GBP";
        else if (item.price.includes("₹")) currency = "INR";
        else if (item.price.includes("C$")) currency = "CAD";
      } else if (item.extracted_price) {
        price = item.extracted_price;
      }

      if (price <= 0) continue;

      offers.push({
        retailer: item.source || "Unknown",
        title: item.title || query,
        price,
        currency,
        url: item.link || item.product_link || "",
        thumbnail: item.thumbnail,
        rating: item.rating,
      });
    }

    return { offers };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { offers: [], error: `Search failed: ${msg}` };
  }
}
