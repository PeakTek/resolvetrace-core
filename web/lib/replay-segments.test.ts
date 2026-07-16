import { describe, expect, it } from "vitest";
import { segmentReplayEvents } from "./replay-segments";

/** Minimal rrweb-shaped events. type 4 = Meta, 2 = FullSnapshot, 3 = Incremental. */
const meta = (ts: number) => ({ type: 4, data: { href: "/", width: 800, height: 600 }, timestamp: ts });
const full = (ts: number) => ({ type: 2, data: { node: {} }, timestamp: ts });
const inc = (ts: number) => ({ type: 3, data: { source: 2 }, timestamp: ts });

describe("segmentReplayEvents", () => {
  it("returns a single segment for one continuous recording", () => {
    const events = [meta(1000), full(1010), inc(1500), inc(2000)];
    const segs = segmentReplayEvents(events);
    expect(segs).toHaveLength(1);
    expect(segs[0].eventCount).toBe(4);
    expect(segs[0].startedAt).toBe(1000);
    expect(segs[0].endedAt).toBe(2000);
    expect(segs[0].durationMs).toBe(1000);
  });

  it("splits into one segment per recording span (each Meta opens a new one)", () => {
    // Span 1: t=0..60s. Span 2 recorded ~3 min later: t=180s..240s.
    const events = [
      meta(0),
      full(10),
      inc(30_000),
      inc(60_000),
      // ── user stopped, waited ~2 min, started again ──
      meta(180_000),
      full(180_010),
      inc(210_000),
      inc(240_000),
    ];
    const segs = segmentReplayEvents(events);
    expect(segs).toHaveLength(2);

    expect(segs[0].index).toBe(0);
    expect(segs[0].eventCount).toBe(4);
    expect(segs[0].durationMs).toBe(60_000);

    expect(segs[1].index).toBe(1);
    expect(segs[1].eventCount).toBe(4);
    expect(segs[1].startedAt).toBe(180_000);
    expect(segs[1].durationMs).toBe(60_000);

    // Crucially: neither segment's duration includes the ~2-min idle gap.
    const stitchedSpan = segs[1].endedAt - segs[0].startedAt; // 240s — the old dead-air duration
    expect(stitchedSpan).toBe(240_000);
    expect(segs[0].durationMs + segs[1].durationMs).toBe(120_000); // real recorded time
  });

  it("drops a straggler segment that is not independently playable (<2 events)", () => {
    // A lone leading event before the first Meta cannot play on its own.
    const events = [inc(5), meta(1000), full(1010), inc(1500)];
    const segs = segmentReplayEvents(events);
    expect(segs).toHaveLength(1);
    expect(segs[0].eventCount).toBe(3);
    expect(segs[0].startedAt).toBe(1000);
  });

  it("is defensive when the stream does not start with a Meta", () => {
    const events = [full(1000), inc(1200)];
    const segs = segmentReplayEvents(events);
    expect(segs).toHaveLength(1);
    expect(segs[0].eventCount).toBe(2);
  });

  it("returns no segments for an empty stream", () => {
    expect(segmentReplayEvents([])).toEqual([]);
  });
});
