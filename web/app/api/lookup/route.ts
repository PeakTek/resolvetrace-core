import { NextResponse } from "next/server";
import { IngestApiError } from "@/lib/ingest-api";
import { portalIngestClient } from "@/lib/portal-client";

/**
 * Server-side proxy for the support-code lookup. The client-side search box
 * POSTs the raw code here; this handler holds the privileged ingest token
 * (RT_PORTAL_API_TOKEN) so it never reaches the browser. The ingest endpoint
 * normalizes and validates the code, and we relay its outcome:
 *   200 + { sessionId }  — resolved; the client routes to the detail page
 *   400                  — malformed code
 *   404                  — well-formed but unknown code
 *   502                  — could not reach the ingest API
 */
export async function POST(request: Request) {
  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code;
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  if (code.trim().length === 0) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const client = await portalIngestClient();
  try {
    const result = await client.lookupBySupportCode(code);
    if (result.status === "invalid") {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    if (result.status === "notFound") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ sessionId: result.session.sessionId });
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
