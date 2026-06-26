import { PlayCircle } from "lucide-react";

/**
 * "Has replay" indicator (Wave-24). Surfaced on the sessions list and
 * session-detail off `sessions.replay_chunk_count` — a session with one or more
 * captured (masked) replay chunks shows this badge. Purely presentational; the
 * replay itself is admin-gated behind the read-side.
 */
export function ReplayBadge({
  chunkCount,
  compact,
}: {
  chunkCount: number;
  /** List-view variant: icon + short label, no chunk count. */
  compact?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20"
      title={
        compact
          ? "This session has a masked replay recording"
          : `${chunkCount} replay chunk${chunkCount === 1 ? "" : "s"} captured (masked)`
      }
    >
      <PlayCircle className="h-3 w-3" aria-hidden />
      {compact ? "Replay" : `Replay · ${chunkCount}`}
    </span>
  );
}
