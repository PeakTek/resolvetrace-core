import { NextResponse } from "next/server";
import { buildSession } from "@/lib/session";
import { getSession, setSessionCookie } from "@/lib/session-cookie";

/**
 * Switch the active tenant. Re-scopes the session to the selected tenant via
 * the ingest portal-auth contract (which validates membership and, in managed
 * deployments, mints a fresh per-tenant credential), then re-seals the cookie.
 */

const INGEST = (process.env.RT_INGEST_URL ?? "http://resolvetrace:4317").replace(
  /\/$/,
  ""
);

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  if (!tenantId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${INGEST}/api/v1/portal/auth/tenant-select`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(session.identityToken
          ? { Authorization: `Bearer ${session.identityToken}` }
          : {}),
      },
      body: JSON.stringify({ tenantId }),
    });
  } catch {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  if (res.status === 403) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  const data = (await res.json()) as {
    currentTenantId: string;
    role?: string;
    scopes?: string[];
    ingestCredential?: { credential: string; expiresAt: number };
  };

  const next = buildSession({
    sub: session.sub,
    email: session.email,
    roles: session.roles,
    tenants: session.tenants,
    currentTenantId: data.currentTenantId,
    role: data.role ?? session.role,
    scopes: data.scopes ?? session.scopes,
    identityToken: session.identityToken,
    ingestBearer: data.ingestCredential?.credential ?? session.ingestBearer,
    ingestBearerExp: data.ingestCredential?.expiresAt ?? session.ingestBearerExp,
  });
  await setSessionCookie(next);
  return NextResponse.json({ ok: true, currentTenantId: next.currentTenantId });
}
