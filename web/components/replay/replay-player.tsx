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
import type { ReplaySegment } from "@/lib/replay-segments";

/**
 * Session replay player (Wave-24).
 *
 * Loads per-recording replay segments from the server-side proxy
 * (`/api/sessions/:id/replay`) — the proxy holds the ingest token AND downloads
 * the signed chunk URLs server-side, so neither the token nor the internal
 * storage host ever reaches the browser. We only ever receive the SDK's
 * already-masked events.
 *
 * A session can hold several disjoint capture spans (manual replay: the app
 * calls `replay.start()`/`stop()` more than once). The proxy splits those into
 * separate segments; we render a recording switcher and play one segment at a
 * time, each with its own timeline — so the idle time *between* recordings is
 * never shown as dead air on the scrubber.
 *
 * The actual rrweb-player embed lives in `RrwebMount`, loaded via
 * `next/dynamic({ ssr: false })`.
 *
 * Exposes an imperative `seekToTime(epochMs)` so the session timeline can drive
 * jump-to-time: we pick the segment whose capture window contains the target,
 * switch to it if needed, then seek within it.
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
  | { status: "ready"; segments: ReplaySegment[] };

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Index of the segment whose capture window contains `epochMs`, else the last
 * segment that starts at or before it (timeline events fall between/after
 * recordings), else 0. */
function segmentForTime(segments: ReplaySegment[], epochMs: number): number {
  for (const seg of segments) {
    if (epochMs >= seg.startedAt && epochMs <= seg.endedAt) return seg.index;
  }
  let best = 0;
  for (const seg of segments) {
    if (seg.startedAt <= epochMs) best = seg.index;
  }
  return best;
}

export const ReplayPlayer = forwardRef<
  ReplayPlayerHandle,
  { sessionId: string }
>(function ReplayPlayer({ sessionId }, ref) {
  const instanceRef = useRef<RrwebInstance | null>(null);
  const startTimeRef = useRef<number>(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  // A seek requested while the target segment isn't the mounted one — applied
  // once the new segment's player reports ready.
  const pendingSeekRef = useRef<number | null>(null);
  // Bumping this re-runs the loader (used by the "Reload" action after an
  // expired-URL / transient error).
  const [reloadKey, setReloadKey] = useState(0);

  // Mirror the pieces the imperative handle needs into refs so `seekToTime`
  // always sees current values regardless of when the timeline calls it.
  const segmentsRef = useRef<ReplaySegment[]>([]);
  segmentsRef.current = state.status === "ready" ? state.segments : [];
  const selectedRef = useRef(0);
  selectedRef.current = selected;

  useImperativeHandle(ref, () => ({
    seekToTime(epochMs: number) {
      const segments = segmentsRef.current;
      if (segments.length === 0) return;
      const target = segmentForTime(segments, epochMs);
      if (target !== selectedRef.current) {
        // Switch segments first; the seek lands after the new player mounts.
        pendingSeekRef.current = epochMs;
        instanceRef.current = null;
        setSelected(target);
        return;
      }
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

      // Fetch the per-recording segments through the server-side proxy. 204 =
      // the session has no playable replay; 403/404 are surfaced distinctly.
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

      let payload: { segments?: ReplaySegment[] };
      try {
        payload = await res.json();
      } catch {
        if (!cancelled) setState({ status: "error" });
        return;
      }
      if (cancelled) return;
      const segments = Array.isArray(payload.segments) ? payload.segments : [];
      if (segments.length === 0) return setState({ status: "empty" });
      setSelected(0);
      pendingSeekRef.current = null;
      setState({ status: "ready", segments });
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
    // Apply a seek that was requested before this segment mounted.
    if (pendingSeekRef.current !== null) {
      const target = pendingSeekRef.current;
      pendingSeekRef.current = null;
      const offset = Math.max(0, target - startTimeRef.current);
      inst.goto(offset, false);
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

  // ready
  const segments = state.segments;
  const active = segments[Math.min(selected, segments.length - 1)];

  return (
    <div className="space-y-3">
      {segments.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-neutral-500">
            {segments.length} recordings:
          </span>
          {segments.map((seg) => {
            const isActive = seg.index === active.index;
            return (
              <button
                key={seg.index}
                type="button"
                onClick={() => {
                  pendingSeekRef.current = null;
                  instanceRef.current = null;
                  setSelected(seg.index);
                }}
                aria-pressed={isActive}
                className={
                  "rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors " +
                  (isActive
                    ? "bg-neutral-900 text-white"
                    : "border border-neutral-300 text-neutral-600 hover:bg-neutral-50")
                }
              >
                Recording {seg.index + 1}
                <span
                  className={
                    "ml-1.5 " +
                    (isActive ? "text-neutral-300" : "text-neutral-400")
                  }
                >
                  {formatDuration(seg.durationMs)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <RrwebMount
        key={`${sessionId}:${reloadKey}:${active.index}`}
        events={active.events}
        onReady={handleReady}
      />
    </div>
  );
});
