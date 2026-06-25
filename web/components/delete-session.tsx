"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type DeleteState =
  | { status: "idle" }
  | { status: "confirm" }
  | { status: "deleting" }
  | { status: "error"; message: string };

/**
 * Admin-only guarded session deletion. Only rendered when the deployment's
 * portal token carries the admin scope (the page checks server-side). On
 * confirm it calls the DELETE proxy; on success it routes to the sessions
 * list with a one-shot toast query param. 403/404 are surfaced inline.
 */
export function DeleteSession({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<DeleteState>({ status: "idle" });

  async function doDelete() {
    setState({ status: "deleting" });
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    } catch {
      setState({ status: "error", message: "Could not delete. Try again." });
      return;
    }
    if (res.status === 403) {
      setState({
        status: "error",
        message: "Your account is not authorized to delete sessions.",
      });
      return;
    }
    if (res.status === 404) {
      setState({
        status: "error",
        message: "This session no longer exists.",
      });
      return;
    }
    if (!res.ok) {
      setState({ status: "error", message: "Delete failed. Try again." });
      return;
    }
    // Route to the list with a toast flag; the list reads it and clears it.
    router.push("/sessions?deleted=1");
  }

  if (state.status === "confirm") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm sm:flex-row sm:items-center">
        <span className="text-red-800">
          Permanently delete this session and its events/replay? This cannot be
          undone.
        </span>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            className="bg-red-600 hover:bg-red-700"
            onClick={doDelete}
          >
            Delete permanently
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setState({ status: "idle" })}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        className="border-red-300 text-red-700 hover:bg-red-50"
        disabled={state.status === "deleting"}
        onClick={() => setState({ status: "confirm" })}
      >
        {state.status === "deleting" ? "Deleting…" : "Delete session"}
      </Button>
      {state.status === "error" ? (
        <span className="text-sm text-red-600">{state.message}</span>
      ) : null}
    </div>
  );
}
