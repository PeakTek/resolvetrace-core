/**
 * Portal route gate. Every app route requires a valid portal session; missing
 * or invalid → redirect to /login (pages) or 401 (API). Runs before the page /
 * handler, so no unauthenticated request ever reaches portal data.
 *
 * The session cookie is AES-GCM encrypted (see `lib/session.ts`), verified here
 * in the Edge runtime via Web Crypto. `/login` and the auth API are exempt.
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/session";
import { publicOrigin } from "@/lib/public-origin";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow the login page + the auth exchange endpoints.
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const session = cookie ? await openSession(cookie) : null;
  // A pinned portal serves one tenant. The session secret is deliberately
  // shared across portal instances (cookies are host-scoped), so a cookie
  // minted at another tenant's portal decrypts here — reject it rather than
  // rendering this tenant's portal around a foreign session.
  // Bracket access on purpose: `process.env.X` member access is inlined at
  // build time, which would bake in `undefined` and silently fail open.
  const pinned = process.env["PORTAL_TENANT_ID"];
  const foreign = Boolean(
    session && pinned && session.currentTenantId !== pinned
  );
  if (session && !foreign) {
    return NextResponse.next();
  }

  // Unauthenticated: API routes get a 401; pages redirect to /login?next=…
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Build the redirect from the PUBLIC origin — behind a reverse proxy the
  // request's own URL can be the container's internal listen address.
  const url = new URL("/login", publicOrigin(request));
  if (foreign) {
    url.searchParams.set("error", "no_access");
  } else {
    url.searchParams.set("next", pathname);
  }
  return NextResponse.redirect(url);
}

export const config = {
  // Gate everything except Next internals + static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
