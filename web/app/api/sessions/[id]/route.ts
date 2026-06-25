import { NextResponse } from "next/server";
import { createIngestApiClient, IngestApiError } from "@/lib/ingest-api";

/**
 * Server-side proxy for targeted session deletion / erasure (Law-25). Holds
 * the privileged ingest token (RT_PORTAL_API_TOKEN) so it never reaches the
 * browser. The admin "Delete session" control on the session-detail page
 * DELETEs here after confirmation.
 *
 *   200 + { deleted:{sessionId,eventsDeleted,replayObjects} }
 *   403 — viewer (token lacks audit:read)
 *   404 — unknown session
 *   502 — could not reach the ingest API
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const client = createIngestApiClient();
  try {
    const result = await client.deleteSession(id);
    if (result.status === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.status === "notFound") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (result.status !== "ok") {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ deleted: result.data });
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
