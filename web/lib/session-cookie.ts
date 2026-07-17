/**
 * Portal session — Next request-context helpers (server components + route
 * handlers). The pure crypto lives in `session.ts`; middleware reads the cookie
 * off `NextRequest` directly rather than via `next/headers`.
 */

import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  openSession,
  sealSession,
  type PortalSession,
} from "./session";

/** Read + verify the current session, or `null` when unauthenticated. */
export async function getSession(): Promise<PortalSession | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  return openSession(value);
}

/** Persist a session as the encrypted, httpOnly cookie. */
export async function setSessionCookie(session: PortalSession): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, await sealSession(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Clear the session cookie (sign-out). */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
