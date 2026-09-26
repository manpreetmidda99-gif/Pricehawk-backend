// User accounts for price alerts.
//   POST /api/auth/register  — { email, password } -> { user } + session cookie (auto-login)
//   POST /api/auth/login     — { email, password } -> { user } + session cookie
//   POST /api/auth/logout    — invalidates the session, clears the cookie
//   GET  /api/auth/me        — { user } when logged in, 401 otherwise
//
// Passwords are hashed with scrypt (node:crypto, no new deps).
// Sessions: 32-byte random token, only the SHA-256 hash stored in the DB,
// raw token sent as the httpOnly `ph_session` cookie (30-day expiry).
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { BadRequestError } from "../lib/errors.js";
import { requireAuth, SESSION_COOKIE, hashSessionToken, AuthEnv } from "../middleware/sessionAuth.js";

const scrypt = promisify(scryptCb);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function validateEmail(email: unknown): string {
  if (typeof email !== "string") throw new BadRequestError('Provide "email" as a string.');
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
    throw new BadRequestError('Provide a valid "email" address.');
  }
  if (e.length > 254) throw new BadRequestError('"email" is too long.');
  return e;
}

function validatePassword(password: unknown): string {
  if (typeof password !== "string") throw new BadRequestError('Provide "password" as a string.');
  if (password.length < 8) throw new BadRequestError('"password" must be at least 8 characters.');
  if (password.length > 128) throw new BadRequestError('"password" is too long (max 128).');
  return password;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function sessionCookieOpts(): Parameters<typeof setCookie>[3] {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: config.nodeEnv === "production",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export function authRoute() {
  const r = new Hono<AuthEnv>();

  // Register a new account and log in immediately.
  r.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new BadRequestError("An account with this email already exists.");
    }

    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(password) })
      .returning({ id: users.id, email: users.email });

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.insert(sessions).values({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });
    setCookie(c, SESSION_COOKIE, token, sessionCookieOpts());

    return c.json({ user: { id: user.id, email: user.email } }, 201);
  });

  // Log in with email + password.
  r.post("/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = validateEmail(body.email);
    const password = validatePassword(body.password);

    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: { code: "invalid_credentials", message: "Invalid email or password." } }, 401);
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.insert(sessions).values({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });
    setCookie(c, SESSION_COOKIE, token, sessionCookieOpts());

    return c.json({ user: { id: user.id, email: user.email } });
  });

  // Log out: invalidate this session and clear the cookie.
  r.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Current session's user (401 when not logged in).
  r.get("/me", requireAuth(), async (c) => {
    const user = c.get("user");
    return c.json({ user: { id: user.id, email: user.email } });
  });

  return r;
}
