import { NextResponse } from "next/server";
import { INGEST_BASE } from "@/lib/portal-login";

/**
 * Login capability probe — proxies the backend portal-auth config so the login
 * page knows whether to show a password form or an SSO redirect button. Falls
 * back to password mode if the backend can't be reached.
 */
export async function GET() {
  try {
    const res = await fetch(`${INGEST_BASE}/api/v1/portal/auth/config`, {
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
  } catch {
    /* fall through */
  }
  return NextResponse.json({ mode: "password", providerLabel: "Sign in" });
}
