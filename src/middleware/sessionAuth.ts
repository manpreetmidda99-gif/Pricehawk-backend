// Cookie-session auth for user-facing routes (/api/auth, /api/alerts).
// The browser holds the raw token in the httpOnly `ph_session` cookie;
// the DB stores only the SHA-256 hash. requireAuth validates the session
// and sets `c.set('user', { id, email })`, or returns 401 JSON.
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "ph_session";

export interface SessionUser {
  id: string;
  email: string;
}

/** Hono env carrying the authenticated user. Use `new Hono<AuthEnv>()` in protected routes. */
export type AuthEnv = { Variables: { user: SessionUser } };

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function requireAuth() {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) {
      return c.json({ error: { code: "unauthorized", message: "Please log in." } }, 401);
    }

    const tokenHash = hashSessionToken(token);
    const rows = await db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        email: users.email,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return c.json({ error: { code: "unauthorized", message: "Session expired. Please log in again." } }, 401);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      // Lazy cleanup of the dead session.
      await db.delete(sessions).where(eq(sessions.id, row.sessionId));
      return c.json({ error: { code: "unauthorized", message: "Session expired. Please log in again." } }, 401);
    }

    c.set("user", { id: row.userId, email: row.email } satisfies SessionUser);
    await next();
  });
}
