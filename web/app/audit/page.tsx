import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { AuditTable } from "@/components/audit-table";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalAuditPage,
} from "@/lib/ingest-api";

type LoadResult =
  | { status: "ok"; data: PortalAuditPage }
  | { status: "forbidden" }
  | { status: "error"; baseUrl: string };

async function loadAudit(): Promise<LoadResult> {
  const client = createIngestApiClient();
  try {
    const result = await client.listAudit({ limit: 50 });
    if (result.status === "forbidden") return { status: "forbidden" };
    if (result.status !== "ok") {
      // invalid/notFound are not expected for an unparameterized first page.
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

export default async function AuditPage() {
  const result = await loadAudit();

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Audit log</h1>
          <p className="text-sm text-neutral-600">
            Administrative and access events recorded by this deployment,
            newest first.
          </p>
        </header>

        {result.status === "forbidden" ? (
          <Card className="p-10 text-center">
            <p className="text-sm font-medium text-neutral-900">
              Not authorized
            </p>
            <p className="mt-2 text-sm text-neutral-600">
              Reading the audit log requires admin privileges. Your account
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
        ) : result.data.entries.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-sm text-neutral-600">
              No audit entries yet. Events will appear here as users sign in,
              view sessions, and change settings.
            </p>
          </Card>
        ) : (
          <AuditTable
            initialEntries={result.data.entries}
            initialCursor={result.data.nextCursor}
          />
        )}
      </div>
    </Shell>
  );
}
