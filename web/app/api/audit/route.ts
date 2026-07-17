import { NextResponse } from "next/server";
import { IngestApiError } from "@/lib/ingest-api";
import { portalIngestClient } from "@/lib/portal-client";

/**
 * Server-side proxy for the admin audit log. The client-side "load more"
 * control fetches subsequent pages here so the privileged ingest token
 * (RT_PORTAL_API_TOKEN) never reaches the browser. The first page is rendered
 * server-side by the /audit page; this handler serves pagination.
 *
 *   200 + { entries, nextCursor } — admin; a page of entries
 *   403                           — viewer (token lacks audit:read)
 *   400                           — invalid limit/cursor
 *   502                           — could not reach the ingest API
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const client = await portalIngestClient();
  try {
    const result = await client.listAudit({
      limit: limit && Number.isFinite(limit) ? limit : undefined,
      cursor,
    });
    if (result.status === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.status === "invalid") {
      return NextResponse.json(
        { error: "invalid", message: result.message },
        { status: 400 }
      );
    }
    if (result.status === "notFound") {
      // Listing the audit log should never 404; treat as upstream error.
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json(result.data);
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
