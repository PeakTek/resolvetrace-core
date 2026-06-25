"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { PortalPurgeResult } from "@/lib/ingest-api";

type PurgeState =
  | { status: "idle" }
  | { status: "confirm" }
  | { status: "running" }
  | { status: "done"; result: PortalPurgeResult }
  | { status: "error"; message: string };

/**
 * Admin-only "Run purge now" control. Deletes any data already past its
 * retention window immediately, rather than waiting for the scheduled run.
 * Guarded by an inline confirm step since it is destructive.
 */
export function PurgeButton() {
  const router = useRouter();
  const [state, setState] = useState<PurgeState>({ status: "idle" });

  async function runPurge() {
    setState({ status: "running" });
    let res: Response;
    try {
      res = await fetch("/api/retention/purge", { method: "POST" });
    } catch {
      setState({ status: "error", message: "Could not run purge. Try again." });
      return;
    }
    if (res.status === 403) {
      setState({
        status: "error",
        message: "Your account is not authorized to run a purge.",
      });
      return;
    }
    if (!res.ok) {
      setState({ status: "error", message: "Purge failed. Try again." });
      return;
    }
    const body = (await res.json()) as { purged: PortalPurgeResult };
    setState({ status: "done", result: body.purged });
    // Surfaces the new retention.purge audit row + any count changes.
    router.refresh();
  }

  if (state.status === "confirm") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-neutral-700">
          Delete all data past its retention window now?
        </span>
        <Button variant="default" size="sm" onClick={runPurge}>
          Yes, run purge
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setState({ status: "idle" })}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={state.status === "running"}
        onClick={() => setState({ status: "confirm" })}
      >
        {state.status === "running" ? "Running…" : "Run purge now"}
      </Button>
      {state.status === "done" ? (
        <span className="text-sm text-green-700">
          Purged {state.result.events} events, {state.result.sessions}{" "}
          sessions, {state.result.replayObjects} replay objects.
        </span>
      ) : null}
      {state.status === "error" ? (
        <span className="text-sm text-red-600">{state.message}</span>
      ) : null}
    </div>
  );
}
