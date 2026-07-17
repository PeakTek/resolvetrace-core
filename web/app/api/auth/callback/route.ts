import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_MS, sealSession } from "@/lib/session";
import {
  INGEST_BASE,
  sessionFromLoginResult,
  type PortalLoginResult,
} from "@/lib/portal-login";

/**
 * SSO return leg. The IdP redirects the browser here with `?code&state`; we
 * forward them to the backend callback, seal the resulting session onto the
 * redirect response, and land the user in the portal. On any failure we bounce
 * back to /login with an error marker.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const fail = (error: string): NextResponse => {
    const login = new URL("/login", url.origin);
    login.searchParams.set("error", error);
    return NextResponse.redirect(login);
  };

  if (!code || !state) return fail("sso");

  let res: Response;
  try {
    res = await fetch(`${INGEST_BASE}/api/v1/portal/auth/callback`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    });
  } catch {
    return fail("upstream");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return fail(j.error ?? "sso");
  }

  const data = (await res.json()) as PortalLoginResult;
  const response = NextResponse.redirect(new URL("/sessions", url.origin));
  // Set the cookie on the redirect response itself (cookies() mutations don't
  // reliably merge into a hand-built redirect).
  response.cookies.set(SESSION_COOKIE, await sealSession(sessionFromLoginResult(data)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return response;
}
