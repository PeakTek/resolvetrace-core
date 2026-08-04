import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { IngestApiError, type PortalUsage } from "@/lib/ingest-api";
import { portalIngestClient } from "@/lib/portal-client";

type LoadResult =
  | { status: "ok"; data: PortalUsage }
  | { status: "forbidden" }
  | { status: "error"; baseUrl: string };

async function loadUsage(): Promise<LoadResult> {
  const client = await portalIngestClient();
  try {
    const result = await client.getUsage();
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

/** Adaptive GB-month formatting (matches the operator console). */
function fmtGbMonth(gb: number): string {
  if (!(gb > 0)) return "0";
  if (gb >= 1) return gb.toFixed(2);
  if (gb >= 0.001) return gb.toFixed(4);
  return gb.toPrecision(2);
}

/** e.g. "August 2026" (UTC — the usage period is UTC calendar months). */
function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function UsagePage() {
  const result = await loadUsage();

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Usage</h1>
          <p className="text-sm text-neutral-600">
            Your replay usage for the current month.
          </p>
        </header>

        {result.status === "forbidden" ? (
          <Card className="p-10 text-center">
            <p className="text-sm font-medium text-neutral-900">Not authorized</p>
            <p className="mt-2 text-sm text-neutral-600">
              Viewing usage requires admin privileges. Your account does not have
              the <span className="font-mono">tenant:admin</span> scope.
            </p>
          </Card>
        ) : result.status === "error" ? (
          <Card className="p-6">
            <p className="text-sm text-neutral-900">
              Could not reach the API at{" "}
              <span className="font-mono">{result.baseUrl}</span>.
            </p>
          </Card>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-neutral-600">
              {monthLabel(result.data.periodStart)}
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Card className="p-6">
                <p className="text-sm text-neutral-600">Replay sessions</p>
                <p className="mt-1 text-3xl font-semibold">
                  {result.data.replaySessions.toLocaleString("en-US")}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Distinct sessions that recorded replay this month.
                </p>
              </Card>

              <Card className="p-6">
                <p className="text-sm text-neutral-600">Replay storage</p>
                <p className="mt-1 text-3xl font-semibold">
                  {fmtGbMonth(result.data.gbMonth)}{" "}
                  <span className="text-base font-normal text-neutral-500">
                    GB-month
                  </span>
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  Stored replay volume weighted by the retention window.
                </p>
              </Card>
            </div>

            {result.data.annotations && result.data.annotations.length > 0 ? (
              <Card className="p-6">
                <dl className="space-y-2">
                  {result.data.annotations.map((row, i) => (
                    <div
                      key={i}
                      className="flex justify-between text-sm"
                    >
                      <dt className="text-neutral-600">{row.label}</dt>
                      <dd className="font-medium text-neutral-900">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Card>
            ) : null}
          </div>
        )}
      </div>
    </Shell>
  );
}
