import { NextResponse } from "next/server";
import { INGEST_BASE } from "@/lib/portal-login";

/**
 * Begin the SSO redirect flow. Proxies the backend `authorize` (which starts
 * the OIDC Authorization Code + PKCE flow and stashes the state server-side) and
 * returns `{ redirectUrl }` for the browser to navigate to.
 */
export async function GET() {
  try {
    const res = await fetch(`${INGEST_BASE}/api/v1/portal/auth/authorize`, {
      cache: "no-store",
    });
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
