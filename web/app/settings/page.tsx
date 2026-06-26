import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { RetentionForm } from "@/components/retention-form";
import { PurgeButton } from "@/components/purge-button";
import { WebhookForm } from "@/components/webhook-form";
import {
  createIngestApiClient,
  IngestApiError,
  type PortalRetentionSettings,
  type PortalWebhookSettings,
} from "@/lib/ingest-api";

type LoadResult =
  | { status: "ok"; data: PortalRetentionSettings }
  | { status: "forbidden" }
  | { status: "error"; baseUrl: string };

type WebhookLoadResult =
  | { status: "ok"; data: PortalWebhookSettings }
  | { status: "forbidden" }
  | { status: "error" };

async function loadSettings(): Promise<LoadResult> {
  const client = createIngestApiClient();
  try {
    const result = await client.getRetentionSettings();
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

async function loadWebhook(): Promise<WebhookLoadResult> {
  const client = createIngestApiClient();
  try {
    const result = await client.getWebhookSettings();
    if (result.status === "forbidden") return { status: "forbidden" };
    if (result.status !== "ok") return { status: "error" };
    return { status: "ok", data: result.data };
  } catch {
    return { status: "error" };
  }
}

function forever(days: number): string {
  return days === 0 ? "forever" : `${days} day${days === 1 ? "" : "s"}`;
}

export default async function SettingsPage() {
  const [result, webhook] = await Promise.all([loadSettings(), loadWebhook()]);

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-neutral-600">
            Data retention windows and the scheduled purge for this deployment.
          </p>
        </header>

        {result.status === "forbidden" ? (
          <Card className="p-10 text-center">
            <p className="text-sm font-medium text-neutral-900">
              Not authorized
            </p>
            <p className="mt-2 text-sm text-neutral-600">
              Viewing and changing retention settings requires admin
              privileges. Your account does not have the{" "}
              <span className="font-mono">audit:read</span> scope.
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
        ) : (
          <>
            <Card className="space-y-4 p-6">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Retention windows
                </h2>
                <p className="text-sm text-neutral-600">
                  How long each kind of data is kept before it is eligible for
                  purge. Defaults: events {forever(result.data.defaults.eventsDays)},
                  sessions {forever(result.data.defaults.sessionsDays)}, replay{" "}
                  {forever(result.data.defaults.replayDays)}.
                </p>
              </div>
              {result.data.editable ? (
                <RetentionForm settings={result.data} />
              ) : (
                <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-neutral-500">
                      Events
                    </dt>
                    <dd className="text-neutral-900">
                      {forever(result.data.retention.eventsDays)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-neutral-500">
                      Sessions
                    </dt>
                    <dd className="text-neutral-900">
                      {forever(result.data.retention.sessionsDays)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-neutral-500">
                      Replay
                    </dt>
                    <dd className="text-neutral-900">
                      {forever(result.data.retention.replayDays)}
                    </dd>
                  </div>
                </dl>
              )}
            </Card>

            <Card className="space-y-4 p-6">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Scheduled purge
                </h2>
                <p className="text-sm text-neutral-600">
                  Configured via environment; shown here for reference.
                </p>
              </div>
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">
                    Status
                  </dt>
                  <dd className="text-neutral-900">
                    {result.data.purge.enabled ? "Enabled" : "Disabled"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">
                    Interval
                  </dt>
                  <dd className="text-neutral-900">
                    every {result.data.purge.intervalHours} hour
                    {result.data.purge.intervalHours === 1 ? "" : "s"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">
                    Batch size
                  </dt>
                  <dd className="text-neutral-900">
                    {result.data.purge.batchSize}
                  </dd>
                </div>
              </dl>
              <div className="border-t border-neutral-100 pt-4">
                <PurgeButton />
              </div>
            </Card>

            <Card className="space-y-4 p-6">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Report webhook
                </h2>
                <p className="text-sm text-neutral-600">
                  Submitted problem reports are forwarded server-side to this
                  webhook (HMAC-signed). The signing secret is stored
                  server-side and never shown.
                </p>
              </div>
              {webhook.status === "ok" ? (
                <WebhookForm settings={webhook.data} />
              ) : webhook.status === "forbidden" ? (
                <p className="text-sm text-neutral-600">
                  Configuring the report webhook requires admin privileges.
                </p>
              ) : (
                <p className="text-sm text-neutral-600">
                  Could not load webhook settings. Check the portal&rsquo;s
                  connection to the ingest API.
                </p>
              )}
            </Card>
          </>
        )}
      </div>
    </Shell>
  );
}
