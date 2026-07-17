/**
 * Server-only ingest client, scoped to the current portal session.
 *
 * Resolves the data-plane credential from the session cookie: the per-tenant
 * minted bearer when present (managed multi-tenant) or the deployment's static
 * portal token (OSS single-tenant). Kept separate from `ingest-api.ts` (which
 * stays client-import-safe) because it reads `next/headers`.
 */

import { createIngestApiClient, type IngestApiClient } from "./ingest-api";
import { getSession } from "./session-cookie";

export async function portalIngestClient(): Promise<IngestApiClient> {
  const session = await getSession();
  return createIngestApiClient(
    session?.ingestBearer ? { bearer: session.ingestBearer } : {}
  );
}
