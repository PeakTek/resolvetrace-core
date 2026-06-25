import { NextResponse } from "next/server";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalRetentionWindows,
} from "@/lib/ingest-api";

/**
 * Server-side proxy for retention settings. Holds the privileged ingest token
 * (RT_PORTAL_API_TOKEN) so it never reaches the browser. The /settings page
 * renders the current values server-side; the admin edit form PUTs here.
 *
 *   GET 200 + settings   — admin; effective windows + purge cadence
 *   PUT 200 + {retention,updated}
 *   403                  — viewer (token lacks audit:read)
 *   400                  — invalid day-window value
 *   502                  — could not reach the ingest API
 */
export async function GET() {
  const client = createIngestApiClient();
  try {
    const result = await client.getRetentionSettings();
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

/** Pick only the three editable day-window fields from an arbitrary body. */
function pickWindows(body: unknown): Partial<PortalRetentionWindows> {
  const out: Partial<PortalRetentionWindows> = {};
  if (!body || typeof body !== "object") return out;
  const b = body as Record<string, unknown>;
  for (const key of ["eventsDays", "sessionsDays", "replayDays"] as const) {
    if (typeof b[key] === "number") out[key] = b[key] as number;
  }
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

  const windows = pickWindows(body);
  if (Object.keys(windows).length === 0) {
    return NextResponse.json(
      {
        error: "invalid",
        message: "Provide at least one of eventsDays, sessionsDays, replayDays.",
      },
      { status: 400 }
    );
  }

  const client = createIngestApiClient();
  try {
    const result = await client.updateRetentionSettings(windows);
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
