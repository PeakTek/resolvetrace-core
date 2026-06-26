import Link from "next/link";
import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalReport,
} from "@/lib/ingest-api";
import { formatRelative, formatSupportCode } from "@/lib/format";

/**
 * Cross-session problem-reports surface (Wave-25). Problem reports are
 * `support.report_submitted` events; this page collects them across recent
 * sessions and lists the description, support code, source (widget/api), time
 * and a link to the owning session detail (where the event also renders on the
 * timeline). Admin-gated (the underlying reads require the audit scope).
 *
 * Privacy: the description is the user's own free text and everything else was
 * scrubbed by the SDK before emission; we render only that scrubbed projection.
 */

type LoadResult =
  | { status: "ok"; data: PortalReport[] }
  | { status: "forbidden" }
  | { status: "error"; baseUrl: string };

async function loadReports(): Promise<LoadResult> {
  const client = createIngestApiClient();
  try {
    const result = await client.listReports();
    if (result.status === "forbidden") return { status: "forbidden" };
    if (result.status !== "ok") {
      return { status: "error", baseUrl: client.baseUrl };
    }
    return { status: "ok", data: result.data };
  } catch (err) {
    if (err instanceof IngestApiError) {
      return { status: "error", baseUrl: err.baseUrl };
    }
    return { status: "error", baseUrl: client.baseUrl };
  }
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <span className="text-neutral-400">—</span>;
  const tone =
    source === "widget"
      ? "bg-sky-50 text-sky-700 ring-sky-600/20"
      : source === "api"
        ? "bg-violet-50 text-violet-700 ring-violet-600/20"
        : "bg-neutral-100 text-neutral-600 ring-neutral-300/50";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {source}
    </span>
  );
}

export default async function ReportsPage() {
  const result = await loadReports();

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Problem reports</h1>
          <p className="text-sm text-neutral-600">
            Reports submitted by users from the in-app reporting widget or the{" "}
            <span className="font-mono">reportProblem()</span> API, across recent
            sessions.
          </p>
        </header>

        {result.status === "forbidden" ? (
          <Card className="p-10 text-center">
            <p className="text-sm font-medium text-neutral-900">
              Not authorized
            </p>
            <p className="mt-2 text-sm text-neutral-600">
              Viewing problem reports requires admin privileges. Your account
              does not have the <span className="font-mono">audit:read</span>{" "}
              scope.
            </p>
          </Card>
        ) : result.status === "error" ? (
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
        ) : result.data.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-sm text-neutral-600">
              No problem reports yet. Reports appear here when a user submits one
              from the in-app widget or via{" "}
              <span className="font-mono">client.reportProblem()</span>.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium">Support code</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Submitted</th>
                  <th className="px-4 py-2 font-medium">Session</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((r) => (
                  <tr
                    key={r.eventId}
                    className="border-t border-neutral-100 align-top hover:bg-neutral-50"
                  >
                    <td className="max-w-md px-4 py-2 text-neutral-900">
                      {r.description ? (
                        <span className="break-words">{r.description}</span>
                      ) : (
                        <span className="text-neutral-400">
                          (no description)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-neutral-700">
                      {r.supportCode
                        ? formatSupportCode(r.supportCode)
                        : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <SourceBadge source={r.source} />
                    </td>
                    <td
                      className="whitespace-nowrap px-4 py-2 text-neutral-700"
                      title={r.capturedAt}
                    >
                      {formatRelative(r.capturedAt)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link
                        href={`/sessions/${encodeURIComponent(r.sessionId)}`}
                        className="text-blue-600 hover:underline"
                      >
                        View session
                      </Link>
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
