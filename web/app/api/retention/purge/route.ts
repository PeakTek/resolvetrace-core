import { NextResponse } from "next/server";
import { createIngestApiClient, IngestApiError } from "@/lib/ingest-api";

/**
 * Server-side proxy for an on-demand retention purge. Holds the privileged
 * ingest token (RT_PORTAL_API_TOKEN) so it never reaches the browser. The
 * admin "Run purge now" button POSTs here.
 *
 *   200 + { purged:{events,sessions,replayObjects} }
 *   403 — viewer (token lacks audit:read)
 *   502 — could not reach the ingest API
 */
export async function POST() {
  const client = createIngestApiClient();
  try {
    const result = await client.runPurge();
    if (result.status === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.status !== "ok") {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ purged: result.data });
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
