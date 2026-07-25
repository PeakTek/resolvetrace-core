import { NextResponse } from "next/server";
import {
  IngestApiError,
  type PortalLocalization,
} from "@/lib/ingest-api";
import { portalIngestClient } from "@/lib/portal-client";
import { getSession, setSessionCookie } from "@/lib/session-cookie";

/**
 * Server-side proxy for the tenant localization (locale + timezone) that the
 * portal formats timestamps with. Holds the privileged ingest bearer so it
 * never reaches the browser. The /settings page renders the current values
 * server-side; the admin edit form PUTs here.
 *
 *   GET 200 + settings   — admin; { localization, defaults, editable }
 *   PUT 200 + {localization,updated}
 *   403                  — viewer (token lacks the admin scope)
 *   400                  — invalid locale/timezone
 *   502                  — could not reach / not editable on the ingest API
 */
export async function GET() {
  const client = await portalIngestClient();
  try {
    const result = await client.getLocalizationSettings();
    if (result.status === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.status !== "ok") {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json(result.data);
  } catch {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}

/** Pick only the editable locale/timezone fields from an arbitrary body. */
function pickLocalization(body: unknown): Partial<PortalLocalization> {
  const out: Partial<PortalLocalization> = {};
  if (!body || typeof body !== "object") return out;
  const b = body as Record<string, unknown>;
  if (typeof b.locale === "string") out.locale = b.locale;
  if (typeof b.timezone === "string") out.timezone = b.timezone;
  return out;
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid", message: "Malformed request body." },
      { status: 400 }
    );
  }

  const patch = pickLocalization(body);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "invalid", message: "Provide at least one of locale, timezone." },
      { status: 400 }
    );
  }

  const client = await portalIngestClient();
  try {
    const result = await client.updateLocalizationSettings(patch);
    if (result.status === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.status === "invalid") {
      return NextResponse.json(
        { error: "invalid", message: result.message },
        { status: 400 }
      );
    }
    if (result.status !== "ok") {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    // Re-seal the session cookie with the current tenant's new locale/timezone
    // so the portal-wide exact-time labels (which read the cookie) update
    // immediately, without a re-login. Keeps the existing session expiry.
    const session = await getSession();
    if (session) {
      const { locale, timezone } = result.data.localization;
      await setSessionCookie({
        ...session,
        tenants: session.tenants.map((t) =>
          t.id === session.currentTenantId ? { ...t, locale, timezone } : t
        ),
      });
    }
    return NextResponse.json(result.data);
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
