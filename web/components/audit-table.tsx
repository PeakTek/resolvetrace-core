"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import type { PortalAuditEntry } from "@/lib/ingest-api";

/**
 * Human-friendly labels for the canonical audit actions. Unknown actions fall
 * back to the raw string so new server-side actions still render legibly.
 */
const ACTION_LABELS: Record<string, string> = {
  "session.view": "Viewed session",
  "support_code.lookup": "Looked up support code",
  "auth.login": "Signed in",
  "auth.login_failed": "Sign-in failed",
  "settings.update": "Updated settings",
  "session.delete": "Deleted session",
  "retention.purge": "Ran retention purge",
  "replay.access": "Accessed replay",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function MetadataCell({ metadata }: { metadata: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  if (!metadata || Object.keys(metadata).length === 0) {
    return <span className="text-neutral-400">—</span>;
  }
  const json = JSON.stringify(metadata);
  const compact = json.length <= 48 ? json : `${json.slice(0, 45)}…`;
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="max-w-xs text-left font-mono text-xs text-neutral-700 hover:text-neutral-900"
      title={open ? "Click to collapse" : "Click to expand"}
    >
      {open ? (
        <pre className="whitespace-pre-wrap break-all">
          {JSON.stringify(metadata, null, 2)}
        </pre>
      ) : (
        <span className="break-all">{compact}</span>
      )}
    </button>
  );
}

function Target({ entry }: { entry: PortalAuditEntry }) {
  if (!entry.targetType && !entry.targetId) {
    return <span className="text-neutral-400">—</span>;
  }
  return (
    <span className="font-mono text-xs text-neutral-700">
      {entry.targetType ? (
        <span className="text-neutral-500">{entry.targetType}:</span>
      ) : null}
      {entry.targetId ? <span> {entry.targetId}</span> : null}
    </span>
  );
}

export function AuditTable({
  initialEntries,
  initialCursor,
}: {
  initialEntries: PortalAuditEntry[];
  initialCursor: string | null;
}) {
  const [entries, setEntries] = useState<PortalAuditEntry[]>(initialEntries);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cursor });
      const res = await fetch(`/api/audit?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Your account is not authorized to read the audit log."
            : "Could not load more entries. Try again."
        );
        return;
      }
      const body = (await res.json()) as {
        entries: PortalAuditEntry[];
        nextCursor: string | null;
      };
      setEntries((prev) => [...prev, ...body.entries]);
      setCursor(body.nextCursor);
    } catch {
      setError("Could not load more entries. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr
                key={`${e.occurredAt}-${i}`}
                className="border-t border-neutral-100 align-top hover:bg-neutral-50"
              >
                <td
                  className="whitespace-nowrap px-4 py-2 text-neutral-700"
                  title={e.occurredAt}
                >
                  {formatRelative(e.occurredAt)}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-neutral-700">
                  {e.actor}
                </td>
                <td className="px-4 py-2 text-neutral-900">
                  {actionLabel(e.action)}
                  <span className="ml-1 font-mono text-xs text-neutral-400">
                    ({e.action})
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Target entry={e} />
                </td>
                <td className="px-4 py-2">
                  <MetadataCell metadata={e.metadata} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : (
        <p className="text-center text-xs text-neutral-400">
          End of audit log.
        </p>
      )}
    </div>
  );
}
