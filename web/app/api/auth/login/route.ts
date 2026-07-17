import { NextResponse } from "next/server";
import { buildSession } from "@/lib/session";
import { setSessionCookie } from "@/lib/session-cookie";

/**
 * Portal login exchange. Verifies credentials against the ingest portal-auth
 * contract server-to-server, then seals the resulting identity + tenants +
 * scopes (+ any managed per-tenant credential) into the encrypted session
 * cookie. The privileged bearer never reaches the browser.
 */

const INGEST = (process.env.RT_INGEST_URL ?? "http://resolvetrace:4317").replace(
  /\/$/,
  ""
);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${INGEST}/api/v1/portal/auth/login`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  if (res.status === 401) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (res.status === 403) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return NextResponse.json({ error: j.error ?? "forbidden" }, { status: 403 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  const data = (await res.json()) as {
    user: { userId: string; email: string; roles: string[] };
    tenants: { id: string; displayName: string }[];
    currentTenantId: string;
    role?: string;
    scopes?: string[];
    identityToken?: string;
    ingestCredential?: { credential: string; expiresAt: number };
  };

  const session = buildSession({
    sub: data.user.userId,
    email: data.user.email,
    roles: data.user.roles ?? [],
    tenants: data.tenants ?? [],
    currentTenantId: data.currentTenantId,
    role: data.role ?? "",
    scopes: data.scopes ?? [],
    identityToken: data.identityToken,
    ingestBearer: data.ingestCredential?.credential,
    ingestBearerExp: data.ingestCredential?.expiresAt,
  });
  await setSessionCookie(session);
  return NextResponse.json({ ok: true });
}
