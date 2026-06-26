import { NextResponse } from "next/server";
import { createIngestApiClient, IngestApiError } from "@/lib/ingest-api";

/**
 * Server-side proxy for the admin "Send test" webhook action (Wave-25). Holds
 * the privileged ingest token server-side. The ingest API signs + POSTs a
 * sample payload to the configured URL and returns the delivery result; the
 * secret is never returned. Each test is audited as a `webhook.dispatch` row by
 * the ingest server.
 *
 *   200 + { result:{status,attempts,httpStatus,error} }  — delivered OR failed
 *   403                                                   — viewer
 *   400 + { message }                                     — webhook unconfigured
 *   502                                                   — could not reach the ingest API
 */
export async function POST() {
  const client = createIngestApiClient();
  try {
    const result = await client.testWebhook();
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
    return NextResponse.json({ result: result.data });
  } catch (err) {
    if (err instanceof IngestApiError) {
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
