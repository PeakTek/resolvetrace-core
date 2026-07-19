import { NextResponse } from "next/server";
import { INGEST_BASE } from "@/lib/portal-login";

/**
 * Login capability probe — proxies the backend portal-auth config so the login
 * page knows whether to show a password form or an SSO redirect button, plus
 * this instance's optional brand label (PORTAL_BRAND_NAME). Falls back to
 * password mode if the backend can't be reached.
 */
export async function GET() {
  const brand = process.env.PORTAL_BRAND_NAME;
  const withBrand = (body: Record<string, unknown>) =>
    NextResponse.json(brand ? { ...body, brand } : body);
  try {
    const res = await fetch(`${INGEST_BASE}/api/v1/portal/auth/config`, {
      cache: "no-store",
    });
    if (res.ok) {
      return withBrand((await res.json()) as Record<string, unknown>);
    }
  } catch {
    /* fall through */
  }
  return withBrand({ mode: "password", providerLabel: "Sign in" });
}
