/**
 * Thin server-side wrapper around the ingest server's private portal query
 * endpoints. Used exclusively by Next.js server components — do not import
 * from client code.
 */

export interface PortalSessionListItem {
  sessionId: string;
  supportCode: string | null;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  appVersion: string | null;
  releaseChannel: string | null;
}

export interface PortalSessionListResponse {
  sessions: PortalSessionListItem[];
  nextCursor: string | null;
}

export interface PortalSessionDetail {
  sessionId: string;
  supportCode: string | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  appVersion: string | null;
  releaseChannel: string | null;
  userAnonId: string | null;
  client: unknown | null;
  eventCount: number;
  replayChunkCount: number | null;
}

export interface PortalSessionEvent {
  eventId: string;
  type: string;
  capturedAt: string;
  attributes: Record<string, unknown> | null;
  /**
   * Canonical-taxonomy fields (persisted by migration 002, projected by the
   * portal query). Optional so older ingest builds that don't surface them
   * still parse. Auto-captured events (rage/dead clicks, JS/API/resource
   * errors, perf) carry `severity` + `durationMs`/`httpStatus`; legacy events
   * leave them null.
   */
  schemaVersion?: number | null;
  context?: Record<string, unknown> | null;
  severity?: "info" | "warn" | "error" | null;
  durationMs?: number | null;
  httpStatus?: number | null;
}

export interface PortalSessionDetailResponse {
  session: PortalSessionDetail;
  events: PortalSessionEvent[];
  eventsNextCursor: string | null;
}

/**
 * Shape returned by the `by-support-code` lookup endpoint. A trimmed session
 * summary — enough to route the operator to the session-detail page.
 */
export interface PortalSupportCodeLookupSession {
  sessionId: string;
  supportCode: string | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  appVersion: string | null;
  releaseChannel: string | null;
  userAnonId: string | null;
  eventCount: number;
}

/**
 * Result of a support-code lookup. The ingest endpoint distinguishes a
 * malformed code (400) from an unknown-but-well-formed code (404); we surface
 * both so the UI can show the right message.
 */
export type SupportCodeLookupResult =
  | { status: "ok"; session: PortalSupportCodeLookupSession }
  | { status: "invalid" }
  | { status: "notFound" };

export interface IngestApiClient {
  readonly baseUrl: string;
  listSessions(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<PortalSessionListResponse>;
  getSession(id: string): Promise<PortalSessionDetailResponse | null>;
  lookupBySupportCode(code: string): Promise<SupportCodeLookupResult>;
}

export class IngestApiError extends Error {
  readonly status: number;
  readonly baseUrl: string;
  constructor(message: string, status: number, baseUrl: string) {
    super(message);
    this.name = "IngestApiError";
    this.status = status;
    this.baseUrl = baseUrl;
  }
}

const DEFAULT_INGEST_URL = "http://resolvetrace:4317";

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function createIngestApiClient(
  env: NodeJS.ProcessEnv = process.env
): IngestApiClient {
  const baseUrl = trimTrailingSlash(env.RT_INGEST_URL ?? DEFAULT_INGEST_URL);
  const token = env.RT_PORTAL_API_TOKEN ?? "";

  async function request<T>(path: string): Promise<T | { __notFound: true }> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch (cause) {
      throw new IngestApiError(
        `network error contacting ingest API at ${baseUrl}`,
        0,
        baseUrl
      );
    }
    if (response.status === 404) {
      return { __notFound: true };
    }
    if (!response.ok) {
      throw new IngestApiError(
        `ingest API responded ${response.status} for ${path}`,
        response.status,
        baseUrl
      );
    }
    return (await response.json()) as T;
  }

  return {
    baseUrl,
    async listSessions(opts = {}) {
      const params = new URLSearchParams();
      params.set("limit", String(opts.limit ?? 50));
      if (opts.cursor) params.set("cursor", opts.cursor);
      const result = await request<PortalSessionListResponse>(
        `/api/v1/portal/sessions?${params.toString()}`
      );
      if ("__notFound" in result) {
        // Listing the collection should never 404; treat as server error.
        throw new IngestApiError(
          `ingest API responded 404 for /api/v1/portal/sessions`,
          404,
          baseUrl
        );
      }
      return result;
    },
    async getSession(id) {
      const encoded = encodeURIComponent(id);
      const result = await request<PortalSessionDetailResponse>(
        `/api/v1/portal/sessions/${encoded}`
      );
      if ("__notFound" in result) {
        return null;
      }
      return result;
    },
    async lookupBySupportCode(code) {
      // The ingest endpoint normalizes leniently (case, dashes/spaces,
      // I/L->1, O->0) and validates server-side; we pass the raw code
      // through so a single normalization rule lives on the server.
      const encoded = encodeURIComponent(code);
      const path = `/api/v1/portal/sessions/by-support-code/${encoded}`;
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: "GET",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
      } catch {
        throw new IngestApiError(
          `network error contacting ingest API at ${baseUrl}`,
          0,
          baseUrl
        );
      }
      if (response.status === 400) return { status: "invalid" };
      if (response.status === 404) return { status: "notFound" };
      if (!response.ok) {
        throw new IngestApiError(
          `ingest API responded ${response.status} for ${path}`,
          response.status,
          baseUrl
        );
      }
      const body = (await response.json()) as {
        session: PortalSupportCodeLookupSession;
      };
      return { status: "ok", session: body.session };
    },
  };
}
