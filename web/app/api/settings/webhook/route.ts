import { NextResponse } from "next/server";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalWebhookUpdate,
} from "@/lib/ingest-api";

/**
 * Server-side proxy for the tenant webhook settings (Wave-25). Holds the
 * privileged ingest token (RT_PORTAL_API_TOKEN) so it never reaches the browser
 * — the same pattern as the retention proxy. The webhook HMAC secret is
 * WRITE-ONLY: it is forwarded on a PUT but the ingest API never echoes it back,
 * so it cannot leak through this route either.
 *
 *   GET 200 + { webhook, defaults, editable }   — admin
 *   PUT 200 + { webhook, updated }
 *   403                                          — viewer (token lacks audit:read)
 *   400                                          — invalid body / non-https url
 *   502                                          — could not reach the ingest API
 */
export async function GET() {
  const client = createIngestApiClient();
  try {
    const result = await client.getWebhookSettings();
    if (result.status === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.status !== "ok") {
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

/** Pick only the three editable webhook fields from an arbitrary body. */
function pickWebhook(body: unknown): PortalWebhookUpdate {
  const out: PortalWebhookUpdate = {};
  if (!body || typeof body !== "object") return out;
  const b = body as Record<string, unknown>;
  if (typeof b.enabled === "boolean") out.enabled = b.enabled;
  if (typeof b.url === "string") out.url = b.url;
  if (typeof b.secret === "string") out.secret = b.secret;
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

  const update = pickWebhook(body);
  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      {
        error: "invalid",
        message: "Provide at least one of enabled, url, secret.",
      },
      { status: 400 }
    );
  }

  const client = createIngestApiClient();
  try {
    const result = await client.updateWebhookSettings(update);
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
    return NextResponse.json(result.data);
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
