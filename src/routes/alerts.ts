// Price alerts — per-user scheduled price watches.
// All routes require a logged-in session (requireAuth).
//   GET    /api/alerts       — list the user's alerts
//   POST   /api/alerts       — { query, targetPrice, targetCurrency? } (max 20 active per user)
//   PATCH  /api/alerts/:id   — { active: boolean } pause / resume
//   DELETE /api/alerts/:id   — remove an alert (owner only)
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { priceAlerts } from "../db/schema.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { requireAuth, AuthEnv } from "../middleware/sessionAuth.js";

const MAX_ACTIVE_ALERTS = 20;
const num = (v: string | null): number | null => (v === null ? null : Number(v));
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface AlertBody {
  query?: unknown;
  targetPrice?: unknown;
  targetCurrency?: unknown;
}

function validateAlertBody(body: AlertBody) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) throw new BadRequestError('Provide "query" as a non-empty string.');
  if (query.length > 200) throw new BadRequestError('"query" is too long (max 200).');

  const targetPrice = Number(body.targetPrice);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    throw new BadRequestError('"targetPrice" must be a positive number.');
  }

  let targetCurrency = "USD";
  if (body.targetCurrency !== undefined) {
    if (typeof body.targetCurrency !== "string" || !/^[A-Za-z]{3}$/.test(body.targetCurrency.trim())) {
      throw new BadRequestError('"targetCurrency" must be a 3-letter code like "USD".');
    }
    targetCurrency = body.targetCurrency.trim().toUpperCase();
  }

  return { query, targetPrice, targetCurrency };
}

function toJson(a: typeof priceAlerts.$inferSelect) {
  return {
    id: a.id,
    query: a.query,
    targetPrice: num(a.targetPrice),
    targetCurrency: a.targetCurrency,
    lastPrice: num(a.lastPrice),
    lastCurrency: a.lastCurrency,
    lastCheckedAt: iso(a.lastCheckedAt),
    active: a.active,
    createdAt: iso(a.createdAt),
  };
}

export function alertsRoute() {
  const r = new Hono<AuthEnv>();

  // All alert endpoints need a logged-in user.
  r.use(requireAuth());

  // List the user's alerts, newest first.
  r.get("/", async (c) => {
    const user = c.get("user");
    const rows = await db
      .select()
      .from(priceAlerts)
      .where(eq(priceAlerts.userId, user.id))
      .orderBy(desc(priceAlerts.createdAt));
    return c.json({ alerts: rows.map(toJson) });
  });

  // Create an alert (free tier: max 20 active per user).
  r.post("/", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as AlertBody;
    const v = validateAlertBody(body);

    const existing = await db
      .select({ id: priceAlerts.id })
      .from(priceAlerts)
      .where(and(eq(priceAlerts.userId, user.id), eq(priceAlerts.active, true)));
    if (existing.length >= MAX_ACTIVE_ALERTS) {
      throw new BadRequestError(
        `Free tier allows up to ${MAX_ACTIVE_ALERTS} active alerts. Pause or delete one first.`,
      );
    }

    const [created] = await db
      .insert(priceAlerts)
      .values({
        userId: user.id,
        query: v.query,
        targetPrice: String(v.targetPrice),
        targetCurrency: v.targetCurrency,
      })
      .returning();

    return c.json({ alert: toJson(created) }, 201);
  });

  // Pause / resume an alert.
  r.patch("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { active?: unknown };
    if (typeof body.active !== "boolean") {
      throw new BadRequestError('Provide "active" as a boolean.');
    }

    if (body.active) {
      // Enforce the free-tier cap when resuming too.
      const active = await db
        .select({ id: priceAlerts.id })
        .from(priceAlerts)
        .where(and(eq(priceAlerts.userId, user.id), eq(priceAlerts.active, true)));
      const isSelfActive = active.some((a) => a.id === id);
      if (!isSelfActive && active.length >= MAX_ACTIVE_ALERTS) {
        throw new BadRequestError(
          `Free tier allows up to ${MAX_ACTIVE_ALERTS} active alerts. Pause or delete one first.`,
        );
      }
    }

    const [updated] = await db
      .update(priceAlerts)
      .set({ active: body.active })
      .where(and(eq(priceAlerts.id, id), eq(priceAlerts.userId, user.id)))
      .returning();
    if (!updated) throw new NotFoundError("Alert not found.");

    return c.json({ alert: toJson(updated) });
  });

  // Delete an alert (owner only).
  r.delete("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const deleted = await db
      .delete(priceAlerts)
      .where(and(eq(priceAlerts.id, id), eq(priceAlerts.userId, user.id)))
      .returning({ id: priceAlerts.id });
    if (deleted.length === 0) throw new NotFoundError("Alert not found.");
    return c.json({ ok: true, deleted: id });
  });

  return r;
}
