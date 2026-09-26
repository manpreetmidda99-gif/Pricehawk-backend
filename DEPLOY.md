# Deploying the PriceHawk API (about 10 minutes)

This guide takes the backend code and puts it on the internet using
**Render's free tier**. No command-line wizardry required — just a browser
and a GitHub account. Nothing here asks for passwords beyond the accounts
you create yourself.

## What you'll end up with

- A public API address like `https://pricehawk-api.onrender.com`
- A secret API key (a long random password) that protects it
- A free Postgres database where watchlists are stored

> Heads-up: on Render's free tier the API "sleeps" after ~15 minutes of no
> traffic and wakes up on the next request (that first wake-up takes ~30–60
> seconds). That's fine for getting started.

## Step 1 — Put the code on GitHub (3 min)

1. Go to [github.com](https://github.com) and sign in (create a free account
   if you don't have one).
2. Click **New repository**, name it `pricehawk-backend`, leave it Public,
   and click **Create repository**.
3. On your computer, open the `pricehawk-backend` folder in a terminal and run:
   ```bash
   git init
   git add .
   git commit -m "PriceHawk backend"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/pricehawk-backend.git
   git push -u origin main
   ```
   (Replace `YOUR-USERNAME` with your GitHub username. GitHub will ask you
   to sign in — that's normal.)

## Step 2 — Create the Render Blueprint (4 min)

1. Go to [render.com](https://render.com) and sign up / sign in (the free
   plan is fine).
2. Click **New → Blueprint**, then **Connect** your GitHub account and pick
   the `pricehawk-backend` repository.
3. Render reads `render.yaml` and shows you two things it will create:
   a **Web Service** (`pricehawk-api`) and a **Postgres database**
   (`pricehawk-db`). Click **Apply**.
4. Before it finishes, find the `CORS_ORIGINS` setting and change it to your
   real website address, e.g. `https://www.pricehawk.example.com`. (This is
   the list of sites allowed to call the API from a browser.)

## Step 3 — Copy your API key (1 min)

1. When the deploy finishes, open the `pricehawk-api` service in Render.
2. Go to **Environment**, find `API_KEY`, click the eye icon, and **copy**
   the value. This is the secret password for the *private* endpoints
   (price checks and watchlists) — it's used server-to-server, e.g. by the
   Play Store app's backend, and must never be pasted into public website
   code.
3. The website's search tab doesn't need this key: `POST /api/search` and
   `POST /api/compare` are public on purpose (browsers can't hold secrets)
   and are protected by strict rate limits instead.

## Step 4 — Test it (2 min)

1. In your browser, open `https://pricehawk-api.onrender.com/health`
   (use your actual Render address). You should see:
   ```json
   {"ok":true,"service":"pricehawk-api","time":"..."}
   ```
2. Try a public search (no key needed):
   ```bash
   curl -X POST https://pricehawk-api.onrender.com/api/search \
     -H "Content-Type: application/json" \
     -d '{"query":"sony wh-1000xm5"}'
   ```
   You should get back a JSON list of `offers` (possibly empty if stores
   block the request — that's the API being honest, not broken).
3. That's it — the API is live. Give the address to whoever wires up the
   PriceHawk website's search tab; hand the address **plus the API key**
   to whoever builds the Play Store app (it needs the key for watchlists).

## If something goes wrong

- **Build failed?** Open the service → **Logs** and look at the red lines;
  the most common cause is a missing `API_KEY` or `DATABASE_URL`.
- **API returns 401 "unauthorized"?** The request is missing the `x-api-key`
  header, or the key doesn't match the one in Render's Environment tab.
  (Note: this only applies to the keyed routes — `/api/price` and
  `/api/watchlist*`. Search and compare are public and never 401.)
- **Browser calls blocked?** The site's address isn't in `CORS_ORIGINS` —
  add it (comma-separated if there are several) and redeploy.
- **Database errors on first boot?** Make sure the `pricehawk-db` database
  finished creating before the web service's first deploy; Render usually
  orders this correctly via the Blueprint.

## Next steps

- Point the PriceHawk website's search tab at this API (through a tiny
  server-side proxy so the key stays secret).
- When you're ready for the Play Store app, it will call these same
  endpoints with the same key.
