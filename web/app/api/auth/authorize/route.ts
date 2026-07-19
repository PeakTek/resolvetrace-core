import { NextRequest, NextResponse } from "next/server";
import { INGEST_BASE } from "@/lib/portal-login";
import { publicOrigin } from "@/lib/public-origin";

/**
 * Begin the SSO redirect flow. Proxies the backend `authorize` (which starts
 * the OIDC Authorization Code + PKCE flow and stashes the state server-side)
 * and returns `{ redirectUrl }` for the browser to navigate to.
 *
 * Sends THIS instance's public callback (`publicOrigin + /api/auth/callback`)
 * as `redirect_uri` so multi-host deployments (several portal origins, one
 * auth backend) return the login to the host that started it. The backend
 * validates the value against its allowlist.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(`${INGEST_BASE}/api/v1/portal/auth/authorize`);
    url.searchParams.set(
      "redirect_uri",
      `${publicOrigin(request)}/api/auth/callback`
    );
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: "not_supported" }, { status: res.status });
    }
    const { redirectUrl } = (await res.json()) as { redirectUrl?: string };
    if (!redirectUrl) {
      return NextResponse.json({ error: "not_supported" }, { status: 502 });
    }
    return NextResponse.json({ redirectUrl });
  } catch {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
