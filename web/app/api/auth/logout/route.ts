import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session-cookie";

/** Sign out: clear the session cookie + best-effort backend revocation. */

const INGEST = (process.env.RT_INGEST_URL ?? "http://resolvetrace:4317").replace(
  /\/$/,
  ""
);

export async function POST() {
  await clearSessionCookie();
  try {
    await fetch(`${INGEST}/api/v1/portal/auth/logout`, {
      method: "POST",
      cache: "no-store",
    });
  } catch {
    /* best-effort; the cookie is already cleared */
  }
  return NextResponse.json({ ok: true });
}
