import Link from "next/link";
import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalSessionListResponse,
} from "@/lib/ingest-api";
import { formatRelative } from "@/lib/format";

type LoadResult =
  | { status: "ok"; data: PortalSessionListResponse }
  | { status: "error"; baseUrl: string };

async function loadSessions(): Promise<LoadResult> {
  const client = createIngestApiClient();
  try {
    const data = await client.listSessions({ limit: 50 });
    return { status: "ok", data };
  } catch (err) {
    if (err instanceof IngestApiError) {
      return { status: "error", baseUrl: err.baseUrl };
    }
    return { status: "error", baseUrl: client.baseUrl };
  }
}

export default async function SessionsPage() {
  const result = await loadSessions();

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="text-sm text-neutral-600">
            Recorded browser sessions captured by the ResolveTrace SDK.
          </p>
        </header>

        {result.status === "error" ? (
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
        ) : result.data.sessions.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-sm text-neutral-600">
              No sessions captured yet. Install the SDK in your app and send
              some traffic to see recordings here.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Session</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2 font-medium">Ended</th>
                  <th className="px-4 py-2 font-medium">Events</th>
                  <th className="px-4 py-2 font-medium">App version</th>
                </tr>
              </thead>
              <tbody>
                {result.data.sessions.map((s) => (
                  <tr
                    key={s.sessionId}
                    className="border-t border-neutral-100 hover:bg-neutral-50"
                  >
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link
                        href={`/sessions/${encodeURIComponent(s.sessionId)}`}
                        className="text-blue-600 hover:underline"
                      >
                        {s.sessionId}
                      </Link>
                    </td>
                    <td
                      className="px-4 py-2 text-neutral-700"
                      title={s.startedAt}
                    >
                      {formatRelative(s.startedAt)}
                    </td>
                    <td
                      className="px-4 py-2 text-neutral-700"
                      title={s.endedAt ?? undefined}
                    >
                      {s.endedAt ? formatRelative(s.endedAt) : "—"}
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {s.eventCount}
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {s.appVersion ?? "—"}
                      {s.releaseChannel ? (
                        <span className="ml-1 text-neutral-400">
                          ({s.releaseChannel})
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </Shell>
  );
}
