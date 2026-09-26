import { Hono } from "hono";

export function healthRoute() {
  const r = new Hono();
  // Public (no API key): used by hosts like Render for health checks.
  r.get("/", (c) =>
    c.json({ ok: true, service: "pricehawk-api", time: new Date().toISOString() }),
  );
  return r;
}
