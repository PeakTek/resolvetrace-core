import Link from "next/link";
import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { SessionTimeline } from "@/components/session-timeline";
import { ReplayPanel } from "@/components/replay/replay-panel";
import { ReplayBadge } from "@/components/replay/replay-badge";
import { SupportCodeBadge } from "@/components/support-code-badge";
import { DeleteSession } from "@/components/delete-session";
import {
  IngestApiError,
  type PortalSessionDetailResponse,
} from "@/lib/ingest-api";
import { portalIngestClient } from "@/lib/portal-client";
import { formatRelative } from "@/lib/format";
import { getSession } from "@/lib/session-cookie";
import { hasScope, SCOPE_TENANT_ADMIN } from "@/lib/scopes";

/**
 * The SDK caps auto-captured events per session (default 200). When the
 * returned event count is at/over that ceiling we surface a "capped" note on
 * the timeline. There is no first-class signal for this yet, so we infer it
 * from the count; this is intentionally conservative.
 */
const AUTO_CAPTURE_CAP = 200;

type LoadResult =
  | { status: "ok"; data: PortalSessionDetailResponse }
  | { status: "notFound" }
  | { status: "error"; baseUrl: string };

async function loadSession(id: string): Promise<LoadResult> {
  const client = await portalIngestClient();
  try {
    const data = await client.getSession(id);
    if (data === null) return { status: "notFound" };
    return { status: "ok", data };
  } catch (err) {
    if (err instanceof IngestApiError) {
      return { status: "error", baseUrl: err.baseUrl };
    }
    return { status: "error", baseUrl: client.baseUrl };
  }
}

function clientEntries(client: unknown): [string, unknown][] | null {
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    return null;
  }
  return Object.entries(client as Record<string, unknown>);
}

function formatClientValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await loadSession(id);
  // Render the destructive delete control only when the signed-in user's role
  // carries the tenant-admin scope. The server enforces the scope on the DELETE
  // itself regardless; this just hides the control from non-admin roles.
  const portalSession = await getSession();
  const canDelete =
    result.status === "ok" &&
    hasScope(portalSession?.scopes ?? [], SCOPE_TENANT_ADMIN);

  if (result.status === "error") {
    return (
      <Shell>
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold">Session</h1>
            <p className="font-mono text-sm text-neutral-600">{id}</p>
          </header>
          <Card className="p-6">
            <p className="text-sm text-neutral-900">
              Could not reach ingest API at{" "}
              <span className="font-mono">{result.baseUrl}</span>.
            </p>
            <p className="mt-2 text-sm text-neutral-600">
              Check the <span className="font-mono">RT_INGEST_URL</span> and{" "}
              <span className="font-mono">RT_PORTAL_API_TOKEN</span> environment
              variables on the portal container.
            </p>
          </Card>
        </div>
      </Shell>
    );
  }

  if (result.status === "notFound") {
    return (
      <Shell>
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold">Session not found</h1>
            <p className="font-mono text-sm text-neutral-600">{id}</p>
          </header>
          <Card className="p-6 text-center">
            <p className="text-sm text-neutral-600">
              No session with id{" "}
              <span className="font-mono">{id}</span> was found.
            </p>
            <p className="mt-3 text-sm">
              <Link
                href="/sessions"
                className="text-blue-600 hover:underline"
              >
                Back to all sessions
              </Link>
            </p>
          </Card>
        </div>
      </Shell>
    );
  }

  const { session, events } = result.data;
  const client = clientEntries(session.client);
  const hasReplay = (session.replayChunkCount ?? 0) > 0;

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Session</h1>
          <p className="font-mono text-sm text-neutral-600">
            {session.sessionId}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {session.supportCode ? (
              <SupportCodeBadge code={session.supportCode} />
            ) : null}
            {hasReplay ? (
              <ReplayBadge chunkCount={session.replayChunkCount ?? 0} />
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                Started
              </dt>
              <dd className="text-neutral-900" title={session.startedAt}>
                {formatRelative(session.startedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                Ended
              </dt>
              <dd
                className="text-neutral-900"
                title={session.endedAt ?? undefined}
              >
                {session.endedAt ? formatRelative(session.endedAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                App version
              </dt>
              <dd className="text-neutral-900">
                {session.appVersion ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">
                Release channel
              </dt>
              <dd className="text-neutral-900">
                {session.releaseChannel ?? "—"}
              </dd>
            </div>
          </dl>
        </header>

        {client ? (
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Client
            </h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2">
              {client.map(([key, value]) => (
                <div key={key} className="flex flex-col">
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">
                    {key}
                  </dt>
                  <dd className="break-words text-neutral-900">
                    {formatClientValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        ) : null}

        {hasReplay ? (
          <ReplayPanel
            sessionId={session.sessionId}
            events={events}
            eventCount={session.eventCount}
            capped={events.length >= AUTO_CAPTURE_CAP}
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="border-b border-neutral-100 px-4 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Timeline ({session.eventCount})
              </h2>
            </div>
            <SessionTimeline
              events={events}
              capped={events.length >= AUTO_CAPTURE_CAP}
            />
          </Card>
        )}

        {canDelete ? (
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Danger zone
            </h2>
            <p className="text-sm text-neutral-600">
              Permanently delete this session along with its events and replay
              artifacts. This action is recorded in the audit log.
            </p>
            <DeleteSession sessionId={session.sessionId} />
          </Card>
        ) : null}
      </div>
    </Shell>
  );
}
