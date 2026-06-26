"use client";

import { useRef } from "react";
import { Card } from "@/components/ui/card";
import { SessionTimeline } from "@/components/session-timeline";
import { ReplayPlayer, type ReplayPlayerHandle } from "./replay-player";
import type { PortalSessionEvent } from "@/lib/ingest-api";

/**
 * Session-detail replay panel (Wave-24). Renders the rrweb-player alongside the
 * Wave-21 timeline and wires the two together: clicking a timeline row seeks
 * the player to that event's capture time.
 *
 * Only rendered when the session has replay (`replay_chunk_count > 0`); the
 * read-side is admin-gated, so a viewer deployment gets the player's "not
 * authorized" state. Everything shown is the SDK's already-masked data.
 */
export function ReplayPanel({
  sessionId,
  events,
  eventCount,
  capped,
}: {
  sessionId: string;
  events: PortalSessionEvent[];
  eventCount: number;
  capped?: boolean;
}) {
  const playerRef = useRef<ReplayPlayerHandle | null>(null);

  function handleSeekTo(capturedAt: string) {
    const epochMs = Date.parse(capturedAt);
    if (Number.isNaN(epochMs)) return;
    playerRef.current?.seekToTime(epochMs);
  }

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Session replay
          </h2>
          <span className="inline-flex items-center rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 ring-1 ring-inset ring-violet-600/20">
            Masked
          </span>
        </div>
        <div className="p-4">
          <ReplayPlayer ref={playerRef} sessionId={sessionId} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="border-b border-neutral-100 px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Timeline ({eventCount})
          </h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            Click any event to jump the replay to that moment.
          </p>
        </div>
        <SessionTimeline
          events={events}
          capped={capped}
          onSeekTo={handleSeekTo}
        />
      </Card>
    </>
  );
}
