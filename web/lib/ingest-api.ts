/**
 * Thin server-side wrapper around the ingest server's private portal query
 * endpoints. Used exclusively by Next.js server components — do not import
 * from client code.
 */

export interface PortalSessionListItem {
  sessionId: string;
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
}

export interface PortalSessionDetailResponse {
  session: PortalSessionDetail;
  events: PortalSessionEvent[];
  eventsNextCursor: string | null;
}

export interface IngestApiClient {
  readonly baseUrl: string;
  listSessions(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<PortalSessionListResponse>;
  getSession(id: string): Promise<PortalSessionDetailResponse | null>;
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
  };
}
