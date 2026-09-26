# PriceHawk API

The public backend for **PriceHawk**, the price-drop alerter. It powers live
product search on the PriceHawk website and will power the Play Store app later.

What it does:

- **Live product search** — `POST /api/search` finds a product across
  retailers and returns verified prices (never guessed).
- **Single-URL price check** — `POST /api/price` reads the real price from a
  retailer product page.
- **Cross-retailer comparison** — `POST /api/compare` lists every store's
  price and crowns the cheapest *only* when the comparison is honest:
  mixed-currency sets are converted with timestamped FX rates, or the
  ranking is explicitly declined with a reason.
- **Watchlists** — track products with target prices and a full price history.
- **Honest failure states** — when a retailer blocks the request or the price
  is ambiguous, the API says `blocked` / `ambiguous` instead of inventing
  a number.

## Stack

Node.js 20 + TypeScript, [Hono](https://hono.dev), Drizzle ORM, Postgres.
Price extraction reads structured data only (schema.org JSON-LD, Open Graph
product tags) from server-side fetches with realistic browser headers.

## Project structure

```
src/
  index.ts            # app bootstrap: middleware, routes, error handler
  config.ts           # env parsing (fails fast on missing required vars)
  db/
    schema.ts         # Drizzle tables: watchlist_items, price_history
    client.ts         # pg pool + idempotent schema creation at boot
  lib/
    http.ts           # retailer page fetching: SSRF guard, timeouts,
                      #   bot-wall detection, typed errors
    extract.ts        # honest price extraction (JSON-LD / Open Graph only)
    retailers.ts      # hostname -> friendly store name
    search.ts         # candidate discovery + verified offer extraction
    fx.ts             # currency conversion with timestamped rate source
    cache.ts          # in-memory TTL cache
    errors.ts         # typed HTTP errors
  middleware/
    auth.ts           # shared-secret API key (x-api-key header)
    rateLimit.ts      # per-IP rate limiting
  routes/
    health.ts         # GET /health (public, for host health checks)
    search.ts         # POST /api/search
    price.ts          # POST /api/price
    compare.ts        # POST /api/compare
    watchlist.ts      # watchlist CRUD + refresh
Dockerfile            # multi-stage production image
render.yaml           # one-click Render deploy (API + Postgres)
docker-compose.yml    # local Postgres for development
API.md                # full endpoint reference with examples
DEPLOY.md             # non-technical deploy walkthrough (~10 minutes)
```

## Run locally

```bash
npm install
docker compose up -d        # local Postgres
cp .env.example .env        # then set API_KEY and DATABASE_URL
npm run dev                 # http://localhost:3000
```

Health check (no key needed):

```bash
curl http://localhost:3000/health
```

Authenticated example:

```bash
curl -X POST http://localhost:3000/api/price \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"url":"https://www.example.com/product/123"}'
```

## Environment variables

See `.env.example` — every variable is documented there. The required ones
are `API_KEY` and `DATABASE_URL`; `CORS_ORIGINS` should list your site's
origin(s) so browsers can call the API.

## Design notes

- **No fake prices, ever.** Extraction only trusts structured data on the
  page. Blocked retailers return `{"error":{"code":"blocked",...}}`.
- **Currency honesty.** Every offer carries its currency. Mixed-currency
  comparisons convert to USD with timestamped rates (source + timestamp
  returned), or decline to rank and explain why.
- **Be nice to retailers.** Short-lived price cache + per-IP rate limits keep
  request volume sane. The in-memory limiter/cache suit a single instance;
  swap in Redis if you scale horizontally.
- **Browser callers:** `/api/search` and `/api/compare` are public on
  purpose — the PriceHawk website calls them straight from the browser,
  protected by strict rate limits + caching. The API key stays server-side
  and is only needed for `/api/price` and the watchlist routes
  (e.g. the Play Store app's backend). The CORS allowlist is a second
  layer, not the lock.

## Other hosts

**Railway:** New Project → deploy this repo → add the PostgreSQL plugin →
set `API_KEY`, `CORS_ORIGINS`, and `DATABASE_URL=${{Postgres.DATABASE_URL}}`
→ deploy. `npm start` is the start command.

**Fly.io:** `fly launch --no-deploy` → `fly pg create` → attach it
(`fly pg attach`) → `fly secrets set API_KEY=... CORS_ORIGINS=...` →
`fly deploy`. The Dockerfile is used automatically.
