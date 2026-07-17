import { NextResponse } from "next/server";
import { setSessionCookie } from "@/lib/session-cookie";
import {
  INGEST_BASE,
  sessionFromLoginResult,
  type PortalLoginResult,
} from "@/lib/portal-login";

/**
 * Portal login exchange. Verifies credentials against the ingest portal-auth
 * contract server-to-server, then seals the resulting identity + tenants +
 * scopes (+ any managed per-tenant credential) into the encrypted session
 * cookie. The privileged bearer never reaches the browser.
 */

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${INGEST_BASE}/api/v1/portal/auth/login`, {
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

  const data = (await res.json()) as PortalLoginResult;
  await setSessionCookie(sessionFromLoginResult(data));
  return NextResponse.json({ ok: true });
}
