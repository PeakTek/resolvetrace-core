/**
 * Split a stitched rrweb event stream into per-recording segments.
 *
 * A single session can hold multiple capture spans: with manual-mode replay the
 * host app calls `replay.start()` / `replay.stop()` more than once, so the
 * server accumulates chunks from several disjoint recordings under one
 * `sessionId`. Stitched naively (sequence order, one flat array) the player
 * derives its duration from `lastTimestamp - firstTimestamp`, so the idle time
 * *between* recordings shows up as dead air on the scrubber — a 1-minute + a
 * 1-minute recording taken 2 minutes apart reads as a 4-minute replay.
 *
 * rrweb starts every `record()` span by emitting a `Meta` event (type 4),
 * immediately followed by a `FullSnapshot` (type 2); it never re-emits `Meta`
 * mid-span (the SDK does not enable checkout snapshots). So a `Meta` event is a
 * reliable "a new recording begins here" marker. We cut a new segment at each
 * one; each segment is independently playable (`Meta` + `FullSnapshot` + its own
 * incremental events) with its own local timeline.
 */

/** rrweb `EventType.Meta` — the first event rrweb emits per `record()` span. */
const RRWEB_META = 4;

export interface ReplaySegment {
  /** 0-based index in playback order. */
  readonly index: number;
  /** Wall-clock epoch ms of the segment's first event. */
  readonly startedAt: number;
  /** Wall-clock epoch ms of the segment's last event. */
  readonly endedAt: number;
  /** `endedAt - startedAt` (>= 0). */
  readonly durationMs: number;
  /** Number of rrweb events in the segment. */
  readonly eventCount: number;
  /** The segment's rrweb events, ready to feed a Replayer. */
  readonly events: unknown[];
}

function eventType(ev: unknown): number | undefined {
  return typeof ev === "object" && ev !== null
    ? (ev as { type?: number }).type
    : undefined;
}

function eventTimestamp(ev: unknown): number | undefined {
  const t =
    typeof ev === "object" && ev !== null
      ? (ev as { timestamp?: number }).timestamp
      : undefined;
  return typeof t === "number" ? t : undefined;
}

/**
 * Partition a sequence-ordered rrweb event array into per-recording segments.
 * A new segment opens at each `Meta` event; any events before the first `Meta`
 * (defensive — shouldn't occur for SDK-produced streams) open a leading
 * segment. Segments with fewer than 2 events are dropped: rrweb needs at least a
 * `Meta` + `FullSnapshot` to play, so a lone straggler is not a real recording.
 */
export function segmentReplayEvents(events: unknown[]): ReplaySegment[] {
  const raw: unknown[][] = [];
  let current: unknown[] | null = null;

  for (const ev of events) {
    if (eventType(ev) === RRWEB_META || current === null) {
      current = [];
      raw.push(current);
    }
    current.push(ev);
  }

  const segments: ReplaySegment[] = [];
  for (const evs of raw) {
    if (evs.length < 2) continue; // not independently playable
    let startedAt = Number.POSITIVE_INFINITY;
    let endedAt = Number.NEGATIVE_INFINITY;
    for (const ev of evs) {
      const t = eventTimestamp(ev);
      if (t === undefined) continue;
      if (t < startedAt) startedAt = t;
      if (t > endedAt) endedAt = t;
    }
    if (!Number.isFinite(startedAt)) {
      startedAt = 0;
      endedAt = 0;
    }
    segments.push({
      index: segments.length,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      eventCount: evs.length,
      events: evs,
    });
  }

  return segments;
}
