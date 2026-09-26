# PriceHawk API reference

Base URL: `https://pricehawk-api.onrender.com` (your Render address after deploy)

**Authentication:** two tiers.

- **Public (no key):** `POST /api/search` and `POST /api/compare`. The
  PriceHawk website calls these directly from browsers, and browsers can't
  hold a secret — so these rely on strict per-IP rate limits (20 req/60s)
  plus result caching instead of a key.
- **Keyed:** everything else (`POST /api/price`, all `/api/watchlist*`
  routes). Send the shared secret as the `x-api-key` header
  (or `Authorization: Bearer <key>`).

```bash
KEY="your-api-key-here"
```

> Abuse tradeoff, stated plainly: the public endpoints are protected by
> rate limiting and caching, not by a secret. That's enough to stop casual
> abuse and keep retailer traffic sane, but a determined abuser can still
> burn quota. If abuse becomes a problem, put a CAPTCHA or a lightweight
> key/proxy in front of them — the middleware allowlist in
> `src/middleware/auth.ts` is the one place to change.

All error responses share one envelope:

```json
{ "error": { "code": "blocked", "message": "The retailer blocked this request." } }
```

Common error codes: `bad_request` (400), `unauthorized` (401),
`not_found` (404), `ambiguous` (422), `rate_limited` (429),
`blocked` / `fetch_error` (502), `fx_unavailable` (503).

---

## GET /health

No auth needed. For host health checks and "is it up?" tests.

```bash
curl https://pricehawk-api.onrender.com/health
```

```json
{ "ok": true, "service": "pricehawk-api", "time": "2026-09-26T17:30:00.000Z" }
```

---

## POST /api/search — public, no key needed

Live product search. Finds the product across retailers and returns **only**
offers whose price and currency were actually read from the page. Stores that
blocked the request (or yielded nothing usable) appear in `unavailable` —
never silently dropped, never faked.

```bash
# No API key needed — this endpoint is public (rate-limited: 20 req/60s per IP).
curl -X POST https://pricehawk-api.onrender.com/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"sony wh-1000xm5 headphones"}'
```

```json
{
  "query": "sony wh-1000xm5 headphones",
  "offers": [
    {
      "store": "Best Buy",
      "title": "Sony WH-1000XM5 Wireless Noise Canceling Headphones - Black",
      "price": 299.99,
      "currency": "USD",
      "url": "https://www.bestbuy.com/site/...",
      "image": "https://.../image.jpg",
      "inStock": true
    }
  ],
  "unavailable": [
    {
      "store": "Amazon",
      "url": "https://www.amazon.com/dp/...",
      "code": "blocked",
      "message": "The retailer refused the request (HTTP 403). No price was read; try again later."
    }
  ]
}
```

---

## POST /api/price — requires API key

Verified price for one retailer URL.

```bash
curl -X POST https://pricehawk-api.onrender.com/api/price \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"url":"https://www.bestbuy.com/site/sony-wh-1000xm5/..."}'
```

Success:

```json
{
  "title": "Sony WH-1000XM5 Wireless Noise Canceling Headphones - Black",
  "price": 299.99,
  "currency": "USD",
  "store": "Best Buy",
  "url": "https://www.bestbuy.com/site/...",
  "image": "https://.../image.jpg",
  "inStock": true
}
```

Honest failures (examples):

```json
{ "error": { "code": "blocked", "message": "The retailer refused the request (HTTP 403). No price was read; try again later." } }
```

```json
{ "error": { "code": "ambiguous", "message": "A price was found but its currency could not be identified." } }
```

---

## POST /api/compare — public, no key needed

Cross-retailer comparison. Send **exactly one** of `query` or `url`.

- `query`: searches retailers for the product, compares all verified offers.
- `url`: verifies that page first, then hunts the same product at other
  retailers by its title.

Currency rules (always honest):

- Every offer carries its `currency`.
- Single-currency sets are ranked by price; `cheapest` is the lowest-priced
  offer (in-stock preferred).
- Mixed-currency sets are converted to USD with **timestamped** public FX
  rates; the `fx` block (source + timestamp) is returned and each offer keeps
  its original price/currency plus `priceUSD`.
- If FX rates are unavailable, `cheapest` is `null` and `ranking.status` is
  `"declined"` with a plain-language reason. The API never silently crowns a
  winner across currencies.

```bash
# No API key needed — this endpoint is public (rate-limited: 20 req/60s per IP).
curl -X POST https://pricehawk-api.onrender.com/api/compare \
  -H "Content-Type: application/json" \
  -d '{"query":"lego technic porsche 911"}'
```

```json
{
  "query": "lego technic porsche 911",
  "offers": [
    { "store": "Walmart", "title": "...", "price": 129.0, "currency": "USD", "url": "https://..." },
    {
      "store": "Amazon",
      "title": "...",
      "price": 179.99,
      "currency": "CAD",
      "url": "https://...",
      "priceUSD": 131.42
    }
  ],
  "cheapest": { "store": "Walmart", "title": "...", "price": 129.0, "currency": "USD", "url": "https://...", "priceUSD": 129.0 },
  "unavailable": [],
  "fx": {
    "convertedTo": "USD",
    "source": "open.er-api.com",
    "ratesAt": "2026-09-26T17:00:00.000Z"
  },
  "note": "Offers span multiple currencies, so prices were converted to USD for ranking using open.er-api.com rates from 2026-09-26T17:00:00.000Z. Original prices and currencies are preserved on each offer."
}
```

Declined-ranking example (FX down):

```json
{
  "query": "lego technic porsche 911",
  "offers": [ { "store": "Walmart", "price": 129.0, "currency": "USD", "...": "..." } ],
  "cheapest": null,
  "unavailable": [],
  "ranking": {
    "status": "declined",
    "reason": "Offers span multiple currencies (USD, CAD) and live FX rates are currently unavailable, so no cross-currency ranking was performed. Compare the per-offer prices and currencies manually."
  }
}
```

---

## Watchlist — requires API key

Track products with target prices. Every check appends a history entry with
an honest `status`: `ok`, `blocked`, `ambiguous`, or `error`.

### GET /api/watchlist

```bash
curl https://pricehawk-api.onrender.com/api/watchlist -H "x-api-key: $KEY"
```

```json
{
  "items": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "url": "https://www.bestbuy.com/site/...",
      "title": "Sony WH-1000XM5 ...",
      "targetPrice": 250,
      "targetCurrency": "USD",
      "createdAt": "2026-09-26T17:10:00.000Z",
      "latest": { "price": 299.99, "currency": "USD", "status": "ok", "note": null, "checkedAt": "..." }
    }
  ]
}
```

### POST /api/watchlist

```bash
curl -X POST https://pricehawk-api.onrender.com/api/watchlist \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"url":"https://www.bestbuy.com/site/...","targetPrice":250,"targetCurrency":"USD"}'
```

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "url": "https://www.bestbuy.com/site/...",
  "targetPrice": 250,
  "targetCurrency": "USD",
  "createdAt": "2026-09-26T17:10:00.000Z",
  "initialCheck": { "status": "ok", "price": 299.99, "currency": "USD", "note": null }
}
```

If the retailer blocks the first check, the item is still created and
`initialCheck.status` is `"blocked"` (with the reason in `note`) — the API
tells you instead of guessing.

### DELETE /api/watchlist/:id

```bash
curl -X DELETE https://pricehawk-api.onrender.com/api/watchlist/3fa85f64-5717-4562-b3fc-2c963f66afa6 \
  -H "x-api-key: $KEY"
```

```json
{ "ok": true, "deleted": "3fa85f64-5717-4562-b3fc-2c963f66afa6" }
```

### POST /api/watchlist/:id/refresh

Re-checks the price right now and appends a history entry.

```bash
curl -X POST https://pricehawk-api.onrender.com/api/watchlist/3fa85f64-5717-4562-b3fc-2c963f66afa6/refresh \
  -H "x-api-key: $KEY"
```

```json
{ "price": 279.99, "currency": "USD", "status": "ok", "note": null, "checkedAt": "2026-09-26T18:05:00.000Z" }
```

---

## Rate limits

- Global: 100 requests / 60s per IP (configurable via `RATE_LIMIT_*`).
- `/api/search` and `/api/compare`: 20 requests / 60s per IP
  (configurable via `SEARCH_RATE_LIMIT_MAX`).
- Responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`; a 429
  includes `Retry-After`.
- Successful price lookups are cached ~15 minutes (`CACHE_TTL_SECONDS`),
  searches ~5 minutes (`SEARCH_CACHE_TTL_SECONDS`).
