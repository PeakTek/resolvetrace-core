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
  /**
   * Number of captured (masked) replay chunks. Wave-24: drives the "has replay"
   * indicator on the list. Optional so older ingest builds that don't project
   * it still parse (treated as no replay).
   */
  replayChunkCount?: number | null;
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

/**
 * One row of the admin audit log. Mirrors A1's `GET /api/v1/portal/audit`
 * projection. `metadata` is a free-form, PII-free object (e.g. `{result:"hit"}`
 * for a lookup, `{retention:{eventsDays:30}}` for a settings change).
 */
export interface PortalAuditEntry {
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  occurredAt: string;
  metadata: Record<string, unknown> | null;
}

export interface PortalAuditPage {
  entries: PortalAuditEntry[];
  nextCursor: string | null;
}

/** Effective retention windows in days. `0` means "keep forever". */
export interface PortalRetentionWindows {
  eventsDays: number;
  sessionsDays: number;
  replayDays: number;
}

/** Whether a window's effective value comes from a persisted override or env. */
export type PortalRetentionSource = "override" | "env";

export interface PortalRetentionSettings {
  retention: PortalRetentionWindows;
  defaults: PortalRetentionWindows;
  editable: boolean;
  source: Record<keyof PortalRetentionWindows, PortalRetentionSource>;
  purge: {
    enabled: boolean;
    intervalHours: number;
    batchSize: number;
  };
}

export interface PortalRetentionUpdateResult {
  retention: PortalRetentionWindows;
  updated: Partial<PortalRetentionWindows>;
}

export interface PortalPurgeResult {
  events: number;
  sessions: number;
  replayObjects: number;
}

export interface PortalSessionDeleteResult {
  sessionId: string;
  eventsDeleted: number;
  replayObjects: number;
}

/**
 * One chunk in a session's replay manifest as returned by A2's read-side
 * (`GET /api/v1/portal/sessions/:sessionId/replay`). `url` is a short-lived
 * signed GET URL for the masked rrweb chunk bytes; it expires (~300s), so the
 * portal re-fetches the listing rather than caching an expired URL. `scrubber`
 * is the masking-config digest recorded at capture time (audit parity), never
 * raw data.
 */
export interface PortalReplayChunk {
  sequence: number;
  bytes: number;
  sha256: string;
  scrubber: unknown | null;
  uploadedAt: string;
  clientUploadedAt: string | null;
  url: string;
  urlExpiresAt: string;
}

export interface PortalReplayManifest {
  sessionId: string;
  chunkCount: number;
  urlTtlSeconds: number;
  /** Sorted by sequence (ascending) by the read-side. */
  chunks: PortalReplayChunk[];
}

/**
 * Outcome wrapper for the admin-gated governance calls. The ingest server
 * returns 403 when the portal token lacks the `audit:read` scope (a viewer
 * deployment); we surface that distinctly so pages can render a not-authorized
 * state rather than a generic error. `notFound` is only meaningful for delete.
 */
export type AdminResult<T> =
  | { status: "ok"; data: T }
  | { status: "forbidden" }
  | { status: "notFound" }
  | { status: "invalid"; message: string };

export interface IngestApiClient {
  readonly baseUrl: string;
  listSessions(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<PortalSessionListResponse>;
  getSession(id: string): Promise<PortalSessionDetailResponse | null>;
  lookupBySupportCode(code: string): Promise<SupportCodeLookupResult>;
  /** Admin-only: read the audit log (403 for viewers). */
  listAudit(opts?: {
    limit?: number;
    cursor?: string;
  }): Promise<AdminResult<PortalAuditPage>>;
  /**
   * Admin-only: read a session's replay manifest with fresh signed chunk URLs
   * (403 for viewers, 404 unknown session). Each call is audited server-side
   * (`replay.access`). Re-call to refresh expired URLs rather than caching.
   */
  getReplayManifest(
    sessionId: string
  ): Promise<AdminResult<PortalReplayManifest>>;
  /** Admin-only: read effective retention settings (403 for viewers). */
  getRetentionSettings(): Promise<AdminResult<PortalRetentionSettings>>;
  /** Admin-only: update retention windows (403 viewer, 400 invalid). */
  updateRetentionSettings(
    body: Partial<PortalRetentionWindows>
  ): Promise<AdminResult<PortalRetentionUpdateResult>>;
  /** Admin-only: run an on-demand purge (403 for viewers). */
  runPurge(): Promise<AdminResult<PortalPurgeResult>>;
  /** Admin-only: delete a session and its events/replay (403 viewer, 404 unknown). */
  deleteSession(id: string): Promise<AdminResult<PortalSessionDeleteResult>>;
  /**
   * Whether this deployment's portal token carries the admin scope. Used to
   * decide whether to render admin-only controls (e.g. delete-session) — the
   * server still enforces the scope on every mutation regardless. Probes a
   * cheap read-only admin endpoint; on a transport error we fail closed
   * (return false) so the control is hidden rather than shown-then-403.
   */
  isAdmin(): Promise<boolean>;
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

  /**
   * Issue an authenticated request and classify the result for the admin-gated
   * governance surfaces. Maps the upstream status into an `AdminResult` so the
   * portal can distinguish a viewer (403) from a missing target (404) from a
   * validation error (400) without each caller re-parsing status codes.
   */
  async function adminRequest<T>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<AdminResult<T>> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new IngestApiError(
        `network error contacting ingest API at ${baseUrl}`,
        0,
        baseUrl
      );
    }
    if (response.status === 403) return { status: "forbidden" };
    if (response.status === 404) return { status: "notFound" };
    if (response.status === 400) {
      let message = "Invalid request.";
      try {
        const err = (await response.json()) as { message?: unknown };
        if (typeof err.message === "string") message = err.message;
      } catch {
        // keep default message
      }
      return { status: "invalid", message };
    }
    if (!response.ok) {
      throw new IngestApiError(
        `ingest API responded ${response.status} for ${path}`,
        response.status,
        baseUrl
      );
    }
    return { status: "ok", data: (await response.json()) as T };
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
    async listAudit(opts = {}) {
      const params = new URLSearchParams();
      params.set("limit", String(opts.limit ?? 50));
      if (opts.cursor) params.set("cursor", opts.cursor);
      return adminRequest<PortalAuditPage>(
        "GET",
        `/api/v1/portal/audit?${params.toString()}`
      );
    },
    async getReplayManifest(sessionId) {
      const encoded = encodeURIComponent(sessionId);
      return adminRequest<PortalReplayManifest>(
        "GET",
        `/api/v1/portal/sessions/${encoded}/replay`
      );
    },
    async getRetentionSettings() {
      return adminRequest<PortalRetentionSettings>(
        "GET",
        `/api/v1/portal/settings/retention`
      );
    },
    async updateRetentionSettings(body) {
      return adminRequest<PortalRetentionUpdateResult>(
        "PUT",
        `/api/v1/portal/settings/retention`,
        body
      );
    },
    async runPurge() {
      const result = await adminRequest<{ purged: PortalPurgeResult }>(
        "POST",
        `/api/v1/portal/retention/purge`
      );
      if (result.status !== "ok") return result;
      return { status: "ok", data: result.data.purged };
    },
    async deleteSession(id) {
      const encoded = encodeURIComponent(id);
      const result = await adminRequest<{ deleted: PortalSessionDeleteResult }>(
        "DELETE",
        `/api/v1/portal/sessions/${encoded}`
      );
      if (result.status !== "ok") return result;
      return { status: "ok", data: result.data.deleted };
    },
    async isAdmin() {
      try {
        const result = await adminRequest<unknown>(
          "GET",
          `/api/v1/portal/settings/retention`
        );
        return result.status === "ok";
      } catch {
        return false;
      }
    },
  };
}
