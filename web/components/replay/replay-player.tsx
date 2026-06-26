"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import type { RrwebInstance } from "./rrweb-mount";

/**
 * Session replay player (Wave-24).
 *
 * Loads the stitched (multi-chunk, sequence-ordered) rrweb event array from the
 * server-side proxy (`/api/sessions/:id/replay`) — the proxy holds the ingest
 * token AND downloads the signed chunk URLs server-side, so neither the token
 * nor the internal storage host ever reaches the browser. We only ever receive
 * the SDK's already-masked events.
 *
 * The actual rrweb-player embed lives in `RrwebMount`, loaded via
 * `next/dynamic({ ssr: false })`. rrweb-player is a Svelte component that
 * touches the DOM and ships its own CSS; loading it as a dedicated client-only
 * chunk keeps SSR clean and the Svelte runtime intact.
 *
 * Exposes an imperative `seekToTime(epochMs)` so the session timeline can drive
 * jump-to-time. We convert the absolute capture timestamp into a player-
 * relative offset using the replay's own start time (from getMetaData()).
 */

const RrwebMount = dynamic(() => import("./rrweb-mount"), {
  ssr: false,
  loading: () => (
    <div className="flex h-48 items-center justify-center text-sm text-neutral-500">
      Loading player…
    </div>
  ),
});

export interface ReplayPlayerHandle {
  /** Seek to an absolute wall-clock time (epoch ms). No-op until loaded. */
  seekToTime(epochMs: number): void;
  /** Whether the player is loaded and seekable. */
  isReady(): boolean;
}

type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "forbidden" }
  | { status: "notFound" }
  | { status: "error" }
  | { status: "ready"; events: unknown[] };

export const ReplayPlayer = forwardRef<
  ReplayPlayerHandle,
  { sessionId: string }
>(function ReplayPlayer({ sessionId }, ref) {
  const instanceRef = useRef<RrwebInstance | null>(null);
  const startTimeRef = useRef<number>(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Bumping this re-runs the loader (used by the "Reload" action after an
  // expired-URL / transient error).
  const [reloadKey, setReloadKey] = useState(0);

  useImperativeHandle(ref, () => ({
    seekToTime(epochMs: number) {
      const inst = instanceRef.current;
      if (!inst) return;
      const offset = Math.max(0, epochMs - startTimeRef.current);
      inst.goto(offset, false);
    },
    isReady() {
      return instanceRef.current !== null;
    },
  }));

  useEffect(() => {
    let cancelled = false;
    instanceRef.current = null;

    async function load() {
      setState({ status: "loading" });

      // Fetch the stitched events through the server-side proxy. 204 = the
      // session has no replay; 403/404 are surfaced distinctly.
      let res: Response;
      try {
        res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/replay`,
          { cache: "no-store" }
        );
      } catch {
        if (!cancelled) setState({ status: "error" });
        return;
      }
      if (cancelled) return;
      if (res.status === 204) return setState({ status: "empty" });
      if (res.status === 403) return setState({ status: "forbidden" });
      if (res.status === 404) return setState({ status: "notFound" });
      if (!res.ok) return setState({ status: "error" });

      let payload: { events?: unknown };
      try {
        payload = await res.json();
      } catch {
        if (!cancelled) setState({ status: "error" });
        return;
      }
      const events = Array.isArray(payload.events) ? payload.events : [];
      if (cancelled) return;
      // rrweb needs at least a meta + full-snapshot to play.
      if (events.length < 2) return setState({ status: "empty" });
      setState({ status: "ready", events });
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  function handleReady(inst: RrwebInstance) {
    instanceRef.current = inst;
    try {
      startTimeRef.current = inst.getMetaData().startTime;
    } catch {
      startTimeRef.current = 0;
    }
  }

  if (state.status === "loading") {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-neutral-500">
        Loading replay…
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="flex h-32 items-center justify-center px-6 text-center text-sm text-neutral-600">
        No replay was captured for this session.
      </div>
    );
  }

  if (state.status === "forbidden") {
    return (
      <div className="flex h-32 items-center justify-center px-6 text-center text-sm text-neutral-600">
        Your account is not authorized to view session replay.
      </div>
    );
  }

  if (state.status === "notFound") {
    return (
      <div className="flex h-32 items-center justify-center px-6 text-center text-sm text-neutral-600">
        This session no longer exists.
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-neutral-600">
        <span>
          Could not load the replay. Signed links may have expired — try
          reloading.
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Reload replay
        </button>
      </div>
    );
  }

  // ready: key forces a fresh mount (and thus a fresh rrweb instance) on reload.
  return (
    <RrwebMount
      key={`${sessionId}:${reloadKey}`}
      events={state.events}
      onReady={handleReady}
    />
  );
});
