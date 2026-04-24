import Link from "next/link";
import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalSessionDetailResponse,
} from "@/lib/ingest-api";
import { formatRelative, truncate } from "@/lib/format";

type LoadResult =
  | { status: "ok"; data: PortalSessionDetailResponse }
  | { status: "notFound" }
  | { status: "error"; baseUrl: string };

async function loadSession(id: string): Promise<LoadResult> {
  const client = createIngestApiClient();
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

function previewAttributes(attrs: Record<string, unknown> | null): string {
  if (!attrs) return "—";
  try {
    return JSON.stringify(attrs);
  } catch {
    return "[unserializable]";
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

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Session</h1>
          <p className="font-mono text-sm text-neutral-600">
            {session.sessionId}
          </p>
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

        <Card className="overflow-hidden">
          <div className="border-b border-neutral-100 px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Events ({session.eventCount})
            </h2>
          </div>
          {events.length === 0 ? (
            <div className="p-6 text-center text-sm text-neutral-600">
              No events recorded for this session yet.
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Captured at</th>
                  <th className="px-4 py-2 font-medium">Attributes</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const fullPreview = previewAttributes(e.attributes);
                  return (
                    <tr
                      key={e.eventId}
                      className="border-t border-neutral-100 align-top"
                    >
                      <td className="px-4 py-2 font-mono text-xs">{e.type}</td>
                      <td
                        className="px-4 py-2 text-neutral-700"
                        title={e.capturedAt}
                      >
                        {formatRelative(e.capturedAt)}
                      </td>
                      <td
                        className="px-4 py-2 font-mono text-xs text-neutral-700"
                        title={fullPreview}
                      >
                        {truncate(fullPreview, 80)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </Shell>
  );
}
