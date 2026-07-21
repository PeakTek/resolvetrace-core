import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session-cookie";
import { INGEST_BASE } from "@/lib/portal-login";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Sign out.
 *
 * Clearing our cookie ends the PORTAL session, but under redirect login that
 * is not a full sign-out: the identity provider's own session survives, so the
 * next authorize is satisfied without a credential prompt and the user is
 * signed straight back in — appearing logged out while still being logged in.
 *
 * So we also ask the backend for the provider's RP-initiated logout URL and
 * hand it to the caller, which navigates the browser there; the IdP ends its
 * session and returns the user to this portal's /login. Deployments whose
 * provider has no end-session endpoint just get the local sign-out.
 */
export async function POST(request: NextRequest) {
  await clearSessionCookie();

  let logoutUrl: string | undefined;
  try {
    const res = await fetch(`${INGEST_BASE}/api/v1/portal/auth/logout`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postLogoutRedirectUri: `${publicOrigin(request)}/login`,
      }),
    });
    if (res.ok) {
      ({ logoutUrl } = (await res.json().catch(() => ({}))) as {
        logoutUrl?: string;
      });
    }
  } catch {
    /* best-effort; the portal session cookie is already cleared */
  }

  return NextResponse.json(logoutUrl ? { ok: true, logoutUrl } : { ok: true });
}
