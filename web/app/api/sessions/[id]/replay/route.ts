import { NextResponse } from "next/server";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalReplayManifest,
} from "@/lib/ingest-api";

/**
 * Server-side proxy for the replay player (Wave-24, Wave-22 token pattern).
 *
 * Two responsibilities the browser must NOT do directly:
 *   1. Holds the privileged ingest token (RT_PORTAL_API_TOKEN) when calling
 *      A2's read-side (`GET /api/v1/portal/sessions/:id/replay`), so the token
 *      never reaches the browser.
 *   2. Downloads the signed chunk URLs server-side. Those URLs are signed
 *      against the internal object-storage endpoint (e.g. http://minio:9000),
 *      which is unreachable — and the signature is host-bound — from the
 *      browser. We fetch the masked rrweb chunk bytes here, parse + stitch them
 *      in sequence order, and return the combined event array to the player.
 *
 * The manifest is fetched fresh on every call, so signed-URL TTL expiry never
 * bites within a single request; the client simply re-requests this route to
 * refresh.
 *
 *   200 + { sessionId, chunkCount, events }  — admin; stitched rrweb events
 *   403                                       — viewer (token lacks audit:read)
 *   404                                       — unknown session
 *   204 (empty)                               — session has no replay chunks
 *   502                                       — could not reach ingest / storage
 *
 * Privacy: the bytes streamed here are the SDK's masked rrweb events. We only
 * re-serialize them; we never reconstruct or unmask anything.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const client = createIngestApiClient();

  let manifestResult;
  try {
    manifestResult = await client.getReplayManifest(id);
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  if (manifestResult.status === "forbidden") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (manifestResult.status === "notFound") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (manifestResult.status !== "ok") {
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  const manifest: PortalReplayManifest = manifestResult.data;
  if (manifest.chunkCount === 0 || manifest.chunks.length === 0) {
    // No replay for this session — distinct from "session not found".
    return new NextResponse(null, { status: 204 });
  }

  // Download every chunk's bytes server-side, then stitch the rrweb event
  // in strict sequence order. The SDK writes each chunk body as an envelope
  // { sessionId, sequence, events: [...] } (content-type
  // application/vnd.resolvetrace.replay+rrweb); we also accept a bare array for
  // robustness.
  const ordered = [...manifest.chunks].sort((a, b) => a.sequence - b.sequence);
  const events: unknown[] = [];
  try {
    for (const chunk of ordered) {
      const res = await fetch(chunk.url, { cache: "no-store" });
      if (!res.ok) {
        return NextResponse.json(
          { error: "chunk_fetch", sequence: chunk.sequence },
          { status: 502 }
        );
      }
      const parsed: unknown = await res.json();
      const chunkEvents = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { events?: unknown }).events)
          ? (parsed as { events: unknown[] }).events
          : null;
      if (!chunkEvents) {
        return NextResponse.json(
          { error: "chunk_parse", sequence: chunk.sequence },
          { status: 502 }
        );
      }
      for (const ev of chunkEvents) events.push(ev);
    }
  } catch {
    return NextResponse.json({ error: "chunk_fetch" }, { status: 502 });
  }

  return NextResponse.json({
    sessionId: manifest.sessionId,
    chunkCount: manifest.chunkCount,
    events,
  });
}
